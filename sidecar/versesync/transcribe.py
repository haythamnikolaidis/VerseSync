"""Sidecar transcription: a media file in, a word array out.

Wires the Qt-free engine (:mod:`versesync.engine`) to VerseSync's job defaults:

* decoder biasing with the scripture prompt (docs/04 section 2),
* VAD and a pinned language (docs/02 Gap 4),
* the default model chosen by spike T-02 (docs/02 Gap 5, docs/12 R-5),
* batched inference, progress and cancellation for long audio (docs/02 Gap 6),
* deterministic decoding (docs/05 section 10): ``temperature=0`` (no fallback ladder) and a
  fixed seed.

``curate_text`` is never applied (docs/02 Gap 8). Nothing here knows about Premiere.
"""

from __future__ import annotations

import logging
import random
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from .engine import (
    ModelLoadError,
    Transcript,
    TranscriptionCancelled,
    load_model,
    setup_cuda_if_available,
    transcribe_with_words,
)
from .engine import (
    quantization as _quantization,
)

logger = logging.getLogger("versesync.transcribe")

# docs/04 section 2. Whisper keeps only the last 223 prompt tokens, so an overflow would drop
# the start of the book list rather than fail.
SCRIPTURE_PROMPT = (
    "A sermon quoting the Bible. Books mentioned may include: "
    "Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, "
    "1 Samuel, 2 Samuel, 1 Kings, 2 Kings, 1 Chronicles, 2 Chronicles, Ezra, "
    "Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Song of Solomon, "
    "Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, "
    "Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, "
    "Matthew, Mark, Luke, John, Acts, Romans, 1 Corinthians, 2 Corinthians, "
    "Galatians, Ephesians, Philippians, Colossians, 1 Thessalonians, "
    "2 Thessalonians, 1 Timothy, 2 Timothy, Titus, Philemon, Hebrews, James, "
    "1 Peter, 2 Peter, 1 John, 2 John, 3 John, Jude, Revelation. "
    "For example: John 3:16, Romans 8:28, 1 Corinthians 13:4-7."
)

# Phase weights of the overall progress bar (docs/07 section 4), in pipeline order.
PHASE_WEIGHTS: dict[str, float] = {
    "hashing": 0.02,
    "transcribing": 0.80,
    "detecting": 0.05,
    "resolving": 0.10,
    "timing": 0.03,
}

# The panel warns before a CPU run over this much audio (docs/12 R-10, docs/01 NFR-2).
CPU_WARN_AFTER_S = 10 * 60

# Planning figure for free-vs-required VRAM in load errors: large-v3, float16 (docs/07
# section 3). Combinations without an entry are reported without a "required" figure rather
# than with a guess.
_APPROX_VRAM_GB: dict[tuple[str, str], float] = {("large-v3", "float16"): 10.4}

_OOM_MARKERS = ("out of memory", "cuda failed", "cudamalloc", "alloc")

ProgressCallback = Callable[[float, float], None]
"""Called with ``(phase_fraction, overall_fraction)``; both are monotonic and in [0, 1]."""
CancelCheck = Callable[[], bool]
VramProbe = Callable[[], "float | None"]
DurationProbe = Callable[[Path], "float | None"]


class ModelLoadFailed(ModelLoadError):
    """:class:`ModelLoadError` with the text an editor reads (docs/07 section 3)."""

    def __init__(self, message: str, *, hint: str, detail: str, retryable: bool) -> None:
        super().__init__(message)
        self.hint = hint
        self.detail = detail
        self.retryable = retryable


def overall_progress(phase: str, fraction: float, *, cache_hit: bool = False) -> float:
    """Map progress inside ``phase`` onto the single 0-1 bar.

    On a cache hit the transcription phase is skipped and the remaining weights are
    renormalised (docs/07 section 4).
    """
    weights = {k: v for k, v in PHASE_WEIGHTS.items() if not (cache_hit and k == "transcribing")}
    if phase not in weights:
        raise ValueError(f"phase {phase!r} does not report progress here")
    total = sum(weights.values())
    done = 0.0
    for name, weight in weights.items():
        if name == phase:
            break
        done += weight
    fraction = min(1.0, max(0.0, fraction))
    return (done + weights[phase] * fraction) / total


@dataclass(frozen=True)
class TranscriptionSettings:
    """Resolved job options; build from config with :meth:`from_config`."""

    model: str = "distil-large-v3"
    device: str = "auto"
    quantization: str = "float16"
    batch_size: int = 8
    language: str | None = "en"
    vad_filter: bool = True
    vad_parameters: dict[str, Any] | None = None
    scripture_prompt: bool = True
    condition_on_previous_text: bool = True
    seed: int = 0

    @classmethod
    def from_config(
        cls, transcription: Mapping[str, Any], overrides: Mapping[str, Any] | None = None
    ) -> TranscriptionSettings:
        """Config ``transcription`` section, with per-job ``overrides`` applied on top."""
        merged = {**transcription, **(overrides or {})}
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in merged.items() if k in known})


@dataclass
class TranscriptionResult:
    transcript: Transcript
    model: str
    device: str
    quantization: str
    warnings: list[str] = field(default_factory=list)


def seed_everything(seed: int) -> None:
    """Fix every RNG a decode could touch."""
    random.seed(seed)
    try:
        import numpy

        numpy.random.seed(seed)
    except ImportError:
        pass


def resolve_device(device: str) -> str:
    if device != "auto":
        return device
    return "cuda" if _quantization.has_cuda_device() else "cpu"


