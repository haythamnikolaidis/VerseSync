"""Confidence scoring (docs/04-reference-detection.md section 6)."""

from __future__ import annotations

from versesync.detect.grammar import Candidate

W_BOOK = 0.40
W_ASR = 0.25
W_STRUCTURE = 0.25
W_VALIDATION = 0.10

BOOK_EXACT = 1.0
BOOK_ALIAS = 0.85
BOOK_FUZZY_D1 = 0.65
BOOK_FUZZY_D2 = 0.55

STRUCT_VERSE = 1.0
STRUCT_RANGE = 0.75
STRUCT_CHAPTER = 0.55
STRUCT_CONTEXT = 0.45


def _book_score(c: Candidate) -> float:
    match = c.book_match
    if match.tier == "exact":
        return BOOK_EXACT
    if match.tier == "alias":
        return BOOK_ALIAS
    return BOOK_FUZZY_D1 if match.distance <= 1 else BOOK_FUZZY_D2


def _structure_score(c: Candidate) -> float:
    if c.contextual:
        return STRUCT_CONTEXT
    if c.verse is None:
        return STRUCT_CHAPTER
    if c.verse_end is not None:
        return STRUCT_RANGE
    return STRUCT_VERSE


def score(c: Candidate, validation_score: float) -> float:
    """Weighted confidence of a validated candidate, clamped to [0, 1]."""
    total = (
        W_BOOK * _book_score(c)
        + W_ASR * c.asr_prob
        + W_STRUCTURE * _structure_score(c)
        + W_VALIDATION * validation_score
    )
    return min(1.0, max(0.0, total))
