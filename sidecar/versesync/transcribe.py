"""Transcription: options, the backend protocol, and the fixture and fake backends.

Everything downstream consumes only the word array, so the real faster-whisper adapter
(T-07.2) is one more :class:`Backend`. It is the only place the upstream engine
(Faster-Whisper-Transcriber's ``core`` package, which pulls in ``faster_whisper``) is imported,
and only lazily. Spec: docs/04-reference-detection.md section 2 (the prompt) and
docs/tasks/T-07-transcription-in-sidecar.md (the defaults, measured by spike T-02).
"""

from __future__ import annotations

import importlib.util
import logging
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Protocol

from versesync.config import Config
from versesync.pipeline import Cancelled
from versesync.types import Word, load_words

# docs/04-reference-detection.md section 2, verbatim.
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

FIXTURE_PREFIX = "fixture:"

_GIB = 1024**3

_log = logging.getLogger("versesync.transcribe")

# The upstream loader builds its Hugging Face repo name from the model name, and lists the
# distil-large-v3 that spike T-02 measured as distil-whisper-large-v3 (upstream
# core/models/metadata.py). Every other name VerseSync accepts is the same in both.
_UPSTREAM_MODEL_NAMES = {"distil-large-v3": "distil-whisper-large-v3"}

# Chosen, not specified: parameter counts in millions, from the OpenAI Whisper and
# Distil-Whisper model cards. They only feed the "~N GB required" figure in the out-of-memory
# message, so a model missing from this table gets the message without that figure.
_MODEL_PARAMS_M = {
    "tiny": 39,
    "tiny.en": 39,
    "base": 74,
    "base.en": 74,
    "small": 244,
    "small.en": 244,
    "medium": 769,
    "medium.en": 769,
    "large-v3": 1550,
    "large-v3-turbo": 809,
    "distil-large-v3": 756,
    "distil-whisper-large-v3": 756,
    "distil-whisper-medium.en": 394,
    "distil-whisper-small.en": 166,
}

# Bytes one weight takes in each CTranslate2 compute type.
_BYTES_PER_PARAM = {
    "float32": 4,
    "float16": 2,
    "bfloat16": 2,
    "int8_float32": 1,
    "int8_float16": 1,
    "int8_bfloat16": 1,
    "int8": 1,
}

# Chosen, not specified: what a run needs on top of the weights. Fitted to the faster-whisper
# README benchmark for large-v2 on GPU, where float16 uses about 4.7 GB at batch size 1 and
# about 6.1 GB at batch size 8, on 3.1 GB of weights: roughly 1.5 GB of fixed overhead (CUDA
# context, workspaces, the first batch) plus 0.2 GB for each further item in a batch.
_OVERHEAD_GB = 1.5
_PER_EXTRA_BATCH_ITEM_GB = 0.2

# How many progress ticks the fixture and fake backends emit. Chosen only so that tests can
# observe several steps of progress and cancellation; it has no effect on the words returned.
_SIMULATED_TICKS = 10


@dataclass(frozen=True)
class TranscribeOptions:
    model: str = "distil-large-v3"
    device: str = "cuda"
    quantization: str = "float16"
    batch_size: int | None = 8
    language: str = "en"
    vad_filter: bool = True
    vad_parameters: dict[str, Any] | None = None
    initial_prompt: str | None = SCRIPTURE_PROMPT
    condition_on_previous_text: bool = True
    temperature: float = 0.0

    def cache_key(self) -> dict[str, Any]:
        """Every field, since each one can change the transcript (the T-08 cache keys on this)."""
        key = asdict(self)
        if self.vad_parameters is not None:
            key["vad_parameters"] = dict(sorted(self.vad_parameters.items()))
        return key

    @classmethod
    def from_config(cls, config: Config) -> TranscribeOptions:
        """Build options from ``config.transcription``; unset keys keep the dataclass default."""
        names = {f.name for f in fields(cls)}
        overrides = {k: v for k, v in config.transcription.items() if k in names}
        return cls(**overrides)


