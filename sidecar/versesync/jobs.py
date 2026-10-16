"""Progress accounting and the job registry (07 §2-4)."""

from __future__ import annotations

import json
import queue
import secrets
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from queue import Queue
from typing import Any

from versesync.bible.base import BibleError, BibleProvider, Translation, TranslationNotLicensed
from versesync.cache import TranscriptCache, hash_media
from versesync.config import Config
from versesync.cues import write_document
from versesync.detect.detector import DetectConfig
from versesync.paths import app_home
from versesync.pipeline import Cancelled, PipelineConfig, run_pipeline
from versesync.server import ApiError, Request
from versesync.timing.align import AlignConfig
from versesync.timing.anchor import TimingConfig
from versesync.transcribe import Backend, TranscribeOptions, TranscriptionError
from versesync.types import Word

# 07 §4: transcribing dominates; the other phases share the remainder.
PHASE_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("hashing", 0.02),
    ("transcribing", 0.80),
    ("detecting", 0.05),
    ("resolving", 0.10),
    ("timing", 0.03),
)


class Progress:
    """Maps per-phase fractions onto one monotonic 0..1 bar.

    Skipped phases have their weight renormalised away (07 §4), so the bar still
    ends at exactly 1.0.
    """

    def __init__(self, skip: frozenset[str] = frozenset()) -> None:
        kept = [(name, weight) for name, weight in PHASE_WEIGHTS if name not in skip]
        total = sum(weight for _, weight in kept)
        self._spans: dict[str, tuple[float, float]] = {}
        base = 0.0
        for index, (name, weight) in enumerate(kept):
            share = weight / total if total > 0 else 0.0
            # The final phase ends at a literal 1.0 so float drift can't leave 0.9999999.
            end = 1.0 if index == len(kept) - 1 else base + share
            self._spans[name] = (base, end)
            base = end
        self._value = 0.0

    def update(self, phase: str, fraction: float) -> float:
        """Record progress inside ``phase`` and return the overall value (never decreasing)."""
        span = self._spans.get(phase)
        if span is None:
            return self._value
        clamped = min(1.0, max(0.0, fraction))
        start, end = span
        value = end if clamped >= 1.0 else start + (end - start) * clamped
        if value > self._value:
            self._value = value
        return self._value


@dataclass
class Job:
    id: str
    status: str = "queued"
    phase: str | None = None
    progress: float = 0.0
    message: str | None = None
    error: dict[str, Any] | None = None
    cache_hit: bool = False
    created: float = 0.0
    result_path: Path | None = None
    # Set by whoever cancels the job (DELETE /jobs/{id}); the runner polls it between steps.
    cancel_event: threading.Event = field(
        default_factory=threading.Event, repr=False, compare=False
    )

    def snapshot(self, now: float | None = None) -> dict[str, Any]:
        """The ``GET /jobs/{id}`` body (07 §2)."""
        elapsed = max(0.0, now - self.created) if now is not None else 0.0
        running = self.status in ("queued", "running")
        eta: float | None = None
        if running and self.progress > 0.0:
            eta = elapsed * (1.0 - self.progress) / self.progress
        return {
            "job_id": self.id,
            "status": self.status,
            "phase": self.phase,
            "progress": self.progress,
            "elapsed_s": round(elapsed),
            "eta_s": round(eta) if eta is not None else None,
            "message": self.message,
            "error": self.error,
        }


_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_job_id() -> str:
    """``job_`` plus a 26-char ULID-like string: 10 time chars, 16 random chars."""
    millis = int(time.time() * 1000)
    head = "".join(_CROCKFORD[(millis >> shift) & 31] for shift in range(45, -1, -5))
    tail = "".join(secrets.choice(_CROCKFORD) for _ in range(16))
    return "job_" + head + tail


