"""HTTP server core for the sidecar (docs/07-sidecar-api.md §1-§3).

Loopback-only ``ThreadingHTTPServer`` with a small router, bearer-token and ``Origin``
authentication, the ``X-VerseSync-Api`` header on every response, and the §3 error envelope.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import queue
import re
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, unquote, urlsplit

from versesync.bible.base import BibleError, BibleProvider, Translation, TranslationNotLicensed
from versesync.bible.format import format_passage
from versesync.config import Config
from versesync.detect.canon import load_canon
from versesync.detect.parse import InvalidReference, parse_reference

if TYPE_CHECKING:
    from versesync.jobs import JobService

API_VERSION = "1.0"
API_HEADER = "X-VerseSync-Api"
SIDECAR_VERSION = "1.0.0"  # matches tools/mock_sidecar.py, which the contract tests (T-42) compare

# Loopback only (07 §1, NFR-4). Never "" or "0.0.0.0".
BIND_HOST = "127.0.0.1"

# Chosen, not specified: a request body above this is rejected before it is read. The largest
# legitimate body is a job-start JSON document (well under 1 MiB); 16 MiB leaves ample headroom.
MAX_BODY_BYTES = 16 * 1024 * 1024

# Chosen: stdlib default is 0.5 s, which makes every shutdown (and test teardown) wait that long.
SHUTDOWN_POLL_S = 0.05

# Chosen: how often a quiet stream re-checks whether its job has finished, and so how soon a
# stream whose queue missed the terminal event still closes.
SSE_POLL_S = 1.0

# Chosen: a quiet stream writes an SSE comment after this many polls, so a client that has gone
# away is noticed (the write fails) instead of holding a thread until the job ends.
SSE_KEEPALIVE_POLLS = 15

# Chosen: how long a provider reachability result is reused by /health. /health is polled by
# the panel, and a real provider's list_translations is a network call.
PROVIDER_CHECK_TTL_S = 30.0

# 07 section 2 (/models). The word_timestamp_quality values come from the T-02 spike
# (spikes/word_timestamps/RESULTS.md section 4): all three models were measured on real audio,
# with p90 start error of 5.8-6.6 s dominated by paraphrase, not by the model, so none is
# rated above "good"; a model the spike did not measure would be "unverified". Quantization
# lists follow the 07 section 2 example.
_QUANTIZATIONS = {"cuda": ["float16", "bfloat16", "float32"], "cpu": ["float32"]}
_MODELS: tuple[tuple[str, str], ...] = (
    ("distil-large-v3", "good"),
    ("large-v3-turbo", "good"),
    ("large-v3", "good"),
)

_TERMINAL_STATUSES = ("done", "failed", "cancelled")

_log = logging.getLogger("versesync.server")


class ApiError(Exception):
    """An error rendered as the 07 §3 envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        hint: str | None = None,
        detail: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.detail = detail
        self.retryable = retryable

    def body(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "detail": self.detail,
                "retryable": self.retryable,
                "hint": self.hint,
            }
        }


