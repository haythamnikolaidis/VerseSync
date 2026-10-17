"""Parse a reference an editor typed or sent as an object (docs/07 ``POST /resolve``).

Typed text goes through the same normalize, grammar and validation stages that detection uses,
so what an editor types is judged by exactly the same canon and patterns.
"""

from __future__ import annotations

from typing import Any

from versesync.detect.canon import Book, Canon, load_canon
from versesync.detect.grammar import Candidate, find_candidates
from versesync.detect.normalize import normalize
from versesync.detect.validate import validate
from versesync.types import Reference, Word


class InvalidReference(ValueError):
    """A reference that cannot be used; ``message`` is written for the editor."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _unreadable(text: str) -> InvalidReference:
    return InvalidReference(f'Couldn\'t read "{text}" as a scripture reference.')


def _check_range(book: Book, canon: Canon, chapter: int, verse: int | None) -> None:
    """Raise the editor-readable message when chapter or verse is outside the canon."""
    if not 1 <= chapter <= book.chapter_count:
        raise InvalidReference(
            f"{book.display_name} has only {_plural(book.chapter_count, 'chapter')}."
        )
    count = canon.verse_count(book, chapter) or 0
    if verse is not None and not 1 <= verse <= count:
        raise InvalidReference(f"{book.display_name} {chapter} has only {_plural(count, 'verse')}.")


def _from_dict(data: dict[str, Any], canon: Canon) -> Reference:
    try:
        book = canon.by_osis(str(data["osis"]))
        chapter = int(data["chapter"])
        verse = None if data.get("verse") is None else int(data["verse"])
        verse_end = None if data.get("verse_end") is None else int(data["verse_end"])
    except (KeyError, TypeError, ValueError):
        raise InvalidReference("Couldn't read that as a scripture reference.") from None
    _check_range(book, canon, chapter, verse)
    if verse_end is not None:
        if verse is None:
            raise InvalidReference("A verse range needs a starting verse.")
        _check_range(book, canon, chapter, verse_end)
        if verse_end <= verse:
            raise InvalidReference(f"Verse {verse_end} does not come after verse {verse}.")
    return Reference(
        book=book.name, osis=book.osis, chapter=chapter, verse=verse, verse_end=verse_end
    )


def _whole_string(candidates: list[Candidate], count: int) -> Candidate | None:
    found = [c for c in candidates if not c.contextual]
    if len(found) != 1 or len(candidates) != 1:
        return None
    # Word spans are inclusive: the one candidate must cover every word that was typed.
    return found[0] if found[0].word_span == (0, count - 1) else None


def parse_reference(text: str | dict[str, Any], canon: Canon | None = None) -> Reference:
    """Validate ``text`` (a typed string or a canonical object) and return a ``Reference``."""
    canon = canon or load_canon()
    if isinstance(text, dict):
        return _from_dict(text, canon)

    # Fake times: only the word order matters, and detection is deterministic without a clock.
    words = [
        Word(text=w, start=float(i), end=float(i) + 1.0, probability=1.0)
        for i, w in enumerate(text.split())
    ]
    if not words:
        raise _unreadable(text)
    candidate = _whole_string(find_candidates(normalize(words, canon), canon), len(words))
    if candidate is None:
        raise _unreadable(text)
    _check_range(candidate.book, canon, candidate.chapter, candidate.verse)
    valid = validate(candidate, canon)
    if valid is None:
        raise _unreadable(text)
    c = valid[0]
    return Reference(
        book=c.book.name,
        osis=c.book.osis,
        chapter=c.chapter,
        verse=c.verse,
        verse_end=c.verse_end,
    )