class JobRegistry:
    def __init__(
        self,
        id_factory: Callable[[], str] = new_job_id,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._id_factory = id_factory
        self._clock = clock
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._subscribers: dict[str, list[Queue[tuple[str, dict[str, Any]]]]] = {}

    def create(self, **kw: Any) -> Job:
        with self._lock:
            kw.setdefault("created", self._clock())
            job = Job(id=self._id_factory(), **kw)
            self._jobs[job.id] = job
            self._subscribers[job.id] = []
            return job

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise ApiError(404, "job_not_found", f"No job with id {job_id}")
        return job

    def subscribe(self, job_id: str) -> Queue[tuple[str, dict[str, Any]]]:
        """A new queue that receives every later ``(event, data)`` for the job."""
        self.get(job_id)
        events: Queue[tuple[str, dict[str, Any]]] = queue.Queue()
        with self._lock:
            self._subscribers[job_id].append(events)
        return events

    def publish(self, job_id: str, event: str, data: dict[str, Any]) -> None:
        self.get(job_id)
        with self._lock:
            listeners = list(self._subscribers[job_id])
        for listener in listeners:
            listener.put((event, data))

    def remove(self, job_id: str) -> None:
        """Forget a finished job; its subscribers (if any) keep their queues."""
        with self._lock:
            self._jobs.pop(job_id, None)
            self._subscribers.pop(job_id, None)

    def active_count(self) -> int:
        with self._lock:
            return sum(1 for j in self._jobs.values() if j.status in ("queued", "running"))


# 07 §2 (SSE): within a phase, progress events are at most twice a second.
PROGRESS_MIN_INTERVAL_S = 0.5

PHASE_MESSAGES = {
    "hashing": "Reading media",
    "transcribing": "Transcribing",
    "detecting": "Detecting references",
    "resolving": "Fetching verse text",
    "timing": "Timing cues",
}

# 07 §3 codes that a Bible provider error may carry onto a job; any other code is `internal`.
_PROVIDER_JOB_CODES = frozenset({"provider_unavailable", "translation_not_licensed"})


def _error(
    code: str,
    message: str,
    *,
    hint: str | None = None,
    detail: str | None = None,
    retryable: bool = False,
) -> dict[str, Any]:
    """The 07 §3 envelope's inner object, the same shape ``ApiError.body()`` renders."""
    return {
        "code": code,
        "message": message,
        "detail": detail,
        "retryable": retryable,
        "hint": hint,
    }


class _MediaError(Exception):
    """A media file that is missing or unreadable, already mapped to its 07 §3 code."""

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(error["message"])
        self.error = error


def _media_error(path: Path, exc: OSError) -> _MediaError:
    if isinstance(exc, FileNotFoundError):
        return _MediaError(
            _error(
                "media_not_found",
                f"The media file could not be found: {path}",
                hint="Check that the drive is connected and the file has not moved.",
            )
        )
    return _MediaError(
        _error(
            "media_unreadable",
            f"The media file could not be read: {path}",
            detail=str(exc),
            hint="Check that the file is not open in another program and that you can read it.",
        )
    )


def _overrides(cls: type, *sources: dict[str, Any]) -> dict[str, Any]:
    """The entries of ``sources`` (later wins) whose keys are fields of dataclass ``cls``."""
    names = {f.name for f in fields(cls)}
    merged: dict[str, Any] = {}
    for source in sources:
        merged.update({k: v for k, v in source.items() if k in names})
    return merged


def _pipeline_config(config: Config, options: dict[str, Any]) -> PipelineConfig:
    """Config sections overlaid by the request's ``options.detection`` and ``options.timing``."""
    detection = dict(options.get("detection") or {})
    timing = dict(options.get("timing") or {})
    base = PipelineConfig()
    # config.timing holds duplicate_cooldown_s (05 §2), so it is the first fallback for detection.
    detect = replace(
        base.detect,
        **_overrides(DetectConfig, config.timing, config.detection, detection),
    )
    align = replace(base.align, **_overrides(AlignConfig, config.timing, timing))
    timing_cfg = replace(base.timing, **_overrides(TimingConfig, config.timing, timing))
    max_verses = int(config.bible.get("max_verses_per_passage", base.max_verses))
    return PipelineConfig(detect=detect, align=align, timing=timing_cfg, max_verses=max_verses)


def _transcribe_options(config: Config, options: dict[str, Any]) -> TranscribeOptions:
    return replace(TranscribeOptions.from_config(config), **_overrides(TranscribeOptions, options))


def _find_translation(provider: BibleProvider, translation_id: str) -> Translation:
    """The requested translation, or ``TranslationNotLicensed`` (06 §3.2: fail fast at start)."""
    for translation in provider.list_translations():
        if translation.id == translation_id:
            return translation
    raise TranslationNotLicensed()


class _Reporter:
    """Keeps the job's live fields current and publishes throttled ``progress`` events."""

    def __init__(self, job: Job, registry: JobRegistry, clock: Callable[[], float]) -> None:
        self._job = job
        self._registry = registry
        self._clock = clock
        self._progress = Progress()
        self._last_phase: str | None = None
        self._last_published = 0.0
        self._last_value = 0.0

    def finish(self) -> None:
        """Publish a closing 1.0 if throttling dropped it (07 section 2: progress ends at 1.0)."""
        job = self._job
        if job.phase is None or self._last_value >= 1.0:
            return
        job.progress = 1.0
        self._last_value = 1.0
        data: dict[str, Any] = {"phase": job.phase, "progress": 1.0, "eta_s": 0}
        if job.message is not None:
            data["message"] = job.message
        self._registry.publish(job.id, "progress", data)

    def skip_transcribing(self) -> None:
        """Renormalise the bar once a cache hit is known (after hashing, so hashing is done)."""
        self._progress = Progress(skip=frozenset({"transcribing"}))
        self.report("hashing", 1.0)

    def report(self, phase: str, fraction: float, message: str | None = None) -> None:
        job = self._job
        now = self._clock()
        value = self._progress.update(phase, fraction)
        changed = phase != self._last_phase
        job.phase = phase
        job.progress = max(job.progress, value)
        job.message = message or PHASE_MESSAGES.get(phase)
        if not changed and now - self._last_published < PROGRESS_MIN_INTERVAL_S:
            return
        self._last_phase = phase
        self._last_published = now
        self._last_value = round(job.progress, 4)
        data: dict[str, Any] = {
            "phase": phase,
            "progress": round(job.progress, 4),
            "eta_s": job.snapshot(now)["eta_s"],
        }
        if job.message is not None:
            data["message"] = job.message
        self._registry.publish(job.id, "progress", data)


def run_job(
    job: Job,
    req: dict[str, Any],
    *,
    config: Config,
    backend: Backend,
    provider: BibleProvider,
    registry: JobRegistry,
    clock: Callable[[], float],
) -> None:
    """Run ``hash -> transcribe (or cache) -> run_pipeline`` for one job on a worker thread.

    Fills in ``job.status``, ``job.error`` and ``job.result_path`` and publishes exactly one
    terminal event: ``done``, or ``failed`` (a cancelled job fails with the ``cancelled`` code).
    """
    job.status = "running"
    try:
        cue_count = _run_phases(job, req, config, backend, provider, registry, clock)
    except Cancelled:
        job.status = "cancelled"
        job.message = "Cancelled"
        error = _error("cancelled", "The job was cancelled.")
        registry.publish(job.id, "failed", {"job_id": job.id, "error": error})
        return
    except _MediaError as exc:
        _fail(job, registry, exc.error)
        return
    except TranscriptionError as exc:
        _fail(job, registry, _error(exc.code, exc.message, hint=exc.hint))
        return
    except BibleError as exc:
        code = exc.code if exc.code in _PROVIDER_JOB_CODES else "internal"
        _fail(job, registry, _error(code, exc.message, retryable=code == "provider_unavailable"))
        return
    except Exception as exc:  # noqa: BLE001 - a job must always end in a terminal event
        _fail(
            job,
            registry,
            _error(
                "internal",
                "VerseSync hit an unexpected problem while analysing the media.",
                detail=f"{type(exc).__name__}: {exc}",
            ),
        )
        return
    job.status = "done"
    job.phase = None
    job.progress = 1.0
    job.message = "Done"
    registry.publish(job.id, "done", {"job_id": job.id, "cue_count": cue_count})


def _fail(job: Job, registry: JobRegistry, error: dict[str, Any]) -> None:
    job.status = "failed"
    job.error = error
    job.message = error["message"]
    registry.publish(job.id, "failed", {"job_id": job.id, "error": error})


def _run_phases(
    job: Job,
    req: dict[str, Any],
    config: Config,
    backend: Backend,
    provider: BibleProvider,
    registry: JobRegistry,
    clock: Callable[[], float],
) -> int:
    """Everything between ``running`` and the terminal event; returns the cue count."""
    options: dict[str, Any] = dict(req.get("options") or {})
    is_cancelled = job.cancel_event.is_set

    def check_cancelled() -> None:
        if is_cancelled():
            raise Cancelled()

    translation = _find_translation(provider, str(req["translation_id"]))
    media_path = Path(str(req["media_path"]))
    opts = _transcribe_options(config, options)
    cfg = _pipeline_config(config, options)
    reporter = _Reporter(job, registry, clock)

    check_cancelled()
    reporter.report("hashing", 0.0)
    try:
        media_hash = hash_media(media_path, lambda f: reporter.report("hashing", f))
    except OSError as exc:
        raise _media_error(media_path, exc) from exc

    check_cancelled()
    cache = TranscriptCache()
    cached = cache.get(media_hash, opts) if options.get("use_cache", True) else None
    words: list[Word]
    if cached is not None:
        words, duration_s = cached
        job.cache_hit = True
        reporter.skip_transcribing()
    else:
        reporter.report("transcribing", 0.0)
        try:
            words, duration_s = backend.transcribe(
                media_path, opts, lambda f: reporter.report("transcribing", f), is_cancelled
            )
        except OSError as exc:
            raise _media_error(media_path, exc) from exc
        reporter.report("transcribing", 1.0)
        check_cancelled()  # a cancelled job must not leave a cached transcript behind
        # use_cache: false skips the lookup only; the fresh transcript still replaces the entry,
        # so a later cached run does not pick up the transcript the editor was avoiding.
        cache.put(media_hash, opts, words, duration_s)

    job_info: dict[str, Any] = {
        "id": job.id,
        "media_path": str(req["media_path"]),
        "media_hash": media_hash,
        "media_duration_s": duration_s,
        "model": opts.model,
        "quantization": opts.quantization,
        "device": opts.device,
        "language": opts.language,
        "options": options,
    }
    doc = run_pipeline(
        words,
        translation=translation,
        provider=provider,
        job=job_info,
        generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock())),
        cfg=cfg,
        on_phase=reporter.report,
        is_cancelled=is_cancelled,
    )
    check_cancelled()
    result_path = app_home() / "jobs" / job.id / "cues.json"
    write_document(doc, words, result_path)
    job.result_path = result_path
    reporter.finish()
    return len(doc["cues"])


