import dataclasses
import re
from pathlib import Path

import pytest

from versesync.config import Config, load_config
from versesync.pipeline import Cancelled
from versesync.transcribe import (
    SCRIPTURE_PROMPT,
    FakeBackend,
    FixtureBackend,
    TranscribeOptions,
    TranscriptionError,
    get_backend,
)
from versesync.types import Word, load_words

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "transcripts" / "context-and-ambiguity.words.json"


def test_fixture_backend_returns_words_with_monotonic_progress() -> None:
    seen: list[float] = []
    words, duration = FixtureBackend(FIXTURE).transcribe(
        Path("sermon.mp4"), TranscribeOptions(), seen.append, lambda: False
    )
    assert words == load_words(FIXTURE)
    assert duration == words[-1].end
    assert seen == sorted(seen)
    assert seen[-1] == 1.0


def test_cancel_raises_within_one_tick() -> None:
    seen: list[float] = []
    cancelled = False

    def progress(p: float) -> None:
        nonlocal cancelled
        seen.append(p)
        if len(seen) == 3:
            cancelled = True

    with pytest.raises(Cancelled):
        FixtureBackend(FIXTURE).transcribe(
            Path("x.mp4"), TranscribeOptions(), progress, lambda: cancelled
        )
    assert len(seen) == 3


def test_fake_backend_scripted_words_and_failure() -> None:
    words = [Word("hi", 0.0, 0.5, 0.9)]
    fake = FakeBackend(words)
    got, duration = fake.transcribe(Path("a"), TranscribeOptions(), lambda p: None, lambda: False)
    assert got == words and duration == 0.5 and len(fake.calls) == 1
    err = TranscriptionError("boom", "it broke", "retry")
    with pytest.raises(TranscriptionError) as info:
        FakeBackend(error=err).transcribe(
            Path("a"), TranscribeOptions(), lambda p: None, lambda: False
        )
    assert (info.value.code, info.value.message, info.value.hint) == ("boom", "it broke", "retry")


def test_cache_key_tracks_relevant_changes() -> None:
    base = TranscribeOptions()
    assert base.cache_key() == TranscribeOptions().cache_key()
    assert base.cache_key() != dataclasses.replace(base, model="large-v3").cache_key()
    assert base.cache_key() != dataclasses.replace(base, vad_filter=False).cache_key()
    a = dataclasses.replace(base, vad_parameters={"a": 1, "b": 2}).cache_key()
    b = dataclasses.replace(base, vad_parameters={"b": 2, "a": 1}).cache_key()
    assert a == b


def test_defaults_match_t02_table() -> None:
    o = TranscribeOptions()
    assert (o.model, o.device, o.quantization, o.language) == (
        "distil-large-v3",
        "cuda",
        "float16",
        "en",
    )
    assert o.vad_filter is True and o.condition_on_previous_text is True
    assert o.temperature == 0.0 and o.initial_prompt == SCRIPTURE_PROMPT


def test_config_defaults_agree_with_options(app_home: Path) -> None:
    assert TranscribeOptions.from_config(load_config()) == TranscribeOptions()


def test_scripture_prompt_matches_spec() -> None:
    doc = (ROOT / "docs" / "04-reference-detection.md").read_text(encoding="utf-8")
    block = re.search(r"SCRIPTURE_PROMPT = \((.*?)\n\)\n", doc, re.S)
    assert block is not None
    expected = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', block.group(1)))
    assert SCRIPTURE_PROMPT == expected


def test_get_backend_selection() -> None:
    assert isinstance(get_backend(Config(transcription={"backend": "fake"})), FakeBackend)
    fixture = get_backend(Config(transcription={"backend": f"fixture:{FIXTURE}"}))
    assert isinstance(fixture, FixtureBackend) and fixture.path == FIXTURE
    with pytest.raises(TranscriptionError) as info:
        get_backend(Config(transcription={"backend": "nope"}))
    assert info.value.code == "unknown_backend"


def test_fixture_selected_through_config(app_home: Path, tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(f"transcription:\n  backend: 'fixture:{FIXTURE.as_posix()}'\n")
    words, _ = get_backend(load_config(cfg_path)).transcribe(
        Path("m.mp4"), TranscribeOptions(), lambda p: None, lambda: False
    )
    assert words == load_words(FIXTURE)


def test_missing_fixture_is_a_transcription_error(tmp_path: Path) -> None:
    with pytest.raises(TranscriptionError) as info:
        FixtureBackend(tmp_path / "none.json").transcribe(
            Path("m"), TranscribeOptions(), lambda p: None, lambda: False
        )
    assert info.value.code == "fixture_missing"
