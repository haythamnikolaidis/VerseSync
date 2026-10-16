"""Content hashing for media files and the on-disk transcript cache (D17, 06 section 4)."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

CHUNK = 8 * 1024 * 1024


def _update_range(
    digest: "hashlib._Hash",
    handle: BinaryIO,
    start: int,
    length: int,
    on_bytes: Callable[[int], None],
) -> None:
    """Hash ``length`` bytes of ``handle`` beginning at ``start``."""
    handle.seek(start)
    remaining = length
    while remaining > 0:
        block = handle.read(min(remaining, 1024 * 1024))
        if not block:
            break
        digest.update(block)
        remaining -= len(block)
        on_bytes(len(block))


def hash_media(path: Path, progress: Callable[[float], None] | None = None) -> str:
    """Return ``"sha256:<hex>"`` for a media file without reading all of a large one.

    The digest covers the first 8 MB, then the last 8 MB, then the file size as 8-byte
    little-endian. A file under 16 MB is hashed whole, once. The tail and the size are what
    tell apart two recordings that share their first bytes.
    """
    path = Path(path)
    size = path.stat().st_size
    digest = hashlib.sha256()
    if size < 2 * CHUNK:
        ranges = [(0, size)]
    else:
        ranges = [(0, CHUNK), (size - CHUNK, CHUNK)]
    total = sum(length for _, length in ranges)
    done = 0

    def on_bytes(n: int) -> None:
        nonlocal done
        done += n
        if progress is not None:
            progress(min(done / total, 1.0) if total else 1.0)

    with path.open("rb") as handle:
        for start, length in ranges:
            _update_range(digest, handle, start, length, on_bytes)
    digest.update(size.to_bytes(8, "little"))
    if progress is not None:
        progress(1.0)
    return "sha256:" + digest.hexdigest()
