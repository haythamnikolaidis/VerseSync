"""Content hashing and transcript cache tests. Media is sparse/synthetic; the model is a fake."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from versesync import cache as cache_mod
from versesync import transcribe as tr
from versesync.cache import (
    HASH_SAMPLE_BYTES,
    TranscriptCache,
    cache_key,
    hash_media,
    peek,
    transcribe_cached,
)
from versesync.transcribe import TranscriptionSettings

MB = 1024 * 1024
GB = 1024 * MB
SETTINGS = TranscriptionSettings(batch_size=1)


@pytest.fixture(autouse=True)
def cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tr, "resolve_device", lambda d: "cuda" if d == "auto" else d)


class FakeModel:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls += 1
        words = [
            SimpleNamespace(word=" hello", start=1.0, end=1.4, probability=0.9),
            SimpleNamespace(word=" world", start=1.5, end=2.0, probability=0.7),
        ]
        segments = [SimpleNamespace(start=0.0, end=3.0, words=words)]
        info = SimpleNamespace(duration=3.0, language="en", language_probability=0.99)
        return iter(segments), info


def _media(tmp_path: Path, name: str = "a.mxf", size: int = 20 * MB, fill: bytes = b"x") -> Path:
    path = tmp_path / name
    path.write_bytes(fill * size)
    return path


def _sparse(tmp_path: Path, size: int, name: str = "big.mxf") -> Path:
    path = tmp_path / name
    with path.open("wb") as f:
        f.truncate(size)
    return path


# --- hashing ----------------------------------------------------------------------------


def test_hash_has_the_job_form_and_matches_the_definition(tmp_path: Path) -> None:
    path = tmp_path / "m.bin"
    data = bytes(range(256)) * (40 * 1024)  # 10 MB
    path.write_bytes(data)
    expected = hashlib.sha256(
        data[:HASH_SAMPLE_BYTES] + data[HASH_SAMPLE_BYTES:] + len(data).to_bytes(8, "little")
    ).hexdigest()
    assert hash_media(path) == f"sha256:{expected}"


def test_hash_is_stable_and_small_files_work(tmp_path: Path) -> None:
    small = tmp_path / "s.bin"
    small.write_bytes(b"abc")
    assert hash_media(small) == hash_media(small)
    empty = tmp_path / "e.bin"
    empty.write_bytes(b"")
    assert hash_media(empty).startswith("sha256:")
    assert hash_media(empty) != hash_media(small)


def test_hash_ignores_the_middle_of_the_file(tmp_path: Path) -> None:
    a = _sparse(tmp_path, 100 * MB, "a.bin")
    b = _sparse(tmp_path, 100 * MB, "b.bin")
    with b.open("r+b") as f:
        f.seek(50 * MB)
        f.write(b"middle edit")
    assert hash_media(a) == hash_media(b)


def test_head_tail_and_size_each_disambiguate(tmp_path: Path) -> None:
    base = _sparse(tmp_path, 100 * MB, "base.bin")
    head = _sparse(tmp_path, 100 * MB, "head.bin")
    tail = _sparse(tmp_path, 100 * MB, "tail.bin")
    longer = _sparse(tmp_path, 100 * MB + 1, "longer.bin")
    with head.open("r+b") as f:
        f.write(b"head")
    with tail.open("r+b") as f:
        f.seek(100 * MB - 4)
        f.write(b"tail")
    hashes = {hash_media(p) for p in (base, head, tail, longer)}
    assert len(hashes) == 4


def test_same_head_different_tail_and_size(tmp_path: Path) -> None:
    """Two takes from one camera share head bytes; the tail and size tell them apart."""
    head = b"MXF-HEADER" * 1000
    one = tmp_path / "one.mxf"
    two = tmp_path / "two.mxf"
    for path, tail in ((one, b"end-of-take-1"), (two, b"end-of-take-2")):
        with path.open("wb") as f:
            f.write(head)
            f.truncate(64 * MB - len(tail))
            f.seek(64 * MB - len(tail))
            f.write(tail)
    assert hash_media(one) != hash_media(two)


def test_hashing_a_4gb_file_is_fast(tmp_path: Path) -> None:
    path = _sparse(tmp_path, 4 * GB)
    started = time.perf_counter()
    result = hash_media(path)
    elapsed = time.perf_counter() - started
    assert result.startswith("sha256:")
    assert elapsed < 1.0


def test_hash_progress_is_monotonic_and_ends_at_one(tmp_path: Path) -> None:
    path = _sparse(tmp_path, 64 * MB)
    seen: list[float] = []
    hash_media(path, seen.append)
    assert seen == sorted(seen)
    assert seen[-1] == 1.0


# --- keys -------------------------------------------------------------------------------


def _key(**changes: Any) -> str:
    return cache_key("sha256:abc", dataclasses.replace(SETTINGS, **changes))


@pytest.mark.parametrize(
    "change",
    [
        {"model": "large-v3"},
        {"quantization": "int8"},
        {"device": "cpu"},
        {"language": None},
        {"vad_filter": False},
        {"vad_parameters": {"min_silence_duration_ms": 300}},
        {"scripture_prompt": False},
        {"batch_size": 16},
        {"condition_on_previous_text": False},
    ],
)
def test_every_transcript_option_changes_the_key(change: dict[str, Any]) -> None:
    assert _key(**change) != _key()


def test_media_hash_changes_the_key() -> None:
    assert cache_key("sha256:a", SETTINGS) != cache_key("sha256:b", SETTINGS)


def test_cpu_half_precision_shares_the_float32_entry() -> None:
    assert _key(device="cpu", quantization="float16") == _key(device="cpu", quantization="float32")


# --- cache behaviour --------------------------------------------------------------------


def test_second_run_hits_without_loading_a_model(tmp_path: Path) -> None:
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    model = FakeModel()

    first = transcribe_cached(media, SETTINGS, cache=store, model=model)
    assert first.cache_hit is False
    assert model.calls == 1

    started = time.perf_counter()
    second = transcribe_cached(media, SETTINGS, cache=store, model=None, model_factory=_boom)
    assert time.perf_counter() - started < 2.0
    assert second.cache_hit is True
    assert model.calls == 1
    assert second.media_hash == first.media_hash
    assert second.result.transcript == first.result.transcript
    assert [w.text for w in second.result.transcript.words] == ["hello", "world"]


def _boom(*_a: Any, **_k: Any) -> Any:
    raise AssertionError("the model must not be loaded on a cache hit")


def test_changing_the_model_misses(tmp_path: Path) -> None:
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    transcribe_cached(media, SETTINGS, cache=store, model=FakeModel())
    other = dataclasses.replace(SETTINGS, model="large-v3")
    assert peek(media, other, store)[1] is False
    model = FakeModel()
    result = transcribe_cached(media, other, cache=store, model=model)
    assert result.cache_hit is False
    assert model.calls == 1


def test_detection_only_options_still_hit(tmp_path: Path) -> None:
    """``context_window_s`` is a detection option: it is not a field of the transcript key."""
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    job_options = {"model": "distil-large-v3", "detection": {"context_window_s": 120}}
    changed = {"model": "distil-large-v3", "detection": {"context_window_s": 45}}

    def settings_for(options: dict[str, Any]) -> TranscriptionSettings:
        return TranscriptionSettings.from_config({"batch_size": 1}, options)

    transcribe_cached(media, settings_for(job_options), cache=store, model=FakeModel())
    assert peek(media, settings_for(changed), store)[1] is True


def test_use_cache_false_forces_retranscription(tmp_path: Path) -> None:
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    model = FakeModel()
    transcribe_cached(media, SETTINGS, cache=store, model=model)
    forced = transcribe_cached(media, SETTINGS, cache=store, use_cache=False, model=model)
    assert forced.cache_hit is False
    assert model.calls == 2
    assert transcribe_cached(media, SETTINGS, cache=store, model=model).cache_hit is True


def test_peek_reports_what_post_jobs_returns(tmp_path: Path) -> None:
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    media_hash, hit = peek(media, SETTINGS, store)
    assert hit is False
    assert media_hash == hash_media(media)
    transcribe_cached(media, SETTINGS, cache=store, model=FakeModel())
    assert peek(media, SETTINGS, store) == (media_hash, True)


def test_a_different_recording_misses(tmp_path: Path) -> None:
    store = TranscriptCache(tmp_path / "cache")
    one = _media(tmp_path, "one.mxf", fill=b"1")
    two = _media(tmp_path, "two.mxf", fill=b"2")
    transcribe_cached(one, SETTINGS, cache=store, model=FakeModel())
    assert peek(two, SETTINGS, store)[1] is False


def test_corrupt_entry_is_a_miss_and_is_replaced(tmp_path: Path) -> None:
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    transcribe_cached(media, SETTINGS, cache=store, model=FakeModel())
    (entry,) = (tmp_path / "cache").glob("*.json")
    entry.write_text("{not json", encoding="utf-8")
    model = FakeModel()
    again = transcribe_cached(media, SETTINGS, cache=store, model=model)
    assert again.cache_hit is False
    assert json.loads(entry.read_text(encoding="utf-8"))["format"] == cache_mod.CACHE_FORMAT


def test_cache_persists_in_the_app_dir_across_instances(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VERSESYNC_HOME", str(tmp_path / "home"))
    media = _media(tmp_path)
    transcribe_cached(media, SETTINGS, model=FakeModel())
    assert list((tmp_path / "home" / "cache" / "transcripts").glob("*.json"))
    assert transcribe_cached(media, SETTINGS, model=None, model_factory=_boom).cache_hit is True


def test_progress_ends_at_one_on_a_hit_with_renormalised_weights(tmp_path: Path) -> None:
    media = _media(tmp_path)
    store = TranscriptCache(tmp_path / "cache")
    transcribe_cached(media, SETTINGS, cache=store, model=FakeModel())
    seen: list[float] = []
    transcribe_cached(media, SETTINGS, cache=store, progress=lambda _p, o: seen.append(o))
    assert seen == sorted(seen)
    assert seen[-1] == pytest.approx(
        tr.PHASE_WEIGHTS["hashing"] / (1 - tr.PHASE_WEIGHTS["transcribing"])
    )
    # The remaining phases carry the bar the rest of the way to exactly 1.0.
    assert tr.overall_progress("timing", 1.0, cache_hit=True) == pytest.approx(1.0)
