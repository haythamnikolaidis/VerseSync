"""Mock VerseSync sidecar (T-38).

Speaks the real sidecar HTTP + SSE contract (docs/07-sidecar-api.md) and the real process
lifecycle (docs/03-architecture.md §3), but serves the T-37 golden fixtures instead of running
a GPU pipeline. This is the panel's long-lived test double, not a throwaway prototype — see
tools/README.md for every flag and worked curl examples.

    python tools/mock_sidecar.py [--scenario happy|flagged|alternatives|empty] [--fail ...]
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty, Queue
from typing import Any, cast

JobEvent = tuple[str, dict[str, Any]]

SIDECAR_VERSION = "1.0.0"
REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "cue-documents"

SCENARIOS = {
    "happy": "happy-18-cues.json",
    "flagged": "flagged.json",
    "alternatives": "alternatives.json",
    "empty": "empty.json",
}

# (phase, weight) per docs/07-sidecar-api.md §4. transcribing is dropped and the rest
# renormalised on a cache hit, which is why a re-run visibly races through the bar.
PHASE_WEIGHTS = [
    ("hashing", 0.02),
    ("transcribing", 0.80),
    ("detecting", 0.05),
    ("resolving", 0.10),
    ("timing", 0.03),
]

PHASE_MESSAGES = {
    "hashing": "Hashing media file",
    "transcribing": "Transcribing audio",
    "detecting": "Detecting references",
    "resolving": "Fetching passage text",
    "timing": "Computing anchors and durations",
}

MODELS = [
    {
        "name": "distil-large-v3",
        "word_timestamp_quality": "good",
        "supported_quantizations": {"cuda": ["float16", "bfloat16", "float32"], "cpu": ["float32"]},
        "downloaded": True,
        "recommended": True,
    },
    {
        "name": "large-v3-turbo",
        "word_timestamp_quality": "good",
        "supported_quantizations": {"cuda": ["float16", "bfloat16", "float32"], "cpu": ["float32"]},
        "downloaded": True,
        "recommended": False,
    },
]

TRANSLATIONS = [
    {
        "id": "de4e12af7f28f599-02",
        "abbreviation": "KJV",
        "name": "King James Version",
        "attribution": "Public domain.",
        "cache_allowed": True,
    },
    {
        "id": "06125adad2d5898a-01",
        "abbreviation": "ESV",
        "name": "English Standard Version",
        "attribution": "Crossway. Used by permission. All rights reserved.",
        "cache_allowed": False,
    },
]

ERROR_EXAMPLES: dict[str, dict[str, Any]] = {
    "model_load_failed": {
        "code": "model_load_failed",
        "message": (
            "Could not load large-v3 on cuda: out of memory "
            "(9.1 GB free, ~10.4 GB required)."
        ),
        "detail": "CUDA error: CUBLAS_STATUS_ALLOC_FAILED",
        "retryable": True,
        "hint": "Try distil-large-v3 with float16, or switch to CPU.",
    },
}


def load_fixture(scenario: str) -> dict[str, Any]:
    path = FIXTURES_DIR / SCENARIOS[scenario]
    with path.open("r", encoding="utf-8") as f:
        data: dict[str, Any] = json.load(f)
    return data


def build_resolve_index() -> dict[tuple[str, int, int | None], dict[str, Any]]:
    """Index every cue (and alternative) across all four fixtures for POST /resolve.

    Keyed on (osis, chapter, verse). A cue with no verse (chapter_only) or no body
    (text_unavailable / passage_not_found) is skipped — there is nothing real to resolve.
    """
    index: dict[tuple[str, int, int | None], dict[str, Any]] = {}
    for name in SCENARIOS:
        doc = load_fixture(name)
        for cue in doc["cues"]:
            candidates = [cue] + cue.get("alternatives", [])
            for c in candidates:
                ref = c["reference"]
                if "verse" not in ref or not c.get("body"):
                    continue
                key = (ref["osis"], ref["chapter"], ref["verse"])
                index.setdefault(
                    key,
                    {
                        "reference": ref,
                        "reference_display": c["reference_display"],
                        "body": c["body"],
                    },
                )
    return index


BOOK_PATTERN = re.compile(
    r"^\s*(?P<book>[0-9]?\s*[A-Za-z][A-Za-z ]*?)\s+(?P<chapter>\d+)"
    r"(?::(?P<verse>\d+)(?:-(?P<verse_end>\d+))?)?\s*$"
)


def build_book_lookup(index: dict[tuple[str, int, int | None], dict[str, Any]]) -> dict[str, str]:
    """book name (lowercased) -> osis, and osis (lowercased) -> osis, from the fixtures."""
    lookup: dict[str, str] = {}
    for entry in index.values():
        ref = entry["reference"]
        lookup[ref["book"].lower()] = ref["osis"]
        lookup[ref["osis"].lower()] = ref["osis"]
    return lookup


class Job:
    def __init__(self, job_id: str, scenario: str, cache_hit: bool, duration_s: float) -> None:
        self.id = job_id
        self.scenario = scenario
        self.cache_hit = cache_hit
        self.duration_s = duration_s
        self.status = "queued"
        self.phase = "hashing"
        self.progress = 0.0
        self.message = "Queued"
        self.error: dict[str, Any] | None = None
        self.result: dict[str, Any] | None = None
        self.created_at = time.time()
        self.lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.subscribers: list[Queue[JobEvent]] = []
        self.died = False

    def snapshot(self) -> dict[str, Any]:
        elapsed = time.time() - self.created_at
        eta = None
        if self.status == "running" and self.progress > 0.01:
            eta = max(0.0, elapsed / self.progress - elapsed)
        return {
            "job_id": self.id,
            "status": self.status,
            "phase": self.phase,
            "progress": round(self.progress, 4),
            "elapsed_s": round(elapsed, 1),
            "eta_s": round(eta, 1) if eta is not None else None,
            "message": self.message,
            "error": self.error,
        }

    def publish(self, event: str, data: dict[str, Any]) -> None:
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            q.put((event, data))

    def subscribe(self) -> Queue[JobEvent]:
        q: Queue[JobEvent] = Queue()
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q: Queue[JobEvent]) -> None:
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)


class State:
    def __init__(self, args: argparse.Namespace, token: str) -> None:
        self.args = args
        self.token = token
        self.jobs: dict[str, Job] = {}
        self.jobs_lock = threading.Lock()
        self.resolve_index = build_resolve_index()
        self.book_lookup = build_book_lookup(self.resolve_index)
        self.api_version = args.api_version
        self.started_at = time.time()

    def health(self) -> dict[str, Any]:
        degraded = self.args.degraded
        return {
            "status": "degraded" if degraded else "ready",
            "api_version": self.api_version,
            "sidecar_version": SIDECAR_VERSION,
            "device": "cpu" if degraded else "cuda",
            "model_loaded": MODELS[0]["name"],
            "gpu": None
            if degraded
            else {"name": "NVIDIA RTX 4070", "vram_total_mb": 12282, "vram_free_mb": 9104},
            "provider": {"id": "api_bible", "reachable": not degraded},
            "active_jobs": sum(1 for j in self.jobs.values() if j.status == "running"),
        }

    def new_job(self) -> Job:
        cache_hit = self.args.cache_hit
        duration = self.args.duration
        if self.args.slow:
            duration *= 5
        if cache_hit:
            duration = min(duration, 4.0)
        job_id = "job_" + uuid.uuid4().hex[:20]
        job = Job(job_id, self.args.scenario, cache_hit, duration)
        with self.jobs_lock:
            self.jobs[job_id] = job
        threading.Thread(target=run_job, args=(job, self.args), daemon=True).start()
        return job


def phase_weights_for(job: Job) -> list[tuple[str, float]]:
    weights = PHASE_WEIGHTS
    if job.cache_hit:
        weights = [(name, w) for name, w in weights if name != "transcribing"]
        total = sum(w for _, w in weights)
        weights = [(name, w / total) for name, w in weights]
    return weights


def fail_job(job: Job, code: str, message_override: str | None = None) -> None:
    default = {"code": code, "message": code, "retryable": False, "hint": None}
    error = dict(ERROR_EXAMPLES.get(code, default))
    if message_override:
        error["message"] = message_override
    job.status = "failed"
    job.error = error
    job.message = error["message"]
    # No SSE event type for failure is defined in docs/07-sidecar-api.md's SSE example —
    # the stream simply ends; a client learns the outcome from GET /jobs/{id} or /result.


def run_job(job: Job, args: argparse.Namespace) -> None:
    job.status = "running"

    if args.fail == "model_load_failed":
        job.phase = "transcribing"
        job.progress = 0.0
        time.sleep(0.3)
        fail_job(job, "model_load_failed")
        return

    weights = phase_weights_for(job)
    cumulative = 0.0
    for name, weight in weights:
        phase_duration = job.duration_s * weight
        steps = max(1, int(phase_duration // 0.5))
        step_interval = phase_duration / steps
        for step in range(steps):
            if job.cancel_event.wait(timeout=step_interval):
                job.status = "cancelled"
                job.message = "Cancelled"
                return
            internal = (step + 1) / steps
            job.phase = name
            job.progress = cumulative + weight * internal
            job.message = f"{PHASE_MESSAGES[name]} ({int(internal * 100)}%)"
            job.publish(
                "progress",
                {
                    "phase": job.phase,
                    "progress": round(job.progress, 4),
                    "eta_s": job.snapshot()["eta_s"],
                },
            )
            if args.die_mid_job and job.progress >= 0.5 and not job.died:
                job.died = True
                sys.stderr.write(f"[mock-sidecar] --die-mid-job: exiting mid-job ({job.id})\n")
                sys.stderr.flush()
                os._exit(1)
        cumulative += weight

    scenario = "flagged" if args.fail == "provider_unavailable" else job.scenario
    result = copy.deepcopy(load_fixture(scenario))
    result["job"]["id"] = job.id
    result["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    job.result = result
    job.status = "done"
    job.progress = 1.0
    job.message = "Done"
    job.publish("done", {"job_id": job.id, "cue_count": len(result["cues"])})


ParsedReference = tuple[str, int, int | None, int | None]


def parse_reference(
    ref: Any, book_lookup: dict[str, str]
) -> ParsedReference | None:
    if isinstance(ref, dict):
        book = str(ref.get("book", "")).lower()
        osis = book_lookup.get(book) or book_lookup.get(str(ref.get("osis", "")).lower())
        if not osis or "chapter" not in ref:
            return None
        return osis, int(ref["chapter"]), ref.get("verse"), ref.get("verse_end")

    if not isinstance(ref, str):
        return None
    m = BOOK_PATTERN.match(ref)
    if not m:
        return None
    osis = book_lookup.get(m.group("book").strip().lower())
    if not osis:
        return None
    verse = int(m.group("verse")) if m.group("verse") else None
    verse_end = int(m.group("verse_end")) if m.group("verse_end") else None
    return osis, int(m.group("chapter")), verse, verse_end


def resolve_passage(state: State, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    translation_id = body.get("translation_id")
    if translation_id and translation_id != TRANSLATIONS[0]["id"]:
        return 400, error_body(
            "translation_not_licensed",
            f"Translation {translation_id} is not available in this mock (only KJV has real text).",
            retryable=False,
        )

    parsed = parse_reference(body.get("reference"), state.book_lookup)
    if parsed is None:
        return 400, error_body(
            "bad_request", "Could not parse or recognise that reference.", retryable=False
        )

    osis, chapter, verse, _verse_end = parsed
    if verse is None:
        return 400, error_body(
            "bad_request",
            "A chapter-only reference has no single passage to resolve (see D12).",
            retryable=False,
        )

    entry = state.resolve_index.get((osis, chapter, verse))
    if entry is None:
        return 400, error_body(
            "bad_request",
            "That reference isn't in this mock's fixture-backed lookup.",
            retryable=False,
        )

    # The mock does not do real per-verse decomposition (that is T-06/T-14's job) — `verses`
    # always carries a single entry covering the whole resolved body, even for a range.
    passage = {
        "reference_display": entry["reference_display"],
        "body": entry["body"],
        "verses": [{"verse": entry["reference"]["verse"], "text": entry["body"]}],
        "word_count": len(entry["body"].split()),
        "translation": {
            "id": TRANSLATIONS[0]["id"],
            "abbreviation": TRANSLATIONS[0]["abbreviation"],
            "name": TRANSLATIONS[0]["name"],
            "attribution": TRANSLATIONS[0]["attribution"],
        },
        "truncated": False,
        "source": "cache",
    }
    return 200, passage


def error_body(
    code: str,
    message: str,
    *,
    retryable: bool,
    hint: str | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "detail": detail,
            "retryable": retryable,
            "hint": hint,
        }
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "VerseSyncMockSidecar/1.0"

    def log_message(self, fmt: str, *fmt_args: Any) -> None:  # quieter default logging
        sys.stderr.write("[mock-sidecar] " + (fmt % fmt_args) + "\n")

    @property
    def state(self) -> State:
        return cast(State, self.server.state)  # type: ignore[attr-defined]

    # ---- shared helpers -------------------------------------------------

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-VerseSync-Api", self.state.api_version)
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _authorized(self) -> bool:
        """Bearer token + Origin allowlist (docs/07-sidecar-api.md §1.2-1.3). 401, no body."""
        origin = self.headers.get("Origin")
        allowed = self.state.args.allow_origin
        if not origin:
            return False
        if allowed and origin not in allowed:
            return False
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {self.state.token}"

    def _unauthorized(self) -> None:
        self.send_response(401)
        self.send_header("Content-Length", "0")
        self.send_header("X-VerseSync-Api", self.state.api_version)
        self.end_headers()

    def _job_or_404(self, job_id: str) -> Job | None:
        job = self.state.jobs.get(job_id)
        if job is None:
            self._send_json(404, error_body("job_not_found", f"No job {job_id}.", retryable=False))
        return job

    # ---- routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = self.path.split("?", 1)[0]

        if path == "/health":
            self._send_json(200, self.state.health())
            return

        if not self._authorized():
            self._unauthorized()
            return

        if path == "/models":
            self._send_json(200, {"models": MODELS})
            return
        if path == "/translations":
            self._send_json(200, {"provider": "api_bible", "translations": TRANSLATIONS})
            return

        m = re.match(r"^/jobs/([^/]+)(/events|/result)?$", path)
        if m:
            job_id, suffix = m.group(1), m.group(2)
            job = self._job_or_404(job_id)
            if job is None:
                return
            if suffix == "/events":
                self._serve_events(job)
            elif suffix == "/result":
                if job.status != "done":
                    self._send_json(
                        409,
                        error_body(
                            "job_not_finished",
                            f"Job {job_id} is {job.status}, not done.",
                            retryable=True,
                        ),
                    )
                else:
                    assert job.result is not None
                    self._send_json(200, job.result)
            else:
                self._send_json(200, job.snapshot())
            return

        self._send_json(404, error_body("bad_request", f"No such route: {path}", retryable=False))

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]

        if not self._authorized():
            self._unauthorized()
            return

        if path == "/jobs":
            body = self._read_json_body()
            if "media_path" not in body or "translation_id" not in body:
                self._send_json(
                    400,
                    error_body(
                        "bad_request",
                        "media_path and translation_id are required.",
                        retryable=False,
                    ),
                )
                return
            job = self.state.new_job()
            self._send_json(
                202,
                {
                    "job_id": job.id,
                    "status": "queued",
                    "cache_hit": job.cache_hit,
                    "estimated_duration_s": round(job.duration_s),
                },
            )
            return

        if path == "/resolve":
            body = self._read_json_body()
            status, payload = resolve_passage(self.state, body)
            self._send_json(status, payload)
            return

        if path == "/shutdown":
            self._send_json(200, {"status": "shutting_down"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        self._send_json(404, error_body("bad_request", f"No such route: {path}", retryable=False))

    def do_DELETE(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]

        if not self._authorized():
            self._unauthorized()
            return

        m = re.match(r"^/jobs/([^/]+)$", path)
        if m:
            job = self._job_or_404(m.group(1))
            if job is None:
                return
            job.cancel_event.set()
            self._send_json(200, {"job_id": job.id, "status": "cancelling"})
            return

        self._send_json(404, error_body("bad_request", f"No such route: {path}", retryable=False))

    # ---- SSE ----------------------------------------------------------------

    def _serve_events(self, job: Job) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-VerseSync-Api", self.state.api_version)
        self.end_headers()

        q = job.subscribe()
        events_sent = 0
        drop_after = 2 if self.state.args.drop_sse else None
        try:
            if job.status in ("done", "failed", "cancelled"):
                # Already finished by the time the client connected/reconnected.
                if job.status == "done":
                    assert job.result is not None
                    self._write_sse(
                        "done", {"job_id": job.id, "cue_count": len(job.result["cues"])}
                    )
                return
            while True:
                try:
                    event, data = q.get(timeout=1.0)
                except Empty:
                    if job.status in ("done", "failed", "cancelled"):
                        return
                    continue
                self._write_sse(event, data)
                events_sent += 1
                if event == "done":
                    return
                if drop_after is not None and events_sent >= drop_after:
                    return
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            job.unsubscribe(q)

    def _write_sse(self, event: str, data: dict[str, Any]) -> None:
        chunk = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
        self.wfile.write(chunk)
        self.wfile.flush()


def write_lock_file(port: int, token: str, pid: int, api_version: str) -> Path | None:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        print(
            "[mock-sidecar] APPDATA not set; skipping lock file "
            "(use --no-lock-file to silence this).",
            file=sys.stderr,
        )
        return None
    lock_dir = Path(appdata) / "VerseSync"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / "sidecar.json"
    payload = {
        "pid": pid,
        "port": port,
        "token": token,
        "api_version": api_version,
        "sidecar_version": SIDECAR_VERSION,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    lock_path.write_text(json.dumps(payload), encoding="utf-8")
    _restrict_to_current_user(lock_path)
    return lock_path


def _restrict_to_current_user(path: Path) -> None:
    """Best-effort user-only ACL (docs/07-sidecar-api.md §1.1). Never fatal."""
    if sys.platform != "win32":
        return
    user = os.environ.get("USERNAME")
    if not user:
        return
    try:
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
            capture_output=True,
            check=False,
        )
    except OSError as e:
        print(f"[mock-sidecar] could not restrict lock file ACL: {e}", file=sys.stderr)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--port", type=int, default=0,
        help="Fixed port, or 0 for an OS-assigned ephemeral port (default).",
    )
    parser.add_argument(
        "--scenario", choices=sorted(SCENARIOS), default="happy",
        help="Which T-37 fixture a successful job resolves to.",
    )
    parser.add_argument(
        "--duration", type=float, default=20.0,
        help="Wall-clock seconds for a job to run (default: 20).",
    )
    parser.add_argument(
        "--fail", choices=["model_load_failed", "provider_unavailable"], default=None,
        help="Force a failure scenario (see tools/README.md).",
    )
    parser.add_argument(
        "--degraded", action="store_true",
        help="GET /health reports status=degraded (no GPU, provider unreachable).",
    )
    parser.add_argument("--slow", action="store_true", help="5x the job duration.")
    parser.add_argument(
        "--die-mid-job", action="store_true", dest="die_mid_job",
        help="Process exits (os._exit) once a job crosses 50%% progress, simulating a crash.",
    )
    parser.add_argument(
        "--drop-sse", action="store_true", dest="drop_sse",
        help="Close the SSE stream after 2 events so the polling fallback can be exercised.",
    )
    parser.add_argument(
        "--cache-hit", action="store_true", dest="cache_hit",
        help="Every job reports cache_hit=true and skips the transcribing phase.",
    )
    parser.add_argument(
        "--api-version", default="1.0", dest="api_version",
        help="Value for X-VerseSync-Api and the lock file, to test the version-mismatch path.",
    )
    parser.add_argument(
        "--allow-origin", action="append", default=None,
        help="Restrict the Origin allowlist to these values (repeatable). "
        "Default: accept any non-empty Origin.",
    )
    parser.add_argument(
        "--no-lock-file", action="store_true", dest="no_lock_file",
        help=r"Do not read/write %%APPDATA%%\VerseSync\sidecar.json.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    token = secrets.token_urlsafe(32)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    port = server.server_address[1]
    state = State(args, token)
    server.state = state  # type: ignore[attr-defined]

    lock_path = (
        None if args.no_lock_file else write_lock_file(port, token, os.getpid(), args.api_version)
    )

    print(f"[mock-sidecar] listening on http://127.0.0.1:{port}")
    print(f"[mock-sidecar] token: {token}")
    scenario_note = (
        "  (overridden to 'flagged' outcome by --fail provider_unavailable)"
        if args.fail == "provider_unavailable"
        else ""
    )
    print(f"[mock-sidecar] scenario: {args.scenario}{scenario_note}")
    if lock_path:
        print(f"[mock-sidecar] lock file: {lock_path}")
    print(f"[mock-sidecar] try: curl http://127.0.0.1:{port}/health")
    print(
        f'[mock-sidecar] try: curl -H "Authorization: Bearer {token}" '
        f'-H "Origin: http://localhost" http://127.0.0.1:{port}/models'
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if lock_path and lock_path.exists():
            lock_path.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
