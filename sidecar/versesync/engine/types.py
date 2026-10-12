"""Result types. ``Word`` mirrors the entries of the transcript fixtures (T-41)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float
    probability: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Transcript:
    words: list[Word] = field(default_factory=list)
    language: str | None = None
    language_probability: float | None = None
    duration: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "language_probability": self.language_probability,
            "duration": self.duration,
            "words": [w.to_dict() for w in self.words],
        }
