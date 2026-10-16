import json
from pathlib import Path
from queue import Empty, Queue
from typing import Any

import pytest
from transcript_fixtures import FIXTURES_DIR

from versesync.bible.base import ProviderUnavailable, RawPassage, Translation
from versesync.bible.local import LocalProvider
from versesync.cache import TranscriptCache, hash_media
from versesync.config import Config
from versesync.cues import validate_document
from versesync.jobs import Job, JobRegistry, run_job
from versesync.transcribe import FakeBackend, TranscribeOptions, TranscriptionError
from versesync.types import Reference, Word, load_words

PROVIDER = LocalProvider()
TRANSLATION: Translation = PROVIDER.list_translations()[0]
WORDS = load_words(FIXTURES_DIR / "numbers-and-ordinals.words.json")
PHASES = ["hashing", "transcribing", "detecting", "resolving", "timing"]


class FakeClock:
    """A callable clock that moves only when the test (or ``step``) says so."""

    def __init__(self, start: float = 1_800_000_000.0, step: float = 0.0) -> None:
        self.now = start
        self.step = step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


class DownProvider:
    """Lists translations like the local store, but every fetch fails."""

    id = "down"

    def list_translations(self) -> list[Translation]:
        return PROVIDER.list_translations()

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        raise ProviderUnavailable()

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        raise ProviderUnavailable()


class Run:
    def __init__(self, job: Job, registry: JobRegistry, events: Queue[tuple[str, dict[str, Any]]]):
        self.job = job
        self.registry = registry
        self.events = events

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        out = []
        while True:
            try:
                out.append(self.events.get_nowait())
            except Empty:
                return out

    def terminal(self) -> list[tuple[str, dict[str, Any]]]:
        return [e for e in self.drain() if e[0] != "progress"]


@pytest.fixture
def media(tmp_path: Path) -> Path:
    path = tmp_path / "sermon.mxf"
    path.write_bytes(b"not really media, only hashed" * 100)
    return path


def read_doc(job: Job) -> dict[str, Any]:
    assert job.result_path is not None
    doc: dict[str, Any] = json.loads(job.result_path.read_text(encoding="utf-8"))
    return doc


def start(
    media_path: Path | str,
    *,
    backend: FakeBackend | None = None,
    provider: Any = PROVIDER,
    clock: FakeClock | None = None,
    options: dict[str, Any] | None = None,
    translation_id: str = TRANSLATION.id,
    job: Job | None = None,
    registry: JobRegistry | None = None,
) -> Run:
    registry = registry or JobRegistry(id_factory=lambda: "job_TEST", clock=clock or FakeClock())
    job = job or registry.create()
    events = registry.subscribe(job.id)
    req: dict[str, Any] = {"media_path": str(media_path), "translation_id": translation_id}
    if options is not None:
        req["options"] = options
    run_job(
        job,
        req,
        config=Config(),
        backend=backend or FakeBackend(WORDS),
        provider=provider,
        registry=registry,
        clock=clock or FakeClock(),
    )
    return Run(job, registry, events)


def test_happy_run(app_home: Path, media: Path) -> None:
    backend = FakeBackend(WORDS)
    run = start(media, backend=backend)
    job = run.job

    assert job.status == "done"
    assert job.error is None
    assert job.progress == 1.0
    assert not job.cache_hit
    assert job.result_path == app_home / "jobs" / job.id / "cues.json"
    doc = read_doc(job)
    validate_document(doc)
    assert doc["cues"]
    assert doc["job"]["id"] == job.id
    assert doc["job"]["media_hash"].startswith("sha256:")
    assert (job.result_path.parent / doc["transcript"]["words_ref"]).is_file()

    events = run.drain()
    phases: list[str] = []
    for name, data in events:
        if name == "progress" and (not phases or phases[-1] != data["phase"]):
            phases.append(data["phase"])
    assert phases == PHASES
    assert [e[0] for e in events].count("done") == 1
    assert events[-1] == ("done", {"job_id": job.id, "cue_count": len(doc["cues"])})
    assert len(backend.calls) == 1


def test_progress_events_never_decrease_and_are_throttled(app_home: Path, media: Path) -> None:
    # A clock that never moves: only phase changes publish, one event per phase.
    still = start(media, clock=FakeClock(step=0.0))
    still_events = [d for n, d in still.drain() if n == "progress"]
    assert [d["phase"] for d in still_events] == PHASES

    # A clock that moves 0.6 s per reading is past the 0.5 s minimum, so every report publishes.
    moving = start(
        media,
        clock=FakeClock(step=0.6),
        registry=JobRegistry(id_factory=lambda: "job_MOVING"),
    )
    moving_events = [d for n, d in moving.drain() if n == "progress"]
    values = [d["progress"] for d in moving_events]
    assert len(moving_events) > len(still_events)
    assert values == sorted(values)
    assert all(0.0 <= v <= 1.0 for v in values)


def test_cache_hit_run_skips_transcribing_and_ends_at_one(app_home: Path, media: Path) -> None:
    first_backend = FakeBackend(WORDS)
    start(media, backend=first_backend, registry=JobRegistry(id_factory=lambda: "job_ONE"))

    backend = FakeBackend(WORDS)
    run = start(
        media,
        backend=backend,
        clock=FakeClock(step=0.6),
        registry=JobRegistry(id_factory=lambda: "job_TWO"),
    )
    assert run.job.status == "done"
    assert run.job.cache_hit
    assert backend.calls == []
    assert run.job.progress == 1.0

    events = run.drain()
    progress = [d for n, d in events if n == "progress"]
    assert progress
    assert "transcribing" not in {d["phase"] for d in progress}
    values = [d["progress"] for d in progress]
    assert values == sorted(values)
    assert [n for n, _ in events].count("done") == 1


