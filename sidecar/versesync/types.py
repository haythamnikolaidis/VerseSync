"""Core types shared by every pipeline stage."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from versesync.detect.canon import Canon


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float
    probability: float


def load_words(path: str | Path) -> list[Word]:
    """Read a ``*.words.json`` transcript into a list of ``Word``."""
    with Path(path).open("r", encoding="utf-8") as f:
        raw = json.load(f)
    return [
        Word(
            text=str(w["text"]),
            start=float(w["start"]),
            end=float(w["end"]),
            probability=float(w["probability"]),
        )
        for w in raw
    ]


@dataclass(frozen=True)
class Reference:
    book: str
    osis: str
    chapter: int
    verse: int | None = None
    verse_end: int | None = None

    def display(self, canon: Canon) -> str:
        """Human form such as ``1 Corinthians 6:19-20`` (hyphen, never an en-dash)."""
        text = f"{canon.by_osis(self.osis).display_name} {self.chapter}"
        if self.verse is not None:
            text += f":{self.verse}"
            if self.verse_end is not None:
                text += f"-{self.verse_end}"
        return text

    def to_json(self) -> dict[str, Any]:
        """Schema shape (07 section 5); keys whose value is ``None`` are omitted."""
        out: dict[str, Any] = {"book": self.book, "osis": self.osis, "chapter": self.chapter}
        if self.verse is not None:
            out["verse"] = self.verse
        if self.verse_end is not None:
            out["verse_end"] = self.verse_end
        return out
