"""Canon validation rules (docs/04-reference-detection.md section 5)."""

from __future__ import annotations

from dataclasses import replace

from versesync.detect.canon import Book, load_canon
from versesync.detect.grammar import Candidate
from versesync.detect.types import BookMatch
from versesync.detect.validate import validate

CANON = load_canon()


def cand(
    book: str,
    chapter: int,
    verse: int | None = None,
    verse_end: int | None = None,
    alternatives: tuple[Candidate, ...] = (),
) -> Candidate:
    b = CANON.by_osis(book)
    return Candidate(
        book=b,
        chapter=chapter,
        verse=verse,
        verse_end=verse_end,
        pattern="P1",
        contextual=False,
        book_match=BookMatch(book=b, tier="exact", distance=0, first=0, last=0),
        token_span=(0, 3),
        word_span=(0, 3),
        source_start=0.0,
        source_end=1.0,
        asr_prob=1.0,
        alternatives=alternatives,
    )


def ok(c: Candidate, max_range: int = 30) -> tuple[Candidate, float]:
    result = validate(c, CANON, max_range)
    assert result is not None
    return result


def test_unknown_book_is_discarded():
    real = CANON.by_osis("John")
    fake = Book(
        name="nowhere",
        display_name="Nowhere",
        osis="Nowhere",
        numbered=False,
        base=None,
        ordinal=None,
        chapter_count=3,
        verse_counts=(5, 5, 5),
        aliases=(),
    )
    assert validate(replace(cand("John", 3, 16), book=fake), CANON) is None
    assert ok(replace(cand("John", 3, 16), book=real))[1] == 1.0


def test_chapter_beyond_count_is_discarded():
    assert validate(cand("Jude", 5, 1), CANON) is None
    assert validate(cand("Ps", 151, 1), CANON) is None
    assert validate(cand("John", 0, 1), CANON) is None
    assert ok(cand("Jude", 1, 5))[1] == 1.0


def test_verse_beyond_count_is_discarded_without_alternative():
    assert validate(cand("John", 3, 100), CANON) is None
    assert ok(cand("Ps", 119, 176))[1] == 1.0
    assert ok(cand("Obad", 1, 21))[1] == 1.0
    assert validate(cand("Obad", 1, 22), CANON) is None


def test_verse_beyond_count_promotes_valid_alternative():
    alt = cand("John", 3, 16)
    result = ok(cand("John", 3, 116, alternatives=(alt,)))
    assert result[1] == 0.5
    assert (result[0].chapter, result[0].verse) == (3, 16)


def test_invalid_alternative_does_not_rescue():
    bad = cand("John", 3, 99)
    assert validate(cand("John", 3, 116, alternatives=(bad,)), CANON) is None


def test_invalid_alternatives_are_dropped_from_valid_candidate():
    good = cand("John", 3, 17)
    bad = cand("John", 3, 99)
    unknown_chapter = cand("Jude", 5, 1)
    c, score = ok(cand("John", 3, 16, alternatives=(bad, good, unknown_chapter)))
    assert score == 1.0
    assert [a.verse for a in c.alternatives] == [17]


def test_reversed_range_swaps_when_valid():
    c, score = ok(cand("John", 3, 18, 16))
    assert (c.verse, c.verse_end, score) == (16, 18, 1.0)


def test_reversed_range_drops_end_when_swap_is_invalid():
    c, _ = ok(cand("Obad", 1, 10, 0))
    assert (c.verse, c.verse_end) == (10, None)


def test_range_over_max_drops_end():
    c, _ = ok(cand("Ps", 119, 1, 40))
    assert (c.verse, c.verse_end) == (1, None)
    c, _ = ok(cand("Ps", 119, 1, 31))
    assert (c.verse, c.verse_end) == (1, 31)
    c, _ = ok(cand("Ps", 119, 1, 12), max_range=5)
    assert c.verse_end is None


def test_range_end_beyond_chapter_is_dropped():
    c, _ = ok(cand("Obad", 1, 20, 25))
    assert (c.verse, c.verse_end) == (20, None)


def test_chapter_only_candidate_validates():
    c, score = ok(cand("John", 3))
    assert (c.verse, score) == (None, 1.0)
