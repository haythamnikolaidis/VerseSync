"""Engine tests. The model is always an injected fake: no weights are downloaded."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from versesync.engine import (
    ModelLoadError,
    ModelMetadata,
    TranscriptionCancelled,
    cuda_setup,
    load_model,
    quantization,
    transcribe_with_words,
)
from versesync.engine.loader import make_repo_string

ENGINE_DIR = Path(__file__).resolve().parents[1] / "sidecar" / "versesync" / "engine"


def _w(word: str, start: float | None, end: float | None, p: float = 0.9) -> Any:
    return SimpleNamespace(word=word, start=start, end=end, probability=p)


SEGMENTS = [
    SimpleNamespace(end=10.0, words=[_w(" Turn", 1.0, 1.3), _w(" with", 1.4, 1.6, 0.8)]),
    SimpleNamespace(
        end=20.0, words=[_w(" me", 11.0, 11.2), _w(" ", 11.3, 11.4), _w("x", None, 12)]
    ),
    SimpleNamespace(end=40.0, words=None),
]


class FakeModel:
    def __init__(self, segments: list[Any] = SEGMENTS, duration: float = 40.0) -> None:
        self.segments = segments
        self.duration = duration
        self.calls: list[dict[str, Any]] = []
        self.consumed = 0

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls.append({"audio": audio, **kwargs})

        def gen() -> Any:
            for seg in self.segments:
                self.consumed += 1
                yield seg

        info = SimpleNamespace(duration=self.duration, language="en", language_probability=0.99)
        return gen(), info


def test_words_carry_start_end_text_probability() -> None:
    t = transcribe_with_words(FakeModel(), "a.wav", language="en")
    assert [(w.text, w.start, w.end, w.probability) for w in t.words] == [
        ("Turn", 1.0, 1.3, 0.9),
        ("with", 1.4, 1.6, 0.8),
        ("me", 11.0, 11.2, 0.9),
    ]
    assert t.language == "en"
    assert t.duration == 40.0
    assert t.to_dict()["words"][0] == {"text": "Turn", "start": 1.0, "end": 1.3, "probability": 0.9}


def test_decoding_options_are_forwarded() -> None:
    model = FakeModel()
    transcribe_with_words(
        model,
        "a.wav",
        vad_parameters={"min_silence_duration_ms": 500},
        initial_prompt="prompt",
        language="en",
        condition_on_previous_text=False,
    )
    call = model.calls[0]
    assert call["word_timestamps"] is True
    assert call["temperature"] == 0.0
    assert call["vad_filter"] is True
    assert call["vad_parameters"] == {"min_silence_duration_ms": 500}
    assert call["initial_prompt"] == "prompt"
    assert call["language"] == "en"
    assert call["condition_on_previous_text"] is False


def test_progress_is_monotonic_and_completes() -> None:
    seen: list[float] = []
    transcribe_with_words(FakeModel(), "a.wav", progress=seen.append)
    assert seen == sorted(seen)
    assert seen == [0.25, 0.5, 1.0]


def test_progress_reaches_one_when_last_segment_ends_early() -> None:
    seen: list[float] = []
    transcribe_with_words(FakeModel(segments=SEGMENTS[:1]), "a.wav", progress=seen.append)
    assert seen[-1] == 1.0
    assert seen == sorted(seen)


def test_cancel_stops_between_segments() -> None:
    model = FakeModel()
    with pytest.raises(TranscriptionCancelled):
        transcribe_with_words(model, "a.wav", cancel=lambda: model.consumed >= 1)
    assert model.consumed == 1


def test_cancel_before_start_never_calls_the_model() -> None:
    model = FakeModel()
    with pytest.raises(TranscriptionCancelled):
        transcribe_with_words(model, "a.wav", cancel=lambda: True)
    assert model.calls == []


def test_runs_are_identical() -> None:
    a = transcribe_with_words(FakeModel(), "a.wav")
    b = transcribe_with_words(FakeModel(), "a.wav")
    assert a == b


def test_batched_path_uses_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    class FakePipeline:
        def __init__(self, model: Any) -> None:
            captured["model"] = model

        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            captured["kwargs"] = kwargs
            return captured["model"].transcribe(audio, **kwargs)

    fake_module = SimpleNamespace(BatchedInferencePipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)
    model = FakeModel()
    t = transcribe_with_words(model, "a.wav", batch_size=8)
    assert captured["model"] is model
    assert captured["kwargs"]["batch_size"] == 8
    assert "condition_on_previous_text" not in captured["kwargs"]
    assert len(t.words) == 3


def test_engine_runs_without_qt() -> None:
    code = (
        "import sys\n"
        "import versesync.engine as e\n"
        "from types import SimpleNamespace as N\n"
        "class M:\n"
        "    def transcribe(self, a, **k):\n"
        "        seg = N(end=1.0, words=[N(word=' hi', start=0.0, end=0.5, probability=1.0)])\n"
        "        return iter([seg]), N(duration=1.0, language='en', language_probability=1.0)\n"
        "assert len(e.transcribe_with_words(M(), 'x').words) == 1\n"
        "bad = [m for m in sys.modules if m.split('.')[0] in ('PySide6', 'PyQt5', 'PyQt6')]\n"
        "assert not bad, bad\n"
        "assert 'faster_whisper' not in sys.modules\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_no_qt_imports_in_source() -> None:
    for path in ENGINE_DIR.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        for needle in ("PySide", "PyQt", "QtCore", "QApplication"):
            assert needle not in text, f"{path.name} mentions {needle}"


def test_load_model_builds_repo_and_wraps_errors() -> None:
    made: list[tuple[str, dict[str, Any]]] = []

    def factory(repo: str, **kw: Any) -> str:
        made.append((repo, kw))
        return "model"

    assert load_model("large-v3-turbo", "float16", "cuda", 4, model_factory=factory) == "model"
    assert made[0][0] == "ctranslate2-4you/whisper-large-v3-turbo-ct2-float16"
    assert made[0][1] == {"device": "cuda", "compute_type": "float16", "cpu_threads": 4}

    def boom(repo: str, **kw: Any) -> Any:
        raise RuntimeError("out of memory")

    with pytest.raises(ModelLoadError, match="out of memory") as exc:
        load_model("large-v3", "float16", "cuda", 1, model_factory=boom)
    assert exc.value.code == "model_load_failed"


def test_repo_strings() -> None:
    assert make_repo_string("distil-large-v3", "float16") == "distil-large-v3"
    assert (
        make_repo_string("distil-whisper-large-v3", "float32")
        == "ctranslate2-4you/distil-whisper-large-v3-ct2-float32"
    )


def test_metadata_word_timestamp_quality() -> None:
    assert ModelMetadata.word_timestamp_quality("distil-large-v3") == "good"
    assert ModelMetadata.word_timestamp_quality("distil-whisper-large-v3") == "unverified"
    assert ModelMetadata.word_timestamp_quality("no-such-model") == "unverified"
    assert ModelMetadata.get_quantization_options("large-v3-turbo", "cpu", {}) == ["float32"]
    assert ModelMetadata.get_quantization_options(
        "large-v3", "cpu", {"cpu": ["float16", "float32"]}
    ) == ["float32"]


def test_quantization_probe_excludes_integer_types() -> None:
    ct2 = SimpleNamespace(
        get_supported_compute_types=lambda dev: ["int8", "float16", "float32"],
        get_cuda_device_count=lambda: 1,
    )
    assert quantization.supported_quantizations("cuda", ct2) == ["float16", "float32"]
    assert quantization.has_cuda_device(ct2) is True

    def fail(dev: str) -> Any:
        raise RuntimeError("no")

    broken = SimpleNamespace(get_supported_compute_types=fail, get_cuda_device_count=fail)
    assert quantization.supported_quantizations("cpu", broken) == ["float32"]
    assert quantization.supported_quantizations("cuda", broken) == []
    assert quantization.has_cuda_device(broken) is False


def test_cuda_setup_registers_libraries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = tmp_path / "nvidia"
    for p in cuda_setup._get_library_paths(base):
        p.mkdir(parents=True)
    monkeypatch.setattr(cuda_setup, "_get_nvidia_base_path", lambda: base)
    monkeypatch.setenv("LD_LIBRARY_PATH", "")
    monkeypatch.setenv("PATH", "")
    monkeypatch.setenv("CUDA_PATH", "")
    if sys.platform == "win32":
        monkeypatch.setattr(cuda_setup.os, "add_dll_directory", lambda p: None, raising=False)
    assert cuda_setup.setup_cuda_if_available() is True
    import os

    var = "PATH" if sys.platform == "win32" else "LD_LIBRARY_PATH"
    assert str(base / "cublas") in os.environ[var]


def test_cuda_setup_without_libraries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cuda_setup, "_get_nvidia_base_path", lambda: None)
    assert cuda_setup.setup_cuda_if_available() is False

    def boom() -> Path:
        raise OSError

    monkeypatch.setattr(cuda_setup, "_get_nvidia_base_path", boom)
    assert cuda_setup.setup_cuda_if_available() is False
