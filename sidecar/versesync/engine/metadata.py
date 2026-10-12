"""Model table.

Ported from ``core/models/metadata.py`` in Faster-Whisper-Transcriber (8d46a09), with
``word_timestamp_quality`` added so the panel can warn when a model is a poor fit for
timestamp-driven work.

``word_timestamp_quality`` is ``"good"`` only for models measured in spike T-02
(spikes/word_timestamps/RESULTS.md: word-start error well under 0.5 s on unambiguous matches
for large-v3, large-v3-turbo and distil-large-v3). Everything else is ``"unverified"``.
"""

from __future__ import annotations

from dataclasses import dataclass

_GPU_ONLY_QUANT = {"cpu": ["float32"], "cuda": ["float16", "bfloat16", "float32"]}


@dataclass(frozen=True)
class ModelInfo:
    name: str
    supports_translation: bool
    quantization_overrides: dict[str, list[str]] | None = None
    word_timestamp_quality: str = "unverified"


class ModelMetadata:
    _MODELS: list[ModelInfo] = [
        ModelInfo("tiny", True),
        ModelInfo("tiny.en", False),
        ModelInfo("base", True),
        ModelInfo("base.en", False),
        ModelInfo("small", True),
        ModelInfo("small.en", False),
        ModelInfo("medium", True),
        ModelInfo("medium.en", False),
        ModelInfo("large-v3", True, word_timestamp_quality="good"),
        ModelInfo("large-v3-turbo", False, _GPU_ONLY_QUANT, word_timestamp_quality="good"),
        ModelInfo("distil-large-v3", False, _GPU_ONLY_QUANT, word_timestamp_quality="good"),
        ModelInfo("distil-whisper-small.en", False, _GPU_ONLY_QUANT),
        ModelInfo("distil-whisper-medium.en", False, _GPU_ONLY_QUANT),
        ModelInfo("distil-whisper-large-v3", False, _GPU_ONLY_QUANT),
    ]

    _MODEL_MAP: dict[str, ModelInfo] = {m.name: m for m in _MODELS}

    @classmethod
    def get_all_model_names(cls) -> list[str]:
        return [m.name for m in cls._MODELS]

    @classmethod
    def get_model_info(cls, name: str) -> ModelInfo | None:
        return cls._MODEL_MAP.get(name)

    @classmethod
    def supports_translation(cls, name: str) -> bool:
        info = cls._MODEL_MAP.get(name)
        return info.supports_translation if info else False

    @classmethod
    def word_timestamp_quality(cls, name: str) -> str:
        info = cls._MODEL_MAP.get(name)
        return info.word_timestamp_quality if info else "unverified"

    @classmethod
    def get_quantization_options(
        cls, model_name: str, device: str, supported_quantizations: dict[str, list[str]]
    ) -> list[str]:
        info = cls._MODEL_MAP.get(model_name)

        if info and info.quantization_overrides:
            options = info.quantization_overrides.get(device, [])
        else:
            options = supported_quantizations.get(device, [])

        if device == "cpu":
            options = [opt for opt in options if opt not in ("float16", "bfloat16")]

        return list(options)
