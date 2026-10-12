"""Content hashing and the on-disk transcript cache (docs/03 section 4, decision D17).

A media file is identified by a composite hash of its first 8 MB, last 8 MB and size, so a
4 GB MXF is "hashed" by reading 16 MB. The cached word array is keyed by that hash plus every
option that can change the transcript. Options that only affect detection or timing are not
part of the key, so a re-run with a different ``context_window_s`` hits.

Entries live under the per-user data directory (``paths.app_dir()``), which survives restarts;
nothing is written to a temp directory.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import transcribe as _tr
from .engine import Transcript, Word
from .paths import app_dir
from .transcribe import (
    SCRIPTURE_PROMPT,
    CancelCheck,
    ProgressCallback,
    TranscriptionResult,
    TranscriptionSettings,
)

logger = logging.getLogger("versesync.cache")

HASH_PREFIX = "sha256:"
# D17: bytes taken from each end of the file.
HASH_SAMPLE_BYTES = 8 * 1024 * 1024
_READ_CHUNK = 1024 * 1024

# Bump when the entry layout or the meaning of a key field changes; old entries then miss.
CACHE_FORMAT = 1

HashProgress = Callable[[float], None]


def hash_media(path: str | Path, progress: HashProgress | None = None) -> str:
    """``sha256:<hex>`` over the first 8 MB, last 8 MB and size of ``path`` (D17).

    ``progress`` receives the fraction of sampled bytes read. A file of at most 8 MB is hashed
    whole; between 8 and 16 MB the two samples tile the file without overlapping.
    """
    path = Path(path)
    with path.open("rb") as f:
        size = os.fstat(f.fileno()).st_size
        head_len = min(size, HASH_SAMPLE_BYTES)
        tail_start = max(size - HASH_SAMPLE_BYTES, head_len)
        tail_len = size - tail_start
        total = max(head_len + tail_len, 1)
        digest = hashlib.sha256()
        read = 0

        def consume(offset: int, length: int) -> None:
            nonlocal read
            f.seek(offset)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(_READ_CHUNK, remaining))
                if not chunk:
                    raise OSError(f"{path} ended early while hashing")
                digest.update(chunk)
                remaining -= len(chunk)
                read += len(chunk)
                if progress is not None:
                    progress(read / total)

        consume(0, head_len)
        consume(tail_start, tail_len)
        # The size separates recordings whose sampled bytes coincide.
        digest.update(size.to_bytes(8, "little"))
    if progress is not None:
        progress(1.0)
    return HASH_PREFIX + digest.hexdigest()


def cache_key(media_hash: str, settings: TranscriptionSettings, device: str | None = None) -> str:
    """Key for one (media, transcript-affecting options) pair.

    Covers model, quantization, device, language, VAD, the prompt text, batch size,
    ``condition_on_previous_text`` and the seed. Device and quantization are the resolved ones
    (``auto`` becomes what it picks; half precision becomes float32 on a CPU), so equivalent
    runs share an entry. Detection and timing options are deliberately absent.
    """
    resolved = device if device is not None else _tr.resolve_device(settings.device)
    options: dict[str, Any] = {
        "format": CACHE_FORMAT,
        "model": settings.model,
        "quantization": _tr.effective_quantization(resolved, settings.quantization),
        "device": resolved,
        "language": settings.language,
        "vad_filter": settings.vad_filter,
        "vad_parameters": settings.vad_parameters,
        "initial_prompt": SCRIPTURE_PROMPT if settings.scripture_prompt else None,
        "batch_size": settings.batch_size,
        "condition_on_previous_text": settings.condition_on_previous_text,
        "seed": settings.seed,
    }
    blob = json.dumps(options, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(f"{media_hash}\n{blob}".encode()).hexdigest()


def default_cache_dir() -> Path:
    return app_dir() / "cache" / "transcripts"


class TranscriptCache:
    """Word arrays on disk, one JSON file per key, written atomically."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory if directory is not None else default_cache_dir()

    def _path(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    def get(self, key: str) -> TranscriptionResult | None:
        """The cached result, or ``None`` on a miss or an unreadable entry."""
        path = self._path(key)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data["format"] != CACHE_FORMAT:
                return None
            t = data["transcript"]
            transcript = Transcript(
                words=[
                    Word(
                        text=str(w["text"]),
                        start=float(w["start"]),
                        end=float(w["end"]),
                        probability=float(w["probability"]),
                    )
                    for w in t["words"]
                ],
                language=t["language"],
                language_probability=t["language_probability"],
                duration=float(t["duration"]),
            )
            return TranscriptionResult(
                transcript=transcript,
                model=str(data["model"]),
                device=str(data["device"]),
                quantization=str(data["quantization"]),
            )
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError) as e:
            logger.warning("Ignoring unreadable transcript cache entry %s: %s", path.name, e)
            return None

    def put(self, key: str, result: TranscriptionResult) -> None:
        data = {
            "format": CACHE_FORMAT,
            "model": result.model,
            "device": result.device,
            "quantization": result.quantization,
            "transcript": result.transcript.to_dict(),
        }
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self._path(key))
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def __contains__(self, key: str) -> bool:
        return self._path(key).is_file()


@dataclass
class CachedTranscription:
    result: TranscriptionResult
    media_hash: str
    cache_hit: bool
    warnings: list[str] = field(default_factory=list)


def peek(
    media_path: str | Path,
    settings: TranscriptionSettings,
    cache: TranscriptCache | None = None,
) -> tuple[str, bool]:
    """``(media_hash, cache_hit)`` without transcribing; what ``POST /jobs`` reports."""
    store = cache if cache is not None else TranscriptCache()
    media_hash = hash_media(media_path)
    return media_hash, cache_key(media_hash, settings) in store


def transcribe_cached(
    media_path: str | Path,
    settings: TranscriptionSettings | None = None,
    *,
    cache: TranscriptCache | None = None,
    use_cache: bool = True,
    progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
    **transcribe_kwargs: Any,
) -> CachedTranscription:
    """Transcribe ``media_path``, reusing a cached word array when one matches.

    A hit skips the model entirely; progress is reported on the bar with the ``transcribing``
    weight removed. ``use_cache=False`` always re-transcribes (and refreshes the entry).
    Remaining keyword arguments go to :func:`versesync.transcribe.transcribe_media`.
    """
    cfg = settings or TranscriptionSettings()
    store = cache if cache is not None else TranscriptCache()

    def on_hash(fraction: float) -> None:
        if progress is not None:
            progress(fraction, _tr.overall_progress("hashing", fraction))

    media_hash = hash_media(media_path, on_hash)
    key = cache_key(media_hash, cfg)

    if use_cache:
        hit = store.get(key)
        if hit is not None:
            logger.info("Transcript cache hit for %s", media_hash)
            if progress is not None:
                progress(1.0, _tr.overall_progress("hashing", 1.0, cache_hit=True))
            return CachedTranscription(hit, media_hash, True)

    result = _tr.transcribe_media(
        media_path, cfg, progress=progress, cancel=cancel, **transcribe_kwargs
    )
    store.put(key, result)
    return CachedTranscription(result, media_hash, False, list(result.warnings))