@dataclass
class Request:
    """What a route handler receives."""

    method: str
    path: str
    params: dict[str, str]
    query: dict[str, list[str]]
    headers: Any
    raw_body: bytes = b""

    def json(self) -> Any:
        """The body parsed as JSON; an empty body is ``{}``. Malformed JSON is a 400."""
        if not self.raw_body:
            return {}
        try:
            return json.loads(self.raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ApiError(400, "bad_request", "The request body is not valid JSON.") from exc


@dataclass
class EventStream:
    """A ``text/event-stream`` response: each item of ``chunks`` is written and flushed at once."""

    chunks: Iterator[bytes]


def format_sse(event: str, data: dict[str, Any]) -> bytes:
    """One server-sent event frame (07 §2)."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


# A handler returns the JSON payload (status 200) or a ``(status, payload)`` pair.
RouteResult = Any
RouteHandler = Callable[[Request], RouteResult]


@dataclass
class _Route:
    method: str
    regex: re.Pattern[str]
    handler: RouteHandler
    auth: bool


def _compile_pattern(pattern: str) -> re.Pattern[str]:
    parts = re.split(r"\{(\w+)\}", pattern)
    out = []
    for index, part in enumerate(parts):
        out.append(f"(?P<{part}>[^/]+)" if index % 2 else re.escape(part))
    return re.compile("^" + "".join(out) + "$")


def _model_downloaded(name: str) -> bool:
    """Whether a faster-whisper copy of ``name`` is in the Hugging Face cache (no network)."""
    hub = os.environ.get("HF_HUB_CACHE")
    if hub:
        root = Path(hub)
    else:
        home = os.environ.get("HF_HOME")
        root = (Path(home) if home else Path.home() / ".cache" / "huggingface") / "hub"
    # CTranslate2 conversions are published as faster-whisper-<name>, or faster-distil-whisper-<x>.
    suffixes = (
        f"--faster-whisper-{name}",
        f"--faster-{name}",
        f"--faster-distil-whisper-{name.removeprefix('distil-')}",
    )
    try:
        return any(
            entry.name.startswith("models--") and entry.name.endswith(suffixes)
            for entry in root.iterdir()
        )
    except OSError:
        return False


class _Httpd(ThreadingHTTPServer):
    daemon_threads = True
    # SO_REUSEADDR on Windows lets another process share the port; never wanted here.
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], app: SidecarServer) -> None:
        self.app = app
        super().__init__(address, _Handler)


class _Handler(BaseHTTPRequestHandler):
    server_version = "VerseSyncSidecar/1.0"

    @property
    def app(self) -> SidecarServer:
        server = self.server
        assert isinstance(server, _Httpd)
        return server.app

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # The request line can carry a path but never the Authorization header.
        _log.debug("%s - %s", self.address_string(), format % args)

    def end_headers(self) -> None:
        # Every response, including stdlib-generated ones, names the API version.
        self.send_header(API_HEADER, API_VERSION)
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        self._dispatch()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET  # noqa: N815

    def _authorized(self) -> bool:
        """Bearer token plus a present, allowlisted Origin (07 §1.2-§1.3)."""
        origin = self.headers.get("Origin")
        if not origin or origin not in self.app.allowed_origins:
            return False
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.app.token}"
        return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_stream(self, stream: EventStream) -> None:
        """Write ``stream`` until it ends or the client goes away; the connection then closes."""
        self.close_connection = True  # no Content-Length: the end of the stream is the close
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.flush()
            for chunk in stream.chunks:
                self.wfile.write(chunk)
                self.wfile.flush()
        except OSError:
            # The client dropped the stream (a panel reload); it falls back to polling (NFR-3).
            _log.debug("event stream closed by the client")
        finally:
            close = getattr(stream.chunks, "close", None)
            if close is not None:
                close()

    def _send_unauthorized(self) -> None:
        self.send_response(401)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as exc:
            raise ApiError(400, "bad_request", "The Content-Length header is invalid.") from exc
        if length < 0:
            raise ApiError(400, "bad_request", "The Content-Length header is invalid.")
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "bad_request", "The request body is too large.")
        return self.rfile.read(length) if length else b""

    def _dispatch(self) -> None:
        try:
            split = urlsplit(self.path)
            method = self.command
            matched, path_known = self.app.match(method, split.path)
            if matched is None or matched[0].auth:
                if not self._authorized():
                    self._send_unauthorized()
                    return
            if matched is None:
                if path_known:
                    raise ApiError(405, "bad_request", f"{method} is not allowed here.")
                raise ApiError(404, "bad_request", "No such endpoint.")
            route, params = matched
            request = Request(
                method=method,
                path=split.path,
                params=params,
                query=parse_qs(split.query),
                headers=self.headers,
                raw_body=self._read_body(),
            )
            result = route.handler(request)
            if isinstance(result, EventStream):
                self._send_stream(result)
                return
            if isinstance(result, tuple):
                status, payload = result
            else:
                status, payload = 200, result
            self._send_json(status, payload)
        except ApiError as exc:
            self._send_json(exc.status, exc.body())
        except Exception:
            # Full detail goes to the log only; the client sees nothing of the cause.
            _log.exception("unhandled error serving %s %s", self.command, self.path.split("?")[0])
            error = ApiError(
                500,
                "internal",
                "Something went wrong inside VerseSync.",
                hint="Check the VerseSync log for details.",
            )
            self._send_json(error.status, error.body())


class SidecarServer:
    """Loopback HTTP server with bearer-token auth, an Origin allowlist and a small router."""

    def __init__(self, config: Config, token: str, port: int = 0) -> None:
        self.config = config
        self.token = token
        self.allowed_origins: frozenset[str] = frozenset(
            str(origin) for origin in config.server.get("allowed_origins", [])
        )
        self._routes: list[_Route] = []
        self._httpd = _Httpd((BIND_HOST, port), self)
        self.port: int = self._httpd.server_address[1]
        self._lifecycle = threading.Lock()
        self._serving = False
        self._closed = False
        self.jobs: JobService | None = None
        # /health reports busy while this is non-zero; attach_jobs() points it at the registry.
        self.active_jobs: Callable[[], int] = lambda: 0
        self.provider: BibleProvider | None = None
        self.model_downloaded: Callable[[str], bool] = _model_downloaded
        self.clock: Callable[[], float] = time.monotonic
        self._provider_check: tuple[float, bool] | None = None
        self._provider_lock = threading.Lock()
        self.status = "starting"  # starting | ready | busy | degraded (07 §2)
        self.route("GET", "/health", lambda request: self.health(), auth=False)
        self.route("POST", "/shutdown", self._handle_shutdown)
        self.route("GET", "/models", lambda request: self._models())
        self.route("GET", "/translations", lambda request: self._translations())
        self.route("POST", "/resolve", self._resolve)

    @property
    def server_address(self) -> tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    def route(self, method: str, pattern: str, handler: RouteHandler, *, auth: bool = True) -> None:
        """Register ``handler`` for ``method`` + ``pattern`` (``{name}`` captures one segment)."""
        self._routes.append(_Route(method.upper(), _compile_pattern(pattern), handler, auth))

    def match(self, method: str, path: str) -> tuple[tuple[_Route, dict[str, str]] | None, bool]:
        """Return ``((route, params) or None, path_known_for_some_method)``."""
        path_known = False
        for route in self._routes:
            found = route.regex.match(path)
            if found is None:
                continue
            path_known = True
            if route.method == method:
                params = {name: unquote(value) for name, value in found.groupdict().items()}
                return (route, params), True
        return None, path_known

    def attach_jobs(self, service: JobService) -> None:
        """Register the ``/jobs`` routes (07 section 2) backed by ``service``."""
        self.jobs = service
        self.active_jobs = service.active_count
        self.route("POST", "/jobs", service.start)
        self.route("GET", "/jobs/{id}", service.status)
        self.route("GET", "/jobs/{id}/result", service.result)
        self.route("GET", "/jobs/{id}/transcript", service.transcript)
        self.route("DELETE", "/jobs/{id}", service.cancel)
        self.route("GET", "/jobs/{id}/events", lambda request: self._job_events(service, request))

    @staticmethod
    def _job_events(service: JobService, request: Request) -> EventStream:
        """``GET /jobs/{id}/events`` (07 §2): the snapshot, live progress, one terminal event."""
        registry = service.registry
        job = registry.get(request.params["id"])  # 404 job_not_found while still a plain response
        # Subscribe before reading the snapshot, so no event can fall between the two.
        events = registry.subscribe(job.id)
        status = job.status
        snapshot = job.snapshot(service.clock())
        progress: dict[str, Any] = {
            "phase": snapshot["phase"],
            "progress": snapshot["progress"],
            "eta_s": snapshot["eta_s"],
        }
        if snapshot["message"] is not None:
            progress["message"] = snapshot["message"]

        def terminal() -> tuple[str, dict[str, Any]]:
            """The terminal event of a finished job, rebuilt from its state."""
            if job.status == "done":
                cue_count = len(service.result(request)["cues"])
                return "done", {"job_id": job.id, "cue_count": cue_count}
            error = job.error or {
                "code": "cancelled",
                "message": "The job was cancelled.",
                "detail": None,
                "retryable": False,
                "hint": None,
            }
            return "failed", {"job_id": job.id, "error": error}

        finished = terminal() if status in _TERMINAL_STATUSES else None

        def chunks() -> Iterator[bytes]:
            yield format_sse("progress", progress)
            if finished is not None:
                yield format_sse(*finished)
                return
            idle = 0
            while True:
                try:
                    event, data = events.get(timeout=SSE_POLL_S)
                except queue.Empty:
                    if job.status in _TERMINAL_STATUSES:
                        # The runner sets the status just before it publishes; a full poll with
                        # nothing queued means the terminal event will not reach this queue.
                        yield format_sse(*terminal())
                        return
                    idle += 1
                    if idle % SSE_KEEPALIVE_POLLS == 0:
                        yield b": keepalive\n\n"
                    continue
                yield format_sse(event, data)
                if event in ("done", "failed"):
                    return

        return EventStream(chunks())

    def attach_provider(self, provider: BibleProvider) -> None:
        """Set the Bible provider behind ``/translations``, ``/resolve`` and ``/health``."""
        self.provider = provider
        self._provider_check = None

    def _require_provider(self) -> BibleProvider:
        if self.provider is None:
            raise ApiError(
                503,
                "provider_unavailable",
                "No Bible text provider is configured.",
                retryable=True,
            )
        return self.provider

    def _models(self) -> dict[str, Any]:
        """``GET /models`` (07 section 2)."""
        recommended = str(self.config.transcription.get("model", ""))
        return {
            "models": [
                {
                    "name": name,
                    "word_timestamp_quality": quality,
                    "supported_quantizations": {k: list(v) for k, v in _QUANTIZATIONS.items()},
                    "downloaded": self.model_downloaded(name),
                    "recommended": name == recommended,
                }
                for name, quality in _MODELS
            ]
        }

    def _translations(self) -> dict[str, Any]:
        """``GET /translations`` (07 section 2)."""
        provider = self._require_provider()
        try:
            translations = provider.list_translations()
        except BibleError as exc:
            raise ApiError(503, "provider_unavailable", exc.message, retryable=True) from exc
        return {"provider": provider.id, "translations": [t.to_json() for t in translations]}

    def _resolve(self, request: Request) -> dict[str, Any]:
        """``POST /resolve`` (07 section 2): one reference to a ``Passage``."""
        body = request.json()
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request", "The request body must be a JSON object.")
        reference = body.get("reference")
        if not isinstance(reference, (str, dict)):
            raise ApiError(400, "bad_request", "A reference (text or object) is required.")
        provider = self._require_provider()
        canon = load_canon()
        try:
            ref = parse_reference(reference, canon)
            if ref.verse is None:
                # D12: a chapter alone has no single passage to show.
                raise InvalidReference(
                    "Add a verse; a whole chapter can't be shown as one passage."
                )
            translations = provider.list_translations()
            translation: Translation | None
            wanted = body.get("translation_id")
            if wanted is None:
                default = str(self.config.bible.get("default_translation", "")).lower()
                chosen = [t for t in translations if t.abbreviation.lower() == default]
                translation = (chosen + translations)[0] if translations else None
            else:
                translation = next((t for t in translations if t.id == wanted), None)
            if translation is None:
                raise TranslationNotLicensed()
            raw = provider.fetch(ref, translation.id)
            passage = format_passage(
                raw,
                translation,
                canon,
                max_verses=int(self.config.bible.get("max_verses_per_passage", 6)),
                source="local" if provider.id == "local" else "provider",
            )
        except InvalidReference as exc:
            raise ApiError(400, "bad_request", str(exc)) from exc
        except TranslationNotLicensed as exc:
            raise ApiError(400, "translation_not_licensed", exc.message) from exc
        except BibleError as exc:
            if exc.code in ("provider_unavailable", "rate_limited"):
                raise ApiError(503, "provider_unavailable", exc.message, retryable=True) from exc
            raise ApiError(400, "bad_request", exc.message) from exc
        return passage.to_json()

    def _provider_reachable(self) -> bool:
        """Whether ``list_translations`` works, re-checked at most every PROVIDER_CHECK_TTL_S."""
        provider = self._require_provider()
        with self._provider_lock:
            now = self.clock()
            if self._provider_check is not None and now - self._provider_check[0] < (
                PROVIDER_CHECK_TTL_S
            ):
                return self._provider_check[1]
            try:
                provider.list_translations()
                reachable = True
            except (BibleError, OSError):
                reachable = False
            self._provider_check = (now, reachable)
            return reachable

    def mark_ready(self) -> None:
        """Move ``/health`` from ``starting`` to ``ready``."""
        self.status = "ready"

    def health(self) -> dict[str, Any]:
        """The ``/health`` body (07 §2). Subclasses and the entry point override the pieces."""
        active = self.active_jobs()
        device = self.config.transcription.get("device")
        provider = None
        if self.provider is not None:
            provider = {"id": self.provider.id, "reachable": self._provider_reachable()}
        status = self.status
        if status == "ready":
            if active > 0:
                status = "busy"
            elif device == "cpu" or (provider is not None and not provider["reachable"]):
                status = "degraded"
        return {
            "status": status,
            "api_version": API_VERSION,
            "sidecar_version": SIDECAR_VERSION,
            "device": device,
            "model_loaded": None,  # the backend loads lazily, on the first job (T-20.2)
            "gpu": None,  # no GPU probe without importing torch; the panel treats null as unknown
            "provider": provider,
            "active_jobs": active,
        }

    def _handle_shutdown(self, request: Request) -> RouteResult:
        # httpd.shutdown() waits for serve_forever to return, so it must not run on the
        # request thread that is still answering this call.
        threading.Thread(target=self.shutdown, name="sidecar-shutdown", daemon=True).start()
        return {"status": "shutting_down"}

    def serve_forever(self) -> None:
        with self._lifecycle:
            if self._closed:
                return
            self._serving = True
        try:
            self._httpd.serve_forever(poll_interval=SHUTDOWN_POLL_S)
        finally:
            self._httpd.server_close()

    def shutdown(self) -> None:
        """Stop serving and release the socket. Safe to call more than once."""
        with self._lifecycle:
            if self._closed:
                return
            self._closed = True
            serving = self._serving
        if serving:
            self._httpd.shutdown()
        else:
            self._httpd.server_close()
