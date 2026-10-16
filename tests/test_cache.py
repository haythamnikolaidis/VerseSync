from __future__ import annotations

import hashlib
import time
from pathlib import Path

from versesync.cache import CHUNK, hash_media


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
