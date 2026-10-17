"""Content hashing for media files and the on-disk transcript cache (D17, 06 section 4)."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

from versesync.paths import cache_dir
from versesync.transcribe import TranscribeOptions
from versesync.types import Word

CHUNK = 8 * 1024 * 1024

# Version of the cache entry layout; entries written under another version are treated as misses.
CACHE_SCHEMA_VERSION = 1


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


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


class TranscriptCache:
    """One JSON file per (media hash, transcription options) pair under ``root``."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root is not None else cache_dir() / "transcripts"

    def key(self, media_hash: str, opts: TranscribeOptions) -> str:
        payload = media_hash + _canonical(opts.cache_key())
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _path(self, media_hash: str, opts: TranscribeOptions) -> Path:
        return self.root / (self.key(media_hash, opts) + ".json")

    def get(self, media_hash: str, opts: TranscribeOptions) -> tuple[list[Word], float] | None:
        path = self._path(media_hash, opts)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if raw["schema_version"] != CACHE_SCHEMA_VERSION:
                return None
            words = [
                Word(
                    text=str(w["text"]),
                    start=float(w["start"]),
                    end=float(w["end"]),
                    probability=float(w["probability"]),
                )
                for w in raw["words"]
            ]
            return words, float(raw["duration_s"])
        except (OSError, ValueError, KeyError, TypeError):
            # Missing or damaged entries are misses; the caller re-transcribes.
            return None

    def put(
        self,
        media_hash: str,
        opts: TranscribeOptions,
        words: list[Word],
        duration_s: float,
    ) -> None:
        entry = {
            "schema_version": CACHE_SCHEMA_VERSION,
            "media_hash": media_hash,
            "options": opts.cache_key(),
            "duration_s": duration_s,
            "words": [
                {"text": w.text, "start": w.start, "end": w.end, "probability": w.probability}
                for w in words
            ],
        }
        self.root.mkdir(parents=True, exist_ok=True)
        target = self._path(media_hash, opts)
        fd, tmp_name = tempfile.mkstemp(dir=self.root, prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(entry, handle)
            os.replace(tmp_name, target)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise
