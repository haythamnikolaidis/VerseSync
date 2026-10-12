"""Qt-free transcription engine.

Ported from Faster-Whisper-Transcriber (https://github.com/haythamnikolaidis/
Faster-Whisper-Transcriber, commit 8d46a09): ``core/transcription``, ``core/cuda_setup.py``,
``core/models/{metadata,loader}.py`` and ``core/quantization.py``. That project ships no licence
file; the code is used here with its author's permission and the original authorship is
credited in the headers of the ported modules.

Nothing in this package may import Qt. Importing it does not import ``faster_whisper`` or
``ctranslate2`` either: both are loaded lazily, after :func:`setup_cuda_if_available` has had a
chance to run.
"""

from __future__ import annotations

from .cuda_setup import setup_cuda_if_available
from .errors import ModelLoadError, TranscriptionCancelled
from .loader import load_model
from .metadata import ModelInfo, ModelMetadata
from .transcribe import transcribe_with_words
from .types import Transcript, Word

__all__ = [
    "ModelInfo",
    "ModelLoadError",
    "ModelMetadata",
    "Transcript",
    "TranscriptionCancelled",
    "Word",
    "load_model",
    "setup_cuda_if_available",
    "transcribe_with_words",
]
