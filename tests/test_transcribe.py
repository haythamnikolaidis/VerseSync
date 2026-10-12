"""Sidecar transcription tests. The model is always an injected fake: no weights, no GPU."""

from __future__ import annotations

import json
import random
import re
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from versesync import transcribe as tr
from versesync.config import load_config
from versesync.engine import ModelLoadError, TranscriptionCancelled
from versesync.transcribe import (
    PHASE_WEIGHTS,
    SCRIPTURE_PROMPT,
    ModelLoadFailed,
    TranscriptionSettings,
    overall_progress,
    transcribe_media,
)

SERMON_S = 45 * 60.0
SEGMENT_S = 30.0


def _segments(count: int, delay: float = 0.0) -> Any:
    for i in range(count):
        if delay:
            time.sleep(delay)
        start = i * SEGMENT_S
        words = [
            SimpleNamespace(word=f" w{i}a", start=start + 1.0, end=start + 1.4, probability=0.9),
            SimpleNamespace(word=f" w{i}b", start=start + 1.5, end=start + 2.0, probability=0.7),
        ]
        yield SimpleNamespace(start=start, end=start + SEGMENT_S, words=words)


class FakeModel:
    def __init__(self, duration: float = SERMON_S, delay: float = 0.0) -> None:
        self.duration = duration
        self.delay = delay
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls.append({"audio": audio, **kwargs})
        info = SimpleNamespace(duration=self.duration, language="en", language_probability=0.99)
        return _segments(int(self.duration // SEGMENT_S), self.delay), info


@pytest.fixture
def gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tr, "resolve_device", lambda d: "cuda" if d == "auto" else d)


UNBATCHED = TranscriptionSettings(batch_size=1)


# --- defaults ---------------------------------------------------------------------------


def test_defaults_follow_the_owner_decision() -> None:
    s = TranscriptionSettings()
    assert (s.model, s.quantization) == ("distil-large-v3", "float16")
    assert s.vad_filter is True
    assert s.scripture_prompt is True
    assert s.condition_on_previous_text is True
    assert s.language == "en"


def test_config_defaults_match_settings_defaults(tmp_path: Path) -> None:
    config = load_config(tmp_path / "missing.yaml", env={})
    assert TranscriptionSettings.from_config(config.transcription) == TranscriptionSettings()


def test_from_config_applies_overrides_and_ignores_unknown_keys() -> None:
    s = TranscriptionSettings.from_config(
        {"model": "large-v3", "unrelated": 1}, {"language": None, "batch_size": 4}
    )
    assert (s.model, s.language, s.batch_size) == ("large-v3", None, 4)


def test_decode_options_are_deterministic_and_biased(gpu: None) -> None:
    model = FakeModel(duration=60)
    transcribe_media("a.wav", UNBATCHED, model=model)
    call = model.calls[0]
    assert call["temperature"] == 0.0  # a float disables the fallback ladder
    assert call["vad_filter"] is True
    assert call["language"] == "en"
    assert call["initial_prompt"] == SCRIPTURE_PROMPT
    assert call["condition_on_previous_text"] is True
    assert call["word_timestamps"] is True


def test_prompt_can_be_turned_off(gpu: None) -> None:
    model = FakeModel(duration=60)
    transcribe_media(
        "a.wav", TranscriptionSettings(batch_size=1, scripture_prompt=False), model=model
    )
    assert model.calls[0]["initial_prompt"] is None


def test_prompt_lists_the_books_and_fits_the_window() -> None:
    for book in ("Genesis", "Obadiah", "Song of Solomon", "3 John", "Revelation"):
        assert book in SCRIPTURE_PROMPT
    # Coarse token estimate (words and punctuation); Whisper's window is 224 tokens.
    assert len(re.findall(r"\w+|[^\w\s]", SCRIPTURE_PROMPT)) < 224


def test_batched_pipeline_is_used_by_default(gpu: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    class FakePipeline:
        def __init__(self, model: Any) -> None:
            self.model = model

        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            captured.update(kwargs)
            return self.model.transcribe(audio, **kwargs)

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(BatchedInferencePipeline=FakePipeline)
    )
    transcribe_media("a.wav", model=FakeModel(duration=60))
    assert captured["batch_size"] == 8


# --- long audio: words, progress, cancellation, determinism ------------------------------


def test_45_minute_fake_run_emits_every_word_with_probability(gpu: None) -> None:
    result = transcribe_media("a.wav", UNBATCHED, model=FakeModel())
    words = result.transcript.words
    assert len(words) == 90 * 2
    assert words[0].text == "w0a"
    assert words[1].probability == 0.7
    assert result.transcript.duration == SERMON_S


def test_progress_is_monotonic_and_mapped_into_the_transcribing_weight(gpu: None) -> None:
    seen: list[tuple[float, float]] = []
    transcribe_media(
        "a.wav",
        UNBATCHED,
        model=FakeModel(),
        progress=lambda phase, overall: seen.append((phase, overall)),
    )
    phases = [p for p, _ in seen]
    overalls = [o for _, o in seen]
    assert phases == sorted(phases) and overalls == sorted(overalls)
    assert len(seen) == 90
    assert phases[-1] == 1.0
    assert overalls[0] > PHASE_WEIGHTS["hashing"]
    assert overalls[-1] == pytest.approx(PHASE_WEIGHTS["hashing"] + PHASE_WEIGHTS["transcribing"])


def test_overall_progress_weights_and_cache_hit_renormalisation() -> None:
    assert sum(PHASE_WEIGHTS.values()) == pytest.approx(1.0)
    assert overall_progress("hashing", 0.0) == 0.0
    assert overall_progress("transcribing", 0.0) == pytest.approx(0.02)
    assert overall_progress("transcribing", 1.0) == pytest.approx(0.82)
    assert overall_progress("detecting", 0.0, cache_hit=True) == pytest.approx(0.02 / 0.20)
    assert overall_progress("timing", 1.0, cache_hit=True) == pytest.approx(1.0)
    with pytest.raises(ValueError):
        overall_progress("transcribing", 0.5, cache_hit=True)


def test_cancel_takes_effect_within_five_seconds(gpu: None) -> None:
    flag = threading.Event()
    timer = threading.Timer(0.3, flag.set)
    timer.start()
    started = time.monotonic()
    with pytest.raises(TranscriptionCancelled):
        transcribe_media("a.wav", UNBATCHED, model=FakeModel(delay=0.02), cancel=flag.is_set)
    assert time.monotonic() - started - 0.3 < 5.0
    timer.join()


def test_cancel_before_loading_never_loads_a_model(gpu: None) -> None:
    def factory(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("model must not be loaded")

    with pytest.raises(TranscriptionCancelled):
        transcribe_media("a.wav", model_factory=factory, cancel=lambda: True)


def test_two_runs_are_identical(gpu: None) -> None:
    a = transcribe_media("a.wav", UNBATCHED, model=FakeModel())
    b = transcribe_media("a.wav", UNBATCHED, model=FakeModel())
    assert json.dumps(a.transcript.to_dict()) == json.dumps(b.transcript.to_dict())


def test_seed_is_applied_before_decoding(gpu: None) -> None:
    transcribe_media("a.wav", TranscriptionSettings(batch_size=1, seed=7), model=FakeModel(60))
    first = random.random()
    random.seed(7)
    assert first == random.random()


# --- ordering and loading ----------------------------------------------------------------


def test_cuda_setup_runs_before_device_probe_and_model_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    monkeypatch.setattr(tr, "setup_cuda_if_available", lambda: order.append("cuda_setup") or True)
    monkeypatch.setattr(tr, "resolve_device", lambda d: order.append("device") or "cuda")

    def factory(repo: str, **kwargs: Any) -> Any:
        order.append("load")
        return FakeModel(duration=30)

    transcribe_media("a.wav", UNBATCHED, model_factory=factory)
    assert order == ["cuda_setup", "device", "load"]


def test_model_is_loaded_with_the_resolved_repo_device_and_quantization(gpu: None) -> None:
    made: list[tuple[str, dict[str, Any]]] = []

    def factory(repo: str, **kwargs: Any) -> Any:
        made.append((repo, kwargs))
        return FakeModel(duration=30)

    transcribe_media("a.wav", UNBATCHED, model_factory=factory)
    assert made[0][0] == "distil-large-v3"
    assert made[0][1]["device"] == "cuda"
    assert made[0][1]["compute_type"] == "float16"


# --- model_load_failed -------------------------------------------------------------------


def _oom_factory(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("CUDA failed with error out of memory")


def test_forced_oom_gives_an_editor_readable_message(gpu: None) -> None:
    with pytest.raises(ModelLoadFailed) as caught:
        transcribe_media(
            "a.wav",
            TranscriptionSettings(model="large-v3", batch_size=1),
            model_factory=_oom_factory,
            vram_probe=lambda: 9.1,
        )
    e = caught.value
    assert e.code == "model_load_failed"
    assert isinstance(e, ModelLoadError)
    assert str(e) == (
        "Could not load large-v3 on cuda: out of memory (9.1 GB free, ~10.4 GB required)"
    )
    assert "distil-large-v3" in e.hint
    assert e.retryable is True
    assert "out of memory" in e.detail
    assert "Traceback" not in str(e)


def test_oom_without_known_figures_omits_them(gpu: None) -> None:
    with pytest.raises(ModelLoadFailed) as caught:
        transcribe_media(
            "a.wav", UNBATCHED, model_factory=_oom_factory, vram_probe=lambda: None
        )
    assert str(caught.value) == "Could not load distil-large-v3 on cuda: out of memory"


def test_non_oom_load_failure_is_typed_and_not_retryable(gpu: None) -> None:
    def missing(*args: Any, **kwargs: Any) -> Any:
        raise FileNotFoundError("model.bin")

    with pytest.raises(ModelLoadFailed) as caught:
        transcribe_media("a.wav", model_factory=missing)
    assert caught.value.retryable is False
    assert "out of memory" not in str(caught.value)
    assert "FileNotFoundError" in caught.value.detail


# --- CPU ---------------------------------------------------------------------------------


def test_long_cpu_run_warns_and_downgrades_float16(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tr, "resolve_device", lambda d: "cpu")
    result = transcribe_media(
        "a.wav", UNBATCHED, model=FakeModel(duration=60), duration_probe=lambda p: SERMON_S
    )
    assert result.device == "cpu" and result.quantization == "float32"
    assert any("float16" in w for w in result.warnings)
    assert any("45 minutes" in w and "CPU" in w for w in result.warnings)


def test_short_cpu_run_does_not_warn_about_length(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tr, "resolve_device", lambda d: "cpu")
    result = transcribe_media(
        "a.wav",
        TranscriptionSettings(batch_size=1, quantization="float32"),
        model=FakeModel(duration=60),
        duration_probe=lambda p: 120.0,
    )
    assert result.warnings == []


def test_gpu_run_never_probes_duration(gpu: None) -> None:
    def boom(path: Path) -> float:
        raise AssertionError("not needed on GPU")

    transcribe_media("a.wav", UNBATCHED, model=FakeModel(60), duration_probe=boom)


# --- CLI ---------------------------------------------------------------------------------


def test_cli_prints_the_word_array(
    gpu: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("VERSESYNC_HOME", str(tmp_path))
    monkeypatch.setattr(tr, "load_model", lambda *a, **k: FakeModel(duration=60))
    assert tr.main(["a.wav", "--batch-size", "1"]) == 0
    out = capsys.readouterr()
    data = json.loads(out.out)
    assert data["words"][0] == {"text": "w0a", "start": 1.0, "end": 1.4, "probability": 0.9}
    assert "progress" in out.err


def test_cli_reports_load_failure(
    gpu: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("VERSESYNC_HOME", str(tmp_path))

    def fail(*args: Any, **kwargs: Any) -> Any:
        raise ModelLoadError("x")

    monkeypatch.setattr(tr, "load_model", fail)
    assert tr.main(["a.wav"]) == 2
    assert "Could not load" in capsys.readouterr().err
