"""Stage 3, canon validation (docs/04-reference-detection.md section 5)."""

from __future__ import annotations

from dataclasses import replace

from versesync.detect.canon import Canon
from versesync.detect.grammar import Candidate

# Score for a candidate that is valid only after promoting an alternative reading (T-13 card).
ALTERNATIVE_SCORE = 0.5


def _in_canon(c: Candidate, canon: Canon) -> bool:
    try:
        return canon.by_osis(c.book.osis) == c.book
    except KeyError:
        return False


def _verse_ok(c: Candidate, canon: Canon, verse: int) -> bool:
    count = canon.verse_count(c.book, c.chapter)
    return count is not None and 1 <= verse <= count


def _fix_range(c: Candidate, canon: Canon, max_range: int) -> Candidate:
    """Rules 4 and 5: repair or drop ``verse_end`` on a candidate whose start is valid."""
    if c.verse is None or c.verse_end is None:
        return c
    end = c.verse_end
    if end < c.verse:
        # Reversed range: swap when the swapped range validates, otherwise drop the end.
        if _verse_ok(c, canon, end):
            return replace(c, verse=end, verse_end=c.verse)
        return replace(c, verse_end=None)
    if not _verse_ok(c, canon, end) or end - c.verse > max_range:
        return replace(c, verse_end=None)
    return c


def _strict(c: Candidate, canon: Canon, max_range: int) -> Candidate | None:
    """Rules 1-3 without alternative promotion, then the range rules."""
    if not _in_canon(c, canon):
        return None
    count = canon.verse_count(c.book, c.chapter)
    if count is None:
        return None
    if c.verse is not None and not _verse_ok(c, canon, c.verse):
        return None
    return _fix_range(c, canon, max_range)


def validate(c: Candidate, canon: Canon, max_range: int = 30) -> tuple[Candidate, float] | None:
    """Return the candidate (possibly adjusted) and its validation score, or None to discard.

    Alternatives are validated too; invalid ones are dropped. A candidate whose verse is out of
    range is replaced by its first valid alternative, scored ``ALTERNATIVE_SCORE``.
    """
    alternatives = tuple(
        v for a in c.alternatives if (v := _strict(a, canon, max_range)) is not None
    )
    if not _in_canon(c, canon):
        return None
    count = canon.verse_count(c.book, c.chapter)
    if count is None:
        return None
    if c.verse is not None and not _verse_ok(c, canon, c.verse):
        if not alternatives:
            return None
        promoted = alternatives[0]
        return replace(promoted, alternatives=alternatives[1:]), ALTERNATIVE_SCORE
    return replace(_fix_range(c, canon, max_range), alternatives=alternatives), 1.0