# Chosen, not specified: with no probe tool in the sidecar, an uncached file's duration is
# guessed from its size at 1 MB/s (8 Mbit/s, a typical sermon proxy bitrate). It only feeds the
# `estimated_duration_s` hint on POST /jobs.
ASSUMED_BYTES_PER_MEDIA_S = 1_000_000


class _DeferredBackend:
    """Builds the real backend on first use, so a backend problem fails the job, not startup."""

    def __init__(self, factory: Callable[[], Backend]) -> None:
        self._factory = factory
        self._backend: Backend | None = None
        self._lock = threading.Lock()

    def transcribe(
        self,
        media_path: Path,
        opts: TranscribeOptions,
        progress: Callable[[float], None],
        is_cancelled: Callable[[], bool],
    ) -> tuple[list[Word], float]:
        with self._lock:
            if self._backend is None:
                self._backend = self._factory()
            backend = self._backend
        return backend.transcribe(media_path, opts, progress, is_cancelled)


class JobService:
    """The ``/jobs`` endpoints (07 section 2): validates requests and runs jobs on threads."""

    def __init__(
        self,
        *,
        config: Config,
        backend_factory: Callable[[], Backend],
        provider: BibleProvider,
        registry: JobRegistry | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.config = config
        self.provider = provider
        self.clock = clock
        self.registry = registry if registry is not None else JobRegistry(clock=clock)
        self._backend = _DeferredBackend(backend_factory)

    def active_count(self) -> int:
        return self.registry.active_count()

    def _validated_media(self, raw: Any) -> Path:
        if not isinstance(raw, str) or not raw:
            raise ApiError(400, "bad_request", "The request needs a media_path.")
        path = Path(raw)
        roots = [Path(str(r)) for r in self.config.server.get("allowed_media_roots") or []]
        if roots:
            resolved = path.resolve()
            if not any(resolved.is_relative_to(root.resolve()) for root in roots):
                raise ApiError(
                    400,
                    "bad_request",
                    "That media file is outside the folders VerseSync may read.",
                    hint="Pick a file from one of the allowed media folders.",
                )
        if not path.is_file():
            raise ApiError(
                404,
                "media_not_found",
                f"The media file could not be found: {raw}",
                hint="Check that the drive is connected and the file has not moved.",
            )
        return path

    def _estimate(self, body: dict[str, Any], media: Path) -> tuple[bool, float]:
        """``(cache_hit, estimated_duration_s)``; the cache is checked here, synchronously."""
        options: dict[str, Any] = dict(body.get("options") or {})
        opts = _transcribe_options(self.config, options)
        try:
            media_hash = hash_media(media)
            size = media.stat().st_size
        except OSError as exc:
            error = _media_error(media, exc).error
            status = 404 if error["code"] == "media_not_found" else 400
            raise ApiError(
                status, error["code"], error["message"], hint=error["hint"], detail=error["detail"]
            ) from exc
        cached = TranscriptCache().get(media_hash, opts) if options.get("use_cache", True) else None
        factors: dict[str, Any] = dict(self.config.server.get("estimate_factor") or {})
        factor = float(factors.get(opts.device, factors.get("default", 0.5)))
        if cached is not None:
            # No transcription: only the detection, resolving and timing phases remain.
            return True, 0.0
        return False, size / ASSUMED_BYTES_PER_MEDIA_S * factor

    def start(self, request: Request) -> tuple[int, dict[str, Any]]:
        body = request.json()
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request", "The request body must be a JSON object.")
        translation_id = body.get("translation_id")
        if not isinstance(translation_id, str) or not translation_id:
            raise ApiError(400, "bad_request", "The request needs a translation_id.")
        if not isinstance(body.get("options", {}), dict):
            raise ApiError(400, "bad_request", "options must be a JSON object.")
        media = self._validated_media(body.get("media_path"))
        cache_hit, estimate = self._estimate(body, media)
        job = self.registry.create()
        job.cache_hit = cache_hit
        threading.Thread(
            target=run_job,
            args=(job, body),
            kwargs={
                "config": self.config,
                "backend": self._backend,
                "provider": self.provider,
                "registry": self.registry,
                "clock": self.clock,
            },
            name=f"job-{job.id}",
            daemon=True,
        ).start()
        return 202, {
            "job_id": job.id,
            "status": "queued",
            "cache_hit": cache_hit,
            "estimated_duration_s": round(estimate),
        }

    def status(self, request: Request) -> dict[str, Any]:
        return self.registry.get(request.params["id"]).snapshot(self.clock())

    def _finished_job(self, request: Request) -> Job:
        job = self.registry.get(request.params["id"])
        if job.status != "done" or job.result_path is None:
            raise ApiError(
                409,
                "job_not_finished",
                f"Job {job.id} is {job.status}, not done.",
                hint="Wait for the job to finish.",
                retryable=True,
            )
        return job

    def _read_json(self, path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ApiError(
                404, "job_not_found", "The result of that job is no longer available."
            ) from exc

    def result(self, request: Request) -> Any:
        job = self._finished_job(request)
        assert job.result_path is not None
        return self._read_json(job.result_path)

    def transcript(self, request: Request) -> Any:
        job = self._finished_job(request)
        assert job.result_path is not None
        doc = self._read_json(job.result_path)
        return self._read_json(job.result_path.parent / doc["transcript"]["words_ref"])

    def cancel(self, request: Request) -> dict[str, Any]:
        job = self.registry.get(request.params["id"])
        if job.status in ("queued", "running"):
            job.cancel_event.set()
            return {"job_id": job.id, "status": "cancelling"}
        self.registry.remove(job.id)
        shutil.rmtree(app_home() / "jobs" / job.id, ignore_errors=True)
        return {"job_id": job.id, "status": "discarded"}
