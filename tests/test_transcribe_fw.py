"""FasterWhisperBackend (T-07.2) with the upstream package and torch faked: no GPU needed.

The fake upstream (``core.cuda_setup``, ``core.models.loader``, ``core.transcription.engine``)
is served by a meta path finder, so the tests also see *when* each module is imported.
"""

import importlib.abc
import importlib.machinery
import logging
import re
import sys
import tomllib
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from versesync.config import Config
from versesync.pipeline import Cancelled
from versesync.transcribe import (
    FasterWhisperBackend,
    TranscribeOptions,
    TranscriptionError,
    get_backend,
)
from versesync.types import Word

ROOT = Path(__file__).resolve().parent.parent
GIB = 1024**3
MEDIA = Path("sermon.mp4")
UPSTREAM_MODULES = (
    "core",
    "core.cuda_setup",
    "core.models",
    "core.models.loader",
    "core.transcription",
    "core.transcription.engine",
)


class UpstreamCancelled(Exception):
    """Stands in for core.transcription.engine.Cancelled."""


class UpstreamModelLoadError(Exception):
    """Stands in for core.exceptions.ModelLoadError, which the upstream loader raises."""


@dataclass
class UpstreamWord:
    start: float
    end: float
    text: str
    probability: float


@dataclass
class UpstreamTranscript:
    words: list[UpstreamWord]
    language: str
    duration: float


