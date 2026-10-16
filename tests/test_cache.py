from __future__ import annotations

import hashlib
import time
from pathlib import Path

from versesync.cache import CHUNK, TranscriptCache, hash_media
from versesync.transcribe import TranscribeOptions
from versesync.types import Word


def test_small_file_is_hashed_whole(tmp_path: Path) -> None:
    f = tmp_path / "a.bin"
    data = b"hello world" * 100
    f.write_bytes(data)
    expected = hashlib.sha256(data + len(data).to_bytes(8, "little")).hexdigest()
    assert hash_media(f) == "sha256:" + expected


def test_small_file_content_change_changes_hash(tmp_path: Path) -> None:
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    a.write_bytes(b"x" * 1000)
    b.write_bytes(b"x" * 999 + b"y")
    assert hash_media(a) != hash_media(b)


def test_progress_reaches_one(tmp_path: Path) -> None:
    f = tmp_path / "a.bin"
    f.write_bytes(b"z" * 5000)
    seen: list[float] = []
    hash_media(f, seen.append)
    assert seen[-1] == 1.0
    assert all(0.0 <= v <= 1.0 for v in seen)


def test_large_sparse_file_hashes_fast(tmp_path: Path) -> None:
    f = tmp_path / "big.mxf"
    with f.open("wb") as h:
        h.truncate(4 * 1024**3)
    start = time.perf_counter()
    digest = hash_media(f)
    assert time.perf_counter() - start < 1.0
    assert digest.startswith("sha256:")
    head = bytes(CHUNK)
    expected = hashlib.sha256(head + head + (4 * 1024**3).to_bytes(8, "little")).hexdigest()
    assert digest == "sha256:" + expected


def test_same_head_and_size_different_tail_differ(tmp_path: Path) -> None:
    size = 3 * CHUNK
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    for p in (a, b):
        with p.open("wb") as h:
            h.truncate(size)
    with b.open("r+b") as h:
        h.seek(size - 10)
        h.write(b"tail-edit!")
    assert hash_media(a) != hash_media(b)


def test_middle_edit_is_not_seen(tmp_path: Path) -> None:
    size = 4 * CHUNK
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    for p in (a, b):
        with p.open("wb") as h:
            h.truncate(size)
    with b.open("r+b") as h:
        h.seek(2 * CHUNK)
        h.write(b"x")
    assert hash_media(a) == hash_media(b)


def test_same_content_different_size_differ(tmp_path: Path) -> None:
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    for p, size in ((a, 3 * CHUNK), (b, 3 * CHUNK + 1)):
        with p.open("wb") as h:
            h.truncate(size)
    assert hash_media(a) != hash_media(b)


WORDS = [Word("for", 0.0, 0.25, 0.9), Word("God", 0.25, 0.5, 0.95)]


def test_put_then_get_hits(tmp_path: Path) -> None:
    cache = TranscriptCache(tmp_path / "c")
    opts = TranscribeOptions()
    assert cache.get("sha256:aa", opts) is None
    cache.put("sha256:aa", opts, WORDS, 12.5)
    assert cache.get("sha256:aa", opts) == (WORDS, 12.5)


def test_different_model_misses(tmp_path: Path) -> None:
    cache = TranscriptCache(tmp_path / "c")
    cache.put("sha256:aa", TranscribeOptions(), WORDS, 1.0)
    assert cache.get("sha256:aa", TranscribeOptions(model="large-v3")) is None


def test_different_media_misses(tmp_path: Path) -> None:
    cache = TranscriptCache(tmp_path / "c")
    cache.put("sha256:aa", TranscribeOptions(), WORDS, 1.0)
    assert cache.get("sha256:bb", TranscribeOptions()) is None


def test_detection_only_option_still_hits(tmp_path: Path) -> None:
    cache = TranscriptCache(tmp_path / "c")
    opts = TranscribeOptions()
    cache.put("sha256:aa", opts, WORDS, 1.0)
    # context_window_s is a detection option, so it is not part of cache_key().
    assert "context_window_s" not in opts.cache_key()
    assert cache.key("sha256:aa", opts) == cache.key("sha256:aa", TranscribeOptions())
    assert cache.get("sha256:aa", TranscribeOptions()) is not None


def test_survives_new_instance(tmp_path: Path) -> None:
    TranscriptCache(tmp_path / "c").put("sha256:aa", TranscribeOptions(), WORDS, 3.0)
    assert TranscriptCache(tmp_path / "c").get("sha256:aa", TranscribeOptions()) == (WORDS, 3.0)


def test_default_root_is_under_app_home(app_home: Path) -> None:
    cache = TranscriptCache()
    cache.put("sha256:aa", TranscribeOptions(), WORDS, 1.0)
    assert cache.root == app_home / "cache" / "transcripts"
    assert any(cache.root.glob("*.json"))


def test_entry_records_options_and_schema_version(tmp_path: Path) -> None:
    import json

    cache = TranscriptCache(tmp_path / "c")
    opts = TranscribeOptions()
    cache.put("sha256:aa", opts, WORDS, 1.0)
    (entry,) = (tmp_path / "c").glob("*.json")
    raw = json.loads(entry.read_text(encoding="utf-8"))
    assert raw["schema_version"] == 1
    assert raw["options"] == opts.cache_key()
    assert not list((tmp_path / "c").glob(".tmp-*"))


def test_corrupt_entry_is_a_miss(tmp_path: Path) -> None:
    cache = TranscriptCache(tmp_path / "c")
    opts = TranscribeOptions()
    cache.put("sha256:aa", opts, WORDS, 1.0)
    (entry,) = (tmp_path / "c").glob("*.json")
    entry.write_text("{not json", encoding="utf-8")
    assert cache.get("sha256:aa", opts) is None
