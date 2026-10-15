"""The canon table: books, aliases, chapter and verse counts (loaded from ``canon.json``)."""

from __future__ import annotations

import functools
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

_CANON_PATH = Path(__file__).resolve().parent / "data" / "canon.json"
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalise_alias(text: str) -> str:
    """Lowercase, ASCII-fold, strip punctuation and collapse whitespace."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return _NON_ALNUM.sub(" ", folded.lower()).strip()


@dataclass(frozen=True)
class Book:
    name: str
    display_name: str
    osis: str
    numbered: bool
    base: str | None
    ordinal: int | None
    chapter_count: int
    verse_counts: tuple[int, ...]
    aliases: tuple[str, ...]


class Canon:
    def __init__(self, books: tuple[Book, ...]) -> None:
        self.books = books
        self._by_osis = {b.osis: b for b in books}
        self._by_name = {b.name: b for b in books}
        # Aliases are normalised once, here, so lookup() only normalises its argument.
        self._by_alias: dict[str, Book] = {}
        for book in books:
            for alias in (book.name, book.display_name, *book.aliases):
                self._by_alias.setdefault(normalise_alias(alias), book)
        self._numbered_bases = frozenset(b.base for b in books if b.base is not None)
        self._max_alias_tokens = max(len(key.split()) for key in self._by_alias)

    def by_osis(self, osis: str) -> Book:
        return self._by_osis[osis]

    def by_name(self, name: str) -> Book:
        return self._by_name[name]

    def lookup(self, text: str) -> Book | None:
        return self._by_alias.get(normalise_alias(text))

    def numbered_bases(self) -> frozenset[str]:
        return self._numbered_bases

    def max_alias_tokens(self) -> int:
        return self._max_alias_tokens

    def verse_count(self, book: Book, chapter: int) -> int | None:
        if 1 <= chapter <= len(book.verse_counts):
            return book.verse_counts[chapter - 1]
        return None


@functools.cache
def load_canon() -> Canon:
    with _CANON_PATH.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    books = tuple(
        Book(
            name=b["name"],
            display_name=b["display_name"],
            osis=b["osis"],
            numbered=b["numbered"],
            base=b["base"],
            ordinal=b["ordinal"],
            chapter_count=b["chapter_count"],
            verse_counts=tuple(b["verse_counts"]),
            aliases=tuple(b["aliases"]),
        )
        for b in raw
    )
    return Canon(books)
