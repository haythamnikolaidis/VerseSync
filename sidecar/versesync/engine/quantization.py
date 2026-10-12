"""Quantization capability probe.

Ported from ``core/quantization.py`` in Faster-Whisper-Transcriber (8d46a09), without the
config-manager coupling: it returns values instead of writing them anywhere.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("versesync.engine")

EXCLUDED_TYPES = ("int16", "int8", "int8_float32", "int8_float16", "int8_bfloat16")


def _ct2(ctranslate2: Any = None) -> Any:
    if ctranslate2 is not None:
        return ctranslate2
    import ctranslate2 as module

    return module


def has_cuda_device(ctranslate2: Any = None) -> bool:
    try:
        return bool(_ct2(ctranslate2).get_cuda_device_count() > 0)
    except Exception as e:
        logger.warning("Failed to check CUDA devices: %s", e)
        return False


def supported_quantizations(device: str, ctranslate2: Any = None) -> list[str]:
    """Compute types usable on ``device`` ("cpu" or "cuda"), minus the integer variants."""
    try:
        types = _ct2(ctranslate2).get_supported_compute_types(device)
        return [q for q in types if q not in EXCLUDED_TYPES]
    except Exception as e:
        logger.warning("Failed to get %s quantizations: %s", device, e)
        return ["float32"] if device == "cpu" else []
