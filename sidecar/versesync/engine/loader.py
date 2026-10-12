"""Model loading.

Ported from ``core/models/loader.py`` in Faster-Whisper-Transcriber (8d46a09). ``faster_whisper``
is imported inside :func:`load_model` so that :func:`setup_cuda_if_available` can run first.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .errors import ModelLoadError

logger = logging.getLogger("versesync.engine")

# Names faster-whisper resolves to its own published conversions; they are passed through
# unchanged. Everything else uses the CTranslate2 conversions the upstream project used.
_BUILTIN_NAMES = {"distil-large-v3"}


def make_repo_string(model_name: str, quantization_type: str) -> str:
    if model_name in _BUILTIN_NAMES:
        return model_name
    if model_name.startswith("distil-whisper"):
        return f"ctranslate2-4you/{model_name}-ct2-{quantization_type}"
    return f"ctranslate2-4you/whisper-{model_name}-ct2-{quantization_type}"


def _physical_cores() -> int:
    try:
        import psutil

        return psutil.cpu_count(logical=False) or 1
    except Exception:
        return max(1, (os.cpu_count() or 2) // 2)


def load_model(
    model_name: str,
    quantization_type: str = "float32",
    device_type: str = "cpu",
    cpu_threads: int | None = None,
    *,
    model_factory: Any = None,
) -> Any:
    """Load a ``WhisperModel``. ``model_factory`` replaces the class (tests inject a fake)."""
    repo = make_repo_string(model_name, quantization_type)
    logger.info("Loading Whisper model %s on %s", repo, device_type)

    if cpu_threads is None:
        cpu_threads = _physical_cores()

    try:
        factory = model_factory
        if factory is None:
            from faster_whisper import WhisperModel

            factory = WhisperModel
        model = factory(
            repo,
            device=device_type,
            compute_type=quantization_type,
            cpu_threads=cpu_threads,
        )
    except Exception as e:
        logger.exception("Failed to load model %s", repo)
        raise ModelLoadError(f"Error loading model {repo}: {e}") from e

    logger.info("Model %s ready", repo)
    return model