def probe_free_vram_gb() -> float | None:
    """Free memory on the first NVIDIA GPU in GB, or ``None`` when it cannot be read."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout
        return float(out.strip().splitlines()[0]) / 1024
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def probe_media_duration_s(path: Path) -> float | None:
    """Container duration via PyAV (a faster-whisper dependency), or ``None``."""
    try:
        import av

        with av.open(str(path)) as container:
            if container.duration is None:
                return None
            return float(container.duration) / 1_000_000
    except Exception:
        return None


def _is_oom(error: BaseException) -> bool:
    text = str(error.__cause__ if error.__cause__ is not None else error).lower()
    return any(marker in text for marker in _OOM_MARKERS)


def explain_load_failure(
    error: ModelLoadError,
    model: str,
    device: str,
    quantization: str,
    vram_probe: VramProbe | None = None,
) -> ModelLoadFailed:
    """Turn an engine load failure into the message an editor sees."""
    cause = error.__cause__ if error.__cause__ is not None else error
    detail = f"{type(cause).__name__}: {cause}"
    if _is_oom(error):
        free = (vram_probe or probe_free_vram_gb)() if device == "cuda" else None
        required = _APPROX_VRAM_GB.get((model, quantization))
        figures = []
        if free is not None:
            figures.append(f"{free:.1f} GB free")
        if required is not None:
            figures.append(f"~{required:.1f} GB required")
        suffix = f" ({', '.join(figures)})" if figures else ""
        hint = (
            "Try distil-large-v3 with float16, or switch to CPU."
            if model != "distil-large-v3"
            else "Close other GPU applications, or switch to CPU."
        )
        return ModelLoadFailed(
            f"Could not load {model} on {device}: out of memory{suffix}",
            hint=hint,
            detail=detail,
            retryable=True,
        )
    return ModelLoadFailed(
        f"Could not load {model} on {device}. The model files may be missing or damaged.",
        hint="Check the model download and the selected device in Settings.",
        detail=detail,
        retryable=False,
    )


def transcribe_media(
    media_path: str | Path,
    settings: TranscriptionSettings | None = None,
    *,
    progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
    model: Any = None,
    model_factory: Any = None,
    vram_probe: VramProbe | None = None,
    duration_probe: DurationProbe | None = None,
) -> TranscriptionResult:
    """Transcribe ``media_path`` into a word array.

    ``model`` supplies an already-loaded model (the caller caches it between jobs);
    ``model_factory`` replaces ``WhisperModel`` when loading, which is how tests inject a fake.
    Raises :class:`ModelLoadFailed` if the model cannot be loaded and
    :class:`~versesync.engine.TranscriptionCancelled` if ``cancel`` fires.
    """
    cfg = settings or TranscriptionSettings()
    path = Path(media_path)
    warnings: list[str] = []

    # Must precede anything that can initialise CUDA, including the device probe below.
    setup_cuda_if_available()
    seed_everything(cfg.seed)

    device = resolve_device(cfg.device)
    quant = cfg.quantization
    if device == "cpu" and quant in ("float16", "bfloat16"):
        warnings.append(f"{quant} is not available on CPU; using float32.")
        quant = "float32"

    if device == "cpu":
        duration = (duration_probe or probe_media_duration_s)(path)
        if duration is not None and duration > CPU_WARN_AFTER_S:
            warnings.append(
                f"No GPU is available: transcribing {duration / 60:.0f} minutes of audio on "
                "the CPU can take longer than the recording itself."
            )
    for warning in warnings:
        logger.warning(warning)

    if cancel is not None and cancel():
        raise TranscriptionCancelled()

    if model is None:
        try:
            model = load_model(cfg.model, quant, device, model_factory=model_factory)
        except ModelLoadError as e:
            raise explain_load_failure(e, cfg.model, device, quant, vram_probe) from e

    on_phase: Callable[[float], None] | None = None
    if progress is not None:
        report = progress

        def on_phase(fraction: float) -> None:
            report(fraction, overall_progress("transcribing", fraction))

    transcript = transcribe_with_words(
        model,
        path,
        batch_size=cfg.batch_size,
        vad_filter=cfg.vad_filter,
        vad_parameters=cfg.vad_parameters,
        initial_prompt=SCRIPTURE_PROMPT if cfg.scripture_prompt else None,
        language=cfg.language,
        temperature=0.0,
        condition_on_previous_text=cfg.condition_on_previous_text,
        progress=on_phase,
        cancel=cancel,
    )
    return TranscriptionResult(
        transcript=transcript, model=cfg.model, device=device, quantization=quant, warnings=warnings
    )


def main(argv: list[str] | None = None) -> int:
    """``python -m versesync.transcribe MEDIA [--model M] ...``: print the word array as JSON."""
    import argparse
    import json
    import sys

    from .config import load_config

    parser = argparse.ArgumentParser(prog="versesync.transcribe")
    parser.add_argument("media")
    parser.add_argument("--model")
    parser.add_argument("--device")
    parser.add_argument("--quantization")
    parser.add_argument("--language")
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--no-vad", action="store_true")
    args = parser.parse_args(argv)

    overrides: dict[str, Any] = {}
    for key in ("model", "device", "quantization", "language", "batch_size"):
        if getattr(args, key) is not None:
            overrides[key] = getattr(args, key)
    if args.no_vad:
        overrides["vad_filter"] = False
    settings = TranscriptionSettings.from_config(load_config().transcription, overrides)

    def show(_phase: float, overall: float) -> None:
        print(f"progress {overall:.3f}", file=sys.stderr, flush=True)

    try:
        result = transcribe_media(args.media, settings, progress=show)
    except ModelLoadFailed as e:
        print(f"error: {e} {e.hint}", file=sys.stderr)
        return 2
    for warning in result.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    json.dump(result.transcript.to_dict(), sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