@dataclass
class FakeUpstream(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Serves the three upstream modules and records every import and call, in order."""

    log: list[str] = field(default_factory=list)
    load_calls: list[tuple[str, str, str]] = field(default_factory=list)
    transcribe_calls: list[dict[str, Any]] = field(default_factory=list)
    load_error: BaseException | None = None
    transcribe_error: BaseException | None = None
    on_transcribe: Callable[[dict[str, Any]], None] | None = None
    words: list[UpstreamWord] = field(
        default_factory=lambda: [
            UpstreamWord(0.0, 0.4, " Let's", 0.9),
            UpstreamWord(0.4, 0.8, " look", 0.8),
            UpstreamWord(0.8, 1.2, " at", 0.7),
        ]
    )
    duration: float = 12.5

    def __post_init__(self) -> None:
        self.modules = {name: ModuleType(name) for name in UPSTREAM_MODULES}
        vars(self.modules["core.cuda_setup"]).update(setup_cuda_if_available=self._setup_cuda)
        vars(self.modules["core.models.loader"]).update(load_model=self._load_model)
        vars(self.modules["core.transcription.engine"]).update(
            Cancelled=UpstreamCancelled, transcribe_with_words=self._transcribe_with_words
        )

    def find_spec(
        self, fullname: str, path: Any = None, target: Any = None
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname not in self.modules:
            return None
        self.log.append(f"import {fullname}")
        is_package = fullname in ("core", "core.models", "core.transcription")
        return importlib.machinery.ModuleSpec(fullname, self, is_package=is_package)

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
        return self.modules[spec.name]

    def exec_module(self, module: ModuleType) -> None:
        pass

    def _setup_cuda(self) -> bool:
        self.log.append("cuda_setup")
        return True

    def _load_model(self, name: str, quantization: str, device: str) -> object:
        self.log.append("load_model")
        self.load_calls.append((name, quantization, device))
        if self.load_error is not None:
            raise self.load_error
        return object()

    def _transcribe_with_words(
        self, model: object, audio_path: Path, **kwargs: Any
    ) -> UpstreamTranscript:
        self.log.append("transcribe_with_words")
        self.transcribe_calls.append({"audio_path": audio_path, **kwargs})
        if self.on_transcribe is not None:
            self.on_transcribe(kwargs)
        if self.transcribe_error is not None:
            raise self.transcribe_error
        return UpstreamTranscript(list(self.words), "en", self.duration)


def _drop_upstream_modules() -> None:
    for name in list(sys.modules):
        if name == "core" or name.startswith("core."):
            del sys.modules[name]


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeUpstream]:
    fake = FakeUpstream()
    _drop_upstream_modules()
    monkeypatch.setattr(sys, "meta_path", [fake, *sys.meta_path])
    yield fake
    _drop_upstream_modules()


def fake_gpu(monkeypatch: pytest.MonkeyPatch, free_gib: float, total_gib: float) -> None:
    """A ``torch`` whose ``cuda.mem_get_info`` reports the given free and total memory."""
    torch = SimpleNamespace(
        cuda=SimpleNamespace(mem_get_info=lambda: (int(free_gib * GIB), int(total_gib * GIB)))
    )
    monkeypatch.setitem(sys.modules, "torch", torch)


def no_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)  # makes ``import torch`` raise ImportError


def run(
    opts: TranscribeOptions | None = None,
    progress: Callable[[float], None] = lambda p: None,
    is_cancelled: Callable[[], bool] = lambda: False,
) -> tuple[list[Word], float]:
    return FasterWhisperBackend().transcribe(
        MEDIA, opts or TranscribeOptions(), progress, is_cancelled
    )


def out_of_memory(message: str = "CUDA failed with error out of memory") -> Exception:
    """What the upstream loader raises: its own error, chained from the real one."""
    error = UpstreamModelLoadError(f"Error loading model repo: {message}")
    error.__cause__ = RuntimeError(message)
    return error


def test_cuda_setup_runs_before_anything_else_from_upstream_is_used(
    upstream: FakeUpstream,
) -> None:
    run()
    log = upstream.log
    before_setup = log[: log.index("cuda_setup")]
    # Importing core.models.loader loads ctranslate2, so only the package that holds
    # core.cuda_setup may be imported before the CUDA paths are set.
    assert set(before_setup) <= {"import core", "import core.cuda_setup"}
    assert log.index("import core.models.loader") > log.index("cuda_setup")
    assert log.index("import core.transcription.engine") > log.index("cuda_setup")
    assert log.index("cuda_setup") < log.index("load_model") < log.index("transcribe_with_words")


def test_options_reach_the_engine_and_curate_text_is_never_passed(
    upstream: FakeUpstream,
) -> None:
    opts = TranscribeOptions(
        model="large-v3-turbo",
        device="cuda",
        quantization="float16",
        batch_size=4,
        language="en",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        initial_prompt="A sermon.",
        condition_on_previous_text=False,
        temperature=0.0,
    )
    seen: list[float] = []

    def cancelled() -> bool:
        return False

    run(opts, seen.append, cancelled)

    assert upstream.load_calls == [("large-v3-turbo", "float16", "cuda")]
    (call,) = upstream.transcribe_calls
    assert call.pop("progress") is not None
    assert call.pop("cancel") is cancelled
    assert call == {
        "audio_path": MEDIA,
        "batch_size": 4,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500},
        "initial_prompt": "A sermon.",
        "language": "en",
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }


def test_defaults_load_the_model_the_upstream_loader_knows(upstream: FakeUpstream) -> None:
    run()
    # VerseSync's distil-large-v3 is the upstream distil-whisper-large-v3.
    assert upstream.load_calls == [("distil-whisper-large-v3", "float16", "cuda")]


def test_words_and_duration_are_mapped(upstream: FakeUpstream) -> None:
    words, duration = run()
    assert words == [
        Word(text="Let's", start=0.0, end=0.4, probability=0.9),
        Word(text="look", start=0.4, end=0.8, probability=0.8),
        Word(text="at", start=0.8, end=1.2, probability=0.7),
    ]
    assert all(type(w) is Word for w in words)
    assert duration == 12.5


def test_progress_is_passed_through(upstream: FakeUpstream) -> None:
    def report(kwargs: dict[str, Any]) -> None:
        for fraction in (0.25, 0.5, 1.0):
            kwargs["progress"](fraction)

    upstream.on_transcribe = report
    seen: list[float] = []
    run(progress=seen.append)
    assert seen == [0.25, 0.5, 1.0]


def test_cancellation_inside_the_engine_raises_cancelled(upstream: FakeUpstream) -> None:
    upstream.transcribe_error = UpstreamCancelled("Transcription cancelled")
    with pytest.raises(Cancelled):
        run()


def test_a_cpu_run_is_warned_about_in_the_log(
    upstream: FakeUpstream, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="versesync.transcribe"):
        run(TranscribeOptions(device="cuda"))
        assert caplog.records == []
        run(TranscribeOptions(device="cpu", quantization="float32"))
    (record,) = caplog.records
    assert "on the CPU" in record.getMessage() and MEDIA.name in record.getMessage()


def test_cancelled_before_start_touches_nothing(upstream: FakeUpstream) -> None:
    with pytest.raises(Cancelled):
        run(is_cancelled=lambda: True)
    assert upstream.log == []


def test_out_of_memory_message_has_the_documented_shape(
    upstream: FakeUpstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_gpu(monkeypatch, free_gib=2.0, total_gib=12.0)
    upstream.load_error = out_of_memory()
    with pytest.raises(TranscriptionError) as info:
        run(TranscribeOptions(model="large-v3", quantization="float16", batch_size=8))
    error = info.value
    assert error.code == "model_load_failed"
    # 3.1 GB of weights at float16, plus the fixed overhead and 7 further batch items.
    assert error.message == (
        "Could not load large-v3 on cuda: out of memory (2.0 GB free, ~5.8 GB required)"
    )
    assert re.fullmatch(
        r"Could not load \S+ on \S+: out of memory \(\d+\.\d GB free, ~\d+\.\d GB required\)",
        error.message,
    )
    assert error.hint is not None and "12.0 GB" in error.hint


@pytest.mark.parametrize(
    "raised",
    [
        RuntimeError("CUDA out of memory. Tried to allocate 1.2 GiB"),
        MemoryError(),
    ],
)
def test_out_of_memory_while_transcribing_gets_the_same_message(
    upstream: FakeUpstream, monkeypatch: pytest.MonkeyPatch, raised: Exception
) -> None:
    fake_gpu(monkeypatch, free_gib=0.5, total_gib=8.0)
    upstream.transcribe_error = raised
    with pytest.raises(TranscriptionError) as info:
        run(TranscribeOptions(model="large-v3-turbo", batch_size=16))
    assert info.value.code == "model_load_failed"
    assert info.value.message == (
        "Could not load large-v3-turbo on cuda: out of memory (0.5 GB free, ~6.0 GB required)"
    )


def test_out_of_memory_without_gpu_figures_omits_them(
    upstream: FakeUpstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    upstream.load_error = out_of_memory()
    no_torch(monkeypatch)
    with pytest.raises(TranscriptionError) as info:
        run(TranscribeOptions(model="large-v3"))
    assert info.value.message == "Could not load large-v3 on cuda: out of memory"

    fake_gpu(monkeypatch, free_gib=2.0, total_gib=12.0)
    with pytest.raises(TranscriptionError) as info:
        run(TranscribeOptions(model="mystery-model"))
    assert info.value.message == "Could not load mystery-model on cuda: out of memory"

    with pytest.raises(TranscriptionError) as info:
        run(TranscribeOptions(model="large-v3", device="cpu", quantization="float32"))
    assert info.value.message == "Could not load large-v3 on cpu: out of memory"


def test_other_load_failure_keeps_its_reason(upstream: FakeUpstream) -> None:
    error = UpstreamModelLoadError("Error loading model repo: Requested float16 compute type")
    error.__cause__ = ValueError("Requested float16 compute type, but the device lacks it.\nMore.")
    upstream.load_error = error
    with pytest.raises(TranscriptionError) as info:
        run(TranscribeOptions(model="large-v3", device="cpu"))
    assert info.value.code == "model_load_failed"
    assert info.value.message == (
        "Could not load large-v3 on cpu: Requested float16 compute type, but the device lacks it."
    )


def test_other_transcription_failure_is_transcription_failed(upstream: FakeUpstream) -> None:
    upstream.transcribe_error = ValueError("Invalid data found when processing input")
    with pytest.raises(TranscriptionError) as info:
        run()
    assert info.value.code == "transcription_failed"
    assert info.value.message == "Invalid data found when processing input"


def test_unreadable_media_stays_an_oserror_for_the_job_runner(upstream: FakeUpstream) -> None:
    upstream.transcribe_error = FileNotFoundError("sermon.mp4")
    with pytest.raises(FileNotFoundError):
        run()


def test_missing_upstream_is_backend_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "core", None)  # makes ``import core.*`` raise ImportError
    with pytest.raises(TranscriptionError) as info:
        run()
    assert info.value.code == "backend_unavailable"


def test_backend_unavailable_names_a_missing_dependency(
    upstream: FakeUpstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    # T-07.H: the upstream loader imports psutil, which its package does not declare.
    monkeypatch.setitem(sys.modules, "core.models.loader", None)
    with pytest.raises(TranscriptionError) as info:
        run()
    assert info.value.code == "backend_unavailable"
    assert "missing module: core.models.loader" in info.value.message


def test_get_backend_returns_the_adapter_when_the_upstream_is_installed(
    upstream: FakeUpstream,
) -> None:
    backend = get_backend(Config(transcription={"backend": "faster_whisper"}))
    assert isinstance(backend, FasterWhisperBackend)
    assert "cuda_setup" not in upstream.log  # choosing the backend does not touch CUDA


def test_get_backend_without_the_upstream_is_backend_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "core", None)  # makes ``import core.*`` raise ImportError
    with pytest.raises(TranscriptionError) as info:
        get_backend(Config(transcription={"backend": "faster_whisper"}))
    assert info.value.code == "backend_unavailable"


def test_transcribe_extra_pins_faster_whisper_and_the_upstream_commit() -> None:
    with (ROOT / "pyproject.toml").open("rb") as f:
        extra = tomllib.load(f)["project"]["optional-dependencies"]["transcribe"]
    assert any(re.fullmatch(r"faster-whisper==\d+(\.\d+)+", dep) for dep in extra)
    assert any(
        re.fullmatch(
            r"faster-whisper-transcriber @ git\+https://github\.com/"
            r"haythamnikolaidis/Faster-Whisper-Transcriber\.git@[0-9a-f]{40}",
            dep,
        )
        for dep in extra
    )
