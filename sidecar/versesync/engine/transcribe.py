"""Headless transcription that keeps word-level timestamps.

Derived from ``core/transcription/service.py`` in Faster-Whisper-Transcriber (8d46a09), which
discarded all timing and was bound to a Qt thread pool. This version is a plain function: no
signals, no event loop, and ``segment.words`` is retained (start, end, text, probability).

Text is never post-processed (no curation, no whitespace rewriting): downstream stages depend
on the word list corresponding one-to-one with what the model emitted.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from .errors import TranscriptionCancelled
from .types import Transcript, Word

ProgressCallback = Callable[[float], None]
CancelCheck = Callable[[], bool]


def transcribe_with_words(
    model: Any,
    audio_path: str | Path,
    *,
    batch_size: int | None = None,
    vad_filter: bool = True,
    vad_parameters: dict[str, Any] | None = None,
    initial_prompt: str | None = None,
    language: str | None = None,
    temperature: float = 0.0,
    condition_on_previous_text: bool = True,
    progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
) -> Transcript:
    """Transcribe ``audio_path`` with ``model`` and return every word with its timing.

    ``model`` is a ``faster_whisper.WhisperModel`` (or anything with the same ``transcribe``
    contract). ``batch_size`` greater than 1 routes through ``BatchedInferencePipeline``.

    ``progress`` receives a monotonic fraction in [0, 1]: the latest segment end divided by the
    media duration. ``cancel`` is polled before decoding starts and between segments; when it
    returns true the function raises :class:`TranscriptionCancelled`, so cancellation latency
    is one segment's decode time.
    """
    batched = batch_size is not None and int(batch_size) > 1
    runner: Any = model
    kwargs: dict[str, Any] = {
        "language": language,
        "temperature": temperature,
        "vad_filter": vad_filter,
        "vad_parameters": vad_parameters,
        "initial_prompt": initial_prompt,
        "word_timestamps": True,
    }
    if batched:
        from faster_whisper import BatchedInferencePipeline

        runner = BatchedInferencePipeline(model=model)
        kwargs["batch_size"] = int(batch_size or 0)
    else:
        kwargs["condition_on_previous_text"] = condition_on_previous_text

    if cancel is not None and cancel():
        raise TranscriptionCancelled()

    segments, info = runner.transcribe(str(audio_path), **kwargs)
    duration = float(getattr(info, "duration", 0.0) or 0.0)

    words: list[Word] = []
    reported = 0.0
    for segment in segments:
        if cancel is not None and cancel():
            raise TranscriptionCancelled()
        for w in getattr(segment, "words", None) or []:
            if w.start is None or w.end is None:
                continue
            text = str(w.word).strip()
            if not text:
                continue
            words.append(
                Word(
                    text=text,
                    start=float(w.start),
                    end=float(w.end),
                    probability=float(w.probability),
                )
            )
        if progress is not None and duration > 0:
            fraction = min(1.0, float(segment.end) / duration)
            if fraction > reported:
                reported = fraction
                progress(fraction)

    if progress is not None and reported < 1.0:
        progress(1.0)

    return Transcript(
        words=words,
        language=getattr(info, "language", None),
        language_probability=getattr(info, "language_probability", None),
        duration=duration,
    )
