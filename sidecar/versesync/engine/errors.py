"""Typed errors raised by the engine."""

from __future__ import annotations


class ModelLoadError(Exception):
    """The model could not be loaded (missing weights, out of memory, bad device)."""

    code = "model_load_failed"


class TranscriptionCancelled(Exception):
    """Raised from :func:`transcribe_with_words` when the caller's cancel check fires."""
