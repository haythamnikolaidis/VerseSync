"""Confidence scoring (docs/04-reference-detection.md section 6)."""

from __future__ import annotations

from dataclasses import replace

import pytest

from versesync.detect import confidence as conf
from versesync.detect.canon import load_canon
from versesync.detect.confidence import score
from versesync.detect.grammar import Candidate
from versesync.detect.types import BookMatch

CANON = load_canon()


def cand(
    verse: int | None = 16,
    verse_end: int | None = None,
    contextual: bool = False,
    tier: str = "exact",
    distance: int = 0,
    asr_prob: float = 1.0,
) -> Candidate:
    b = CANON.by_osis("John")
    return Candidate(
        book=b,
        chapter=3,
        verse=verse,
        verse_end=verse_end,
        pattern="P1",
        contextual=contextual,
        book_match=BookMatch(book=b, tier=tier, distance=distance, first=0, last=0),
        token_span=(0, 3),
        word_span=(0, 3),
        source_start=0.0,
        source_end=1.0,
        asr_prob=asr_prob,
    )


def expected(book: float, asr: float, struct: float, validation: float) -> float:
    return (
        conf.W_BOOK * book
        + conf.W_ASR * asr
        + conf.W_STRUCTURE * struct
        + conf.W_VALIDATION * validation
    )


def test_weights_sum_to_one():
    total = conf.W_BOOK + conf.W_ASR + conf.W_STRUCTURE + conf.W_VALIDATION
    assert total == pytest.approx(1.0)


@pytest.mark.parametrize(
    ("kwargs", "struct"),
    [
        ({"verse": 16}, 1.0),
        ({"verse": 16, "verse_end": 18}, 0.75),
        ({"verse": None}, 0.55),
        ({"verse": 16, "contextual": True}, 0.45),
        ({"verse": None, "contextual": True}, 0.45),
        ({"verse": 16, "verse_end": 18, "contextual": True}, 0.45),
    ],
)
def test_structure_scores(kwargs, struct):
    assert score(cand(asr_prob=0.8, **kwargs), 1.0) == pytest.approx(
        expected(1.0, 0.8, struct, 1.0)
    )


@pytest.mark.parametrize(
    ("tier", "distance", "book"),
    [("exact", 0, 1.0), ("alias", 0, 0.85), ("fuzzy", 1, 0.65), ("fuzzy", 2, 0.55)],
)
def test_book_tiers(tier, distance, book):
    c = cand(tier=tier, distance=distance, asr_prob=0.9)
    assert score(c, 0.5) == pytest.approx(expected(book, 0.9, 1.0, 0.5))


def test_validation_score_contributes():
    c = cand()
    assert score(c, 1.0) - score(c, 0.5) == pytest.approx(0.05)


def test_clamped_to_unit_interval():
    assert score(cand(asr_prob=5.0), 1.0) == 1.0
    low = replace(cand(tier="fuzzy", distance=2, asr_prob=-5.0), contextual=True)
    assert score(low, 0.0) == 0.0


def test_deterministic():
    c = cand(asr_prob=0.73)
    assert len({score(c, 0.5) for _ in range(5)}) == 1
