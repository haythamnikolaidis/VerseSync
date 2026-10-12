"""T-13: confidence scoring (docs/04-reference-detection.md section 6)."""

from __future__ import annotations

import pytest
from word_helpers import words

from versesync.detect import detector
from versesync.detect.detector import (
    CORROBORATION_BONUS,
    DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    STRUCTURE_CHAPTER_ONLY,
    STRUCTURE_CONTEXT,
    STRUCTURE_RANGE,
    STRUCTURE_VERSE,
    DetectorConfig,
    ScoredDetection,
    apply_corroboration,
    book_score,
    detect_references,
    score_detection,
)
from versesync.detect.grammar import match_grammar


def one(*parts: str | float, prob: float = 0.9) -> ScoredDetection:
    found = detect_references(words(*parts, prob=prob)).detections
    assert len(found) == 1, [f.reference.display for f in found]
    return found[0]


def expected(book: float, asr: float, structure: float, validation: float = 1.0) -> float:
    return round(0.40 * book + 0.25 * asr + 0.25 * structure + 0.10 * validation, 4)


# -- the formula ----------------------------------------------------------------------------


def test_weights_are_named_constants_summing_to_one() -> None:
    weights = (
        detector.WEIGHT_BOOK,
        detector.WEIGHT_ASR,
        detector.WEIGHT_STRUCTURE,
        detector.WEIGHT_VALIDATION,
    )
    assert weights == (0.40, 0.25, 0.25, 0.10)
    assert sum(weights) == pytest.approx(1.0)


def test_structure_scores_match_the_spec() -> None:
    assert (STRUCTURE_VERSE, STRUCTURE_RANGE, STRUCTURE_CHAPTER_ONLY, STRUCTURE_CONTEXT) == (
        1.0,
        0.75,
        0.55,
        0.45,
    )


def test_verse_reference_structure() -> None:
    s = one("john 3 : 16")
    assert s.breakdown.structure == 1.0
    assert s.confidence == expected(1.0, 0.9, 1.0)


def test_range_structure() -> None:
    s = one("1 corinthians 6 : 19 - 20")
    assert s.breakdown.structure == 0.75
    assert s.confidence == expected(1.0, 0.9, 0.75)


def test_chapter_only_structure() -> None:
    s = one("romans chapter 8")
    assert s.breakdown.structure == 0.55
    assert s.confidence == expected(1.0, 0.9, 0.55)


def test_context_carried_structure() -> None:
    carried = detect_references(words("john 3 : 16", 3.0, "and verse 17")).detections[1]
    assert carried.detection.contextual
    assert carried.breakdown.structure == 0.45


def test_context_carried_range_is_still_context_structure() -> None:
    carried = detect_references(words("john 3 : 16", 3.0, "verses 17 to 18")).detections[1]
    assert carried.breakdown.structure == 0.45


def test_asr_score_is_the_mean_word_probability() -> None:
    low = one("john 3 : 16", prob=0.5)
    assert low.breakdown.asr == pytest.approx(0.5)
    assert low.confidence == expected(1.0, 0.5, 1.0)


def test_book_tiers() -> None:
    assert one("john 3 : 16").breakdown.book == 1.0
    assert one("philippines 4 : 13").breakdown.book == 0.85  # curated confusion
    assert one("colosians 3 : 16").breakdown.book == 0.65  # fuzzy, one edit


def test_fuzzy_book_score_scales_with_distance() -> None:
    assert book_score("fuzzy", 1) == 0.65
    assert book_score("fuzzy", 2) < book_score("fuzzy", 1)
    assert book_score("fuzzy", 99) == 0.0
    assert book_score("alias", 0) == 0.85
    assert book_score("exact", 0) == 1.0


def test_validation_score_halves_for_a_promoted_alternative() -> None:
    det = match_grammar(words("john 3 : 16")).detections[0]
    assert score_detection(det, promoted=True).breakdown.validation == 0.5
    assert score_detection(det, promoted=False).breakdown.validation == 1.0


def test_confidence_stays_in_unit_interval() -> None:
    for text in ("john 3 : 16", "romans chapter 8", "jude verse 3"):
        for prob in (0.0, 0.5, 1.0):
            assert 0.0 <= one(text, prob=prob).confidence <= 1.0


def test_psalms_alternative_never_outranks_the_preferred_reading() -> None:
    s = one("psalm twelve two")
    assert s.alternatives
    assert all(a.confidence <= s.confidence for a in s.alternatives)


# -- determinism ----------------------------------------------------------------------------


def test_scores_are_deterministic() -> None:
    parts = ("john 3 : 16", 5.0, "turn to romans 8 , 28 and 29", 5.0, "psalm twelve two")
    first = detect_references(words(*parts))
    for _ in range(3):
        assert detect_references(words(*parts)).detections == first.detections


# -- flagging, never discarding -------------------------------------------------------------


def test_threshold_default_is_the_documented_value() -> None:
    assert DEFAULT_LOW_CONFIDENCE_THRESHOLD == 0.55
    assert DetectorConfig().low_confidence_threshold == 0.55


def test_low_confidence_is_flagged_not_discarded() -> None:
    s = one("colosians 3", prob=0.0)
    assert s.confidence < DEFAULT_LOW_CONFIDENCE_THRESHOLD
    assert "low_confidence" in s.flags


def test_confident_reference_is_not_flagged() -> None:
    assert "low_confidence" not in one("john 3 : 16").flags


def test_threshold_is_exclusive() -> None:
    s = one("colosians 3", prob=0.0)
    cfg = DetectorConfig(low_confidence_threshold=s.confidence)
    again = detect_references(words("colosians 3", prob=0.0), config=cfg).detections[0]
    assert "low_confidence" not in again.flags


def test_chapter_only_is_flagged() -> None:
    assert "chapter_only" in one("romans 8").flags
    assert "chapter_only" not in one("romans 8 : 1").flags


# -- corroboration hook ---------------------------------------------------------------------


def test_corroboration_adds_the_bonus() -> None:
    s = one("john 3 : 16", prob=0.8)
    bumped = apply_corroboration(s)
    assert bumped.corroborated
    assert bumped.confidence == pytest.approx(min(1.0, s.confidence + CORROBORATION_BONUS))
    assert CORROBORATION_BONUS == 0.10


def test_corroboration_is_idempotent_and_clamped() -> None:
    once = apply_corroboration(one("john 3 : 16", prob=1.0))
    assert once.confidence == 1.0
    assert apply_corroboration(once) == once


def test_corroboration_can_clear_the_low_confidence_flag() -> None:
    s = one("colosians 3", prob=0.0)
    assert "low_confidence" in s.flags
    bumped = apply_corroboration(s)
    assert bumped.confidence >= 0.55
    assert "low_confidence" not in bumped.flags