class TranscriptionError(Exception):
    def __init__(self, code: str, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


class Backend(Protocol):
    def transcribe(
        self,
        media_path: Path,
        opts: TranscribeOptions,
        progress: Callable[[float], None],
        is_cancelled: Callable[[], bool],
    ) -> tuple[list[Word], float]:
        """Return ``(words, media_duration_s)``; raise ``Cancelled`` if cancelled."""
        ...


class FakeBackend:
    """Scripted backend for unit tests: fixed words, optional hook per tick, optional failure."""

    def __init__(
        self,
        words: Sequence[Word] = (),
        duration_s: float | None = None,
        error: TranscriptionError | None = None,
        on_tick: Callable[[int], None] | None = None,
    ) -> None:
        self.words = list(words)
        self.duration_s = (
            duration_s if duration_s is not None else (self.words[-1].end if self.words else 0.0)
        )
        self.error = error
        self.on_tick = on_tick
        self.calls: list[tuple[Path, TranscribeOptions]] = []

    def transcribe(
        self,
        media_path: Path,
        opts: TranscribeOptions,
        progress: Callable[[float], None],
        is_cancelled: Callable[[], bool],
    ) -> tuple[list[Word], float]:
        self.calls.append((media_path, opts))
        if self.error is not None:
            raise self.error
        _simulate(progress, is_cancelled, self.on_tick)
        return list(self.words), self.duration_s


class FixtureBackend:
    """Replays a ``*.words.json`` transcript (``transcription.backend: fixture:<path>``)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def transcribe(
        self,
        media_path: Path,
        opts: TranscribeOptions,
        progress: Callable[[float], None],
        is_cancelled: Callable[[], bool],
    ) -> tuple[list[Word], float]:
        if not self.path.is_file():
            raise TranscriptionError(
                "fixture_missing",
                f"Fixture transcript not found: {self.path}",
                "Check transcription.backend in the config.",
            )
        words = load_words(self.path)
        _simulate(progress, is_cancelled, None)
        return words, (words[-1].end if words else 0.0)


def _simulate(
    progress: Callable[[float], None],
    is_cancelled: Callable[[], bool],
    on_tick: Callable[[int], None] | None,
) -> None:
    """Report monotonic progress ending at 1.0, checking for cancellation before each tick."""
    for tick in range(1, _SIMULATED_TICKS + 1):
        if is_cancelled():
            raise Cancelled()
        if on_tick is not None:
            on_tick(tick)
        progress(tick / _SIMULATED_TICKS)


def _backend_unavailable(cause: ImportError | None = None) -> TranscriptionError:
    # A partial install fails on one missing module; naming it saves a debugging session.
    missing = f" (missing module: {cause.name})" if cause is not None and cause.name else ""
    return TranscriptionError(
        "backend_unavailable",
        f"The faster-whisper backend is not installed in this build{missing}.",
        "Install versesync[transcribe], or use transcription.backend: fixture:<path> or fake.",
    )


def _upstream_installed() -> bool:
    """Whether the upstream package can be found, without importing the engine or CUDA.

    Only the empty ``core`` and ``core.models`` packages are imported; ``core.models.loader``,
    which loads ctranslate2, is not, so this is safe to call before ``core.cuda_setup`` has run.
    """
    try:
        return importlib.util.find_spec("core.models.loader") is not None
    except ImportError:
        return False


def _import_upstream() -> tuple[Callable[..., Any], Callable[..., Any], type[BaseException]]:
    """Import the upstream engine, running ``core.cuda_setup`` before anything that loads CUDA.

    ``core.models.loader`` imports ``faster_whisper`` (and so ctranslate2) at import time, and
    the CUDA library paths have to be set before that happens, so nothing else from ``core`` is
    imported until ``setup_cuda_if_available`` has run.
    """
    try:
        from core.cuda_setup import setup_cuda_if_available
    except ImportError as exc:
        raise _backend_unavailable(exc) from exc
    setup_cuda_if_available()
    try:
        from core.models.loader import load_model
        from core.transcription.engine import Cancelled as UpstreamCancelled
        from core.transcription.engine import transcribe_with_words
    except ImportError as exc:
        raise _backend_unavailable(exc) from exc
    return load_model, transcribe_with_words, UpstreamCancelled


def _is_out_of_memory(exc: BaseException | None) -> bool:
    """True if ``exc`` or anything it was raised from reports running out of memory.

    The upstream loader wraps every failure in its own ``ModelLoadError``, so the real cause is
    further down the chain: ctranslate2 raises a ``RuntimeError`` whose text says "out of
    memory", and PyTorch raises ``torch.cuda.OutOfMemoryError``.
    """
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if (
            isinstance(exc, MemoryError)
            or "OutOfMemory" in type(exc).__name__
            or "out of memory" in str(exc).lower()
        ):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _root_reason(exc: BaseException) -> str:
    """The first line of the innermost cause's message, which is the part an editor can use."""
    root = exc
    while root.__cause__ is not None:
        root = root.__cause__
    lines = str(root).strip().splitlines()
    return lines[0] if lines else type(root).__name__


def _gpu_memory_bytes() -> tuple[int, int] | None:
    """``(free, total)`` GPU memory in bytes from ``torch.cuda.mem_get_info``, if available."""
    try:
        import torch

        free, total = torch.cuda.mem_get_info()
        return int(free), int(total)
    except Exception:  # noqa: BLE001 - torch is optional, and CPU-only builds raise on this call
        return None


def _required_gb(opts: TranscribeOptions) -> float | None:
    """Rough GB a run of ``opts`` needs, or None when the model or quantization is unknown."""
    params_m = _MODEL_PARAMS_M.get(opts.model)
    width = _BYTES_PER_PARAM.get(opts.quantization)
    if params_m is None or width is None:
        return None
    weights_gb = params_m * 1_000_000 * width / _GIB
    extra_items = max((opts.batch_size or 1) - 1, 0)
    return weights_gb + _OVERHEAD_GB + _PER_EXTRA_BATCH_ITEM_GB * extra_items


def _model_load_error(opts: TranscribeOptions, exc: BaseException) -> TranscriptionError:
    """``model_load_failed`` in the shape docs/07-sidecar-api.md section 3 shows."""
    prefix = f"Could not load {opts.model} on {opts.device}: "
    if not _is_out_of_memory(exc):
        return TranscriptionError("model_load_failed", prefix + _root_reason(exc))
    message = prefix + "out of memory"
    hint = None
    memory = _gpu_memory_bytes() if opts.device == "cuda" else None
    required = _required_gb(opts)
    if memory is not None and required is not None:
        free, total = memory
        message += f" ({free / _GIB:.1f} GB free, ~{required:.1f} GB required)"
        hint = (
            f"This graphics card has {total / _GIB:.1f} GB in total. Close other programs that "
            "use it, try a smaller model or float16, or switch to CPU."
        )
    return TranscriptionError("model_load_failed", message, hint)


class FasterWhisperBackend:
    """The real backend: a thin adapter over the upstream engine (T-07.2).

    ``curate_text`` is never enabled: it rewrites the text after the fact, so the string would
    no longer match the word list (docs/02-source-project-audit.md Gap 8). The model is loaded
    for each call and released when it returns, so an idle sidecar holds no GPU memory.
    """

    def transcribe(
        self,
        media_path: Path,
        opts: TranscribeOptions,
        progress: Callable[[float], None],
        is_cancelled: Callable[[], bool],
    ) -> tuple[list[Word], float]:
        if is_cancelled():
            raise Cancelled()
        if opts.device == "cpu":
            # R-10 (docs/12-decisions-and-risks.md): a long recording on the CPU can take longer
            # than its own length, so say so in the log instead of grinding silently.
            _log.warning(
                "Transcribing %s on the CPU; a long recording can take longer than it plays for",
                media_path.name,
            )
        load_model, transcribe_with_words, upstream_cancelled = _import_upstream()
        try:
            model = load_model(
                _UPSTREAM_MODEL_NAMES.get(opts.model, opts.model), opts.quantization, opts.device
            )
        except Exception as exc:  # noqa: BLE001 - the upstream loader wraps every failure
            raise _model_load_error(opts, exc) from exc
        try:
            transcript = transcribe_with_words(
                model,
                media_path,
                batch_size=opts.batch_size,
                vad_filter=opts.vad_filter,
                vad_parameters=opts.vad_parameters,
                initial_prompt=opts.initial_prompt,
                language=opts.language,
                temperature=opts.temperature,
                condition_on_previous_text=opts.condition_on_previous_text,
                progress=progress,
                cancel=is_cancelled,
            )
        except upstream_cancelled as exc:
            raise Cancelled() from exc
        except OSError:
            raise  # the job runner turns an unreadable file into media_unreadable
        except Exception as exc:  # noqa: BLE001 - every other failure ends the job the same way
            if _is_out_of_memory(exc):
                raise _model_load_error(opts, exc) from exc
            raise TranscriptionError("transcription_failed", _root_reason(exc)) from exc
        # The upstream text keeps faster-whisper's leading space, which would double up where
        # the pipeline joins words with a space, and the fixture transcripts have none.
        words = [
            Word(text=w.text.strip(), start=w.start, end=w.end, probability=w.probability)
            for w in transcript.words
        ]
        return words, transcript.duration


def get_backend(config: Config) -> Backend:
    """Select the backend named by ``transcription.backend``."""
    name = str(config.transcription.get("backend", "faster_whisper"))
    if name == "fake":
        return FakeBackend()
    if name.startswith(FIXTURE_PREFIX):
        return FixtureBackend(Path(name[len(FIXTURE_PREFIX) :]))
    if name == "faster_whisper":
        if not _upstream_installed():
            raise _backend_unavailable()
        return FasterWhisperBackend()
    raise TranscriptionError(
        "unknown_backend",
        f"Unknown transcription backend: {name!r}",
        "Use faster_whisper, fixture:<path> or fake.",
    )