def test_use_cache_false_transcribes_again(app_home: Path, media: Path) -> None:
    start(media, registry=JobRegistry(id_factory=lambda: "job_ONE"))
    backend = FakeBackend(WORDS)
    run = start(
        media,
        backend=backend,
        options={"use_cache": False},
        registry=JobRegistry(id_factory=lambda: "job_TWO"),
    )
    assert run.job.status == "done"
    assert not run.job.cache_hit
    assert len(backend.calls) == 1


def test_options_reach_the_backend_and_document(app_home: Path, media: Path) -> None:
    backend = FakeBackend(WORDS)
    run = start(media, backend=backend, options={"model": "tiny", "device": "cpu"})
    assert backend.calls[0][1].model == "tiny"
    doc = read_doc(run.job)
    assert doc["job"]["model"] == "tiny"
    assert doc["job"]["device"] == "cpu"
    assert doc["job"]["options"] == {"model": "tiny", "device": "cpu"}


def test_provider_outage_is_a_successful_job(app_home: Path, media: Path) -> None:
    run = start(media, provider=DownProvider())
    assert run.job.status == "done"
    assert run.job.error is None
    doc = read_doc(run.job)
    validate_document(doc)
    assert doc["cues"]
    # Chapter-only mentions fetch nothing, so they are the only cues without the flag.
    unavailable = [c for c in doc["cues"] if "text_unavailable" in c["flags"]]
    assert unavailable
    assert all("chapter_only" in c["flags"] for c in doc["cues"] if c not in unavailable)
    assert [w["code"] for w in doc["warnings"]] == ["provider_partial"]
    assert [n for n, _ in run.drain()].count("done") == 1


def test_cancel_mid_transcription(app_home: Path, media: Path) -> None:
    clock = FakeClock()
    registry = JobRegistry(id_factory=lambda: "job_CANCEL", clock=clock)
    job = registry.create()

    def on_tick(tick: int) -> None:
        if tick == 4:
            job.cancel_event.set()

    started = clock.now
    run = start(
        media,
        backend=FakeBackend(WORDS, on_tick=on_tick),
        clock=clock,
        job=job,
        registry=registry,
    )
    assert clock.now - started < 1.0
    assert job.status == "cancelled"
    assert job.result_path is None
    assert job.error is None
    assert not (app_home / "jobs").exists()
    assert TranscriptCache().get(_hash(media), TranscribeOptions.from_config(Config())) is None
    terminal = run.terminal()
    assert len(terminal) == 1
    assert terminal[0][0] == "failed"
    assert terminal[0][1]["error"]["code"] == "cancelled"


def test_cancel_before_start_runs_nothing(app_home: Path, media: Path) -> None:
    registry = JobRegistry(id_factory=lambda: "job_EARLY")
    job = registry.create()
    job.cancel_event.set()
    backend = FakeBackend(WORDS)
    run = start(media, backend=backend, job=job, registry=registry)
    assert job.status == "cancelled"
    assert backend.calls == []
    assert len(run.terminal()) == 1


def _hash(path: Path) -> str:
    return hash_media(path)


def _failed(run: Run) -> dict[str, Any]:
    terminal = run.terminal()
    assert len(terminal) == 1
    event, data = terminal[0]
    assert event == "failed"
    assert data["job_id"] == run.job.id
    assert run.job.status == "failed"
    assert run.job.result_path is None
    assert run.job.error == data["error"]
    assert set(data["error"]) == {"code", "message", "detail", "retryable", "hint"}
    return data["error"]  # type: ignore[no-any-return]


def test_missing_file_is_media_not_found(app_home: Path, tmp_path: Path) -> None:
    run = start(tmp_path / "gone.mxf")
    assert _failed(run)["code"] == "media_not_found"


def test_unreadable_file_is_media_unreadable(app_home: Path, tmp_path: Path) -> None:
    # Opening a directory as a file fails with an OSError that is not FileNotFoundError.
    run = start(tmp_path)
    assert _failed(run)["code"] == "media_unreadable"


def test_transcription_error_code_passes_through(app_home: Path, media: Path) -> None:
    error = TranscriptionError("model_load_failed", "Out of memory.", "Try the CPU.")
    run = start(media, backend=FakeBackend(error=error))
    failure = _failed(run)
    assert failure["code"] == "model_load_failed"
    assert failure["message"] == "Out of memory."
    assert failure["hint"] == "Try the CPU."


def test_unlicensed_translation_fails_before_hashing(app_home: Path, tmp_path: Path) -> None:
    # The media file does not exist: had hashing run first, the code would be media_not_found.
    backend = FakeBackend(WORDS)
    run = start(tmp_path / "gone.mxf", backend=backend, translation_id="nkjv-not-licensed")
    assert _failed(run)["code"] == "translation_not_licensed"
    assert backend.calls == []
    assert [d["phase"] for n, d in run.drain() if n == "progress"] == []


def test_anything_else_is_internal(app_home: Path, media: Path) -> None:
    class Exploding(FakeBackend):
        def transcribe(self, *args: Any, **kwargs: Any) -> tuple[list[Word], float]:
            raise RuntimeError("boom")

    run = start(media, backend=Exploding())
    failure = _failed(run)
    assert failure["code"] == "internal"
    assert failure["detail"] == "RuntimeError: boom"
    assert TranscriptCache().get(_hash(media), TranscribeOptions.from_config(Config())) is None
