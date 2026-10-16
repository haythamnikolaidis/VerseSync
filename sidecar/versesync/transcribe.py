"""Transcription: options, the backend protocol, and the fixture and fake backends.

Everything downstream consumes only the word array, so the real faster-whisper adapter
(T-07.2) is one more :class:`Backend`. It is the only place ``faster_whisper`` is imported, and
only lazily. Spec: docs/04-reference-detection.md section 2 (the prompt) and
docs/tasks/T-07-transcription-in-sidecar.md (the defaults, measured by spike T-02).
"""

from __future__ import annotations

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


def get_backend(config: Config) -> Backend:
    """Select the backend named by ``transcription.backend``."""
    name = str(config.transcription.get("backend", "faster_whisper"))
    if name == "fake":
        return FakeBackend()
    if name.startswith(FIXTURE_PREFIX):
        return FixtureBackend(Path(name[len(FIXTURE_PREFIX) :]))
    if name == "faster_whisper":
        raise TranscriptionError(
            "backend_unavailable",
            "The faster-whisper backend is not installed in this build.",
            "Use transcription.backend: fixture:<path> or fake.",
        )
    raise TranscriptionError(
        "unknown_backend",
        f"Unknown transcription backend: {name!r}",
        "Use faster_whisper, fixture:<path> or fake.",
    )
