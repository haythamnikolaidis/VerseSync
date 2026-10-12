"""T-13: confidence scoring (docs/04-reference-detection.md section 6)."""

from __future__ import annotations

import pytest
from word_helpers import words

from versesync.detect import detector
from versesync.detect.canon import load_canon
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
    validate_detection,
    validate_reference,
)
from versesync.detect.grammar import (
    Alternative,
    BookMatchInfo,
    Detection,
    Reference,
    match_grammar,
)


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
    # 0.65 * (1 - 0.10 * (d - 1)) for edit distance d >= 1 (docs/04 section 6).
    assert detector.FUZZY_DISTANCE_STEP == 0.10
    assert detector.BOOK_SCORE_FUZZY == 0.65
    assert book_score("fuzzy", 1) == pytest.approx(0.65, abs=1e-12)
    assert book_score("fuzzy", 2) == pytest.approx(0.585, abs=1e-12)
    assert book_score("fuzzy", 3) == pytest.approx(0.52, abs=1e-12)
    assert book_score("fuzzy", 4) == pytest.approx(0.455, abs=1e-12)
    assert book_score("fuzzy", 7) == pytest.approx(0.26, abs=1e-12)


def test_fuzzy_book_score_is_floored_at_zero() -> None:
    assert book_score("fuzzy", 11) == pytest.approx(0.0, abs=1e-12)
    assert book_score("fuzzy", 12) == 0.0
    assert book_score("fuzzy", 99) == 0.0


def test_exact_and_alias_book_scores_ignore_distance() -> None:
    assert book_score("alias", 0) == 0.85
    assert book_score("alias", 3) == 0.85
    assert book_score("exact", 0) == 1.0
    assert book_score("exact", 3) == 1.0


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


# -- hand-built detections ------------------------------------------------------------------

CANON = load_canon()


def ref(osis: str, chapter: int, verse: int | None = None, end: int | None = None) -> Reference:
    book = CANON.by_osis(osis)
    assert book is not None
    return Reference(book.name, osis, chapter, verse, end)


def make_det(
    reference: Reference,
    alternatives: tuple[Alternative, ...] = (),
    *,
    tier: str = "exact",
    distance: int = 0,
    probs: tuple[float, ...] = (0.9,),
    contextual: bool = False,
) -> Detection:
    return Detection(
        pattern="P8",
        reference=reference,
        alternatives=alternatives,
        contextual=contextual,
        book_match=BookMatchInfo(tier, distance),
        token_span=(0, 3),
        word_span=(0, 3),
        source_start=0.0,
        source_end=1.0,
        word_probs=probs,
    )


def validated_score(det: Detection) -> ScoredDetection:
    checked = validate_detection(det, CANON)
    assert checked is not None
    valid, promoted = checked
    return score_detection(valid, promoted)


# -- repaired ranges keep full validation credit (docs/04 sections 5 and 6) ------------------


def test_swapped_range_keeps_validation_score_one() -> None:
    s = validated_score(make_det(ref("John", 3, 18, 16)))
    assert s.reference == ref("John", 3, 16, 18)
    assert s.breakdown.validation == 1.0
    assert s.breakdown.structure == 0.75  # still a range after the swap
    assert s.confidence == 0.9125  # 0.40 + 0.225 + 0.1875 + 0.10


@pytest.mark.parametrize(
    "bad_end",
    [
        pytest.param(0, id="reversed-swap-invalid"),
        pytest.param(16, id="zero-length"),
        pytest.param(180, id="past-chapter-end"),
        pytest.param(47, id="wider-than-max-range"),
    ],
)
def test_dropped_end_keeps_validation_score_one(bad_end: int) -> None:
    s = validated_score(make_det(ref("Ps", 119, 16, bad_end)))
    assert s.reference == ref("Ps", 119, 16)
    assert s.breakdown.validation == 1.0
    assert s.breakdown.structure == 1.0  # a single verse once the end is gone
    assert s.confidence == 0.975  # 0.40 + 0.225 + 0.25 + 0.10


def test_range_past_the_chapter_end_keeps_validation_score_one() -> None:
    s = validated_score(make_det(ref("John", 3, 30, 50)))  # John 3 has 36 verses
    assert s.reference == ref("John", 3, 30)
    assert s.breakdown.validation == 1.0
    assert s.confidence == 0.975


def test_zero_length_range_keeps_the_start() -> None:
    assert validate_reference(ref("John", 3, 16, 16), CANON, 30) == ref("John", 3, 16)


def test_only_a_promoted_alternative_scores_half_validation() -> None:
    s = validated_score(make_det(ref("John", 3, 100), (Alternative(ref("John", 3, 10), "alt"),)))
    assert s.reference == ref("John", 3, 10)
    assert s.breakdown.validation == 0.5
    assert s.confidence == 0.925  # 0.40 + 0.225 + 0.25 + 0.05


# -- alternatives are capped at the previous reading (docs/04 section 6) ---------------------

ALT_VERSE = ref("John", 3, 17)  # structure 1.0 -> own score 0.925
ALT_RANGE = ref("John", 3, 17, 19)  # structure 0.75 -> own score 0.8625
ALT_CHAPTER = ref("John", 3)  # structure 0.55 -> own score 0.8125


def alts(*refs: Reference) -> tuple[Alternative, ...]:
    return tuple(Alternative(r, f"alt{i}") for i, r in enumerate(refs))


def test_a_single_alternative_that_would_outscore_the_primary_is_capped() -> None:
    primary = ref("John", 3, 16, 18)  # range -> 0.4 + 0.225 + 0.1875 + 0.1 = 0.9125
    s = score_detection(make_det(primary, alts(ALT_VERSE)))
    assert s.confidence == 0.9125
    assert [a.confidence for a in s.alternatives] == [0.9125]  # own 0.925, capped


def test_descending_alternatives_keep_their_own_scores() -> None:
    s = score_detection(make_det(ref("John", 3, 16), alts(ALT_VERSE, ALT_RANGE, ALT_CHAPTER)))
    assert s.confidence == 0.975
    assert [a.confidence for a in s.alternatives] == [0.925, 0.8625, 0.8125]


def test_a_later_alternative_that_would_score_higher_is_capped_at_the_previous_one() -> None:
    # Own scores in order: 0.8125, 0.925, 0.8625; the cap is the running minimum.
    s = score_detection(make_det(ref("John", 3, 16), alts(ALT_CHAPTER, ALT_VERSE, ALT_RANGE)))
    assert s.confidence == 0.975
    assert [a.confidence for a in s.alternatives] == [0.8125, 0.8125, 0.8125]


def test_alternatives_never_increase_down_the_list() -> None:
    s = score_detection(
        make_det(ref("John", 3, 16), alts(ALT_RANGE, ALT_VERSE, ALT_CHAPTER, ALT_VERSE))
    )
    confidences = [s.confidence, *(a.confidence for a in s.alternatives)]
    assert confidences == [0.975, 0.8625, 0.8625, 0.8125, 0.8125]


def test_an_alternative_is_capped_at_the_primary_when_the_primary_is_lowest() -> None:
    s = score_detection(make_det(ref("John", 3), alts(ALT_VERSE, ALT_RANGE)))
    assert s.confidence == 0.8625  # chapter-only, validation 1.0
    assert [a.confidence for a in s.alternatives] == [0.8625, 0.8625]


def test_alternatives_use_half_validation_and_keep_reason_and_reference() -> None:
    s = score_detection(make_det(ref("John", 3, 16), alts(ALT_VERSE)))
    (alt,) = s.alternatives
    assert alt.reference == ALT_VERSE
    assert alt.reason == "alt0"
    assert alt.confidence == 0.925  # validation 0.5, not 1.0 (which would be 0.975)


def test_alternative_scores_through_the_whole_pipeline() -> None:
    s = one("psalm twelve two")
    assert s.reference.display == "Psalm 122"
    assert s.confidence == 0.8625  # chapter-only: 0.40 + 0.225 + 0.1375 + 0.10
    # Psalm 12:2 would score 0.925 on its own; it is capped at the preferred reading.
    assert [a.confidence for a in s.alternatives] == [0.8625]


# -- other section 6 rules, exactly ---------------------------------------------------------


def test_each_term_contributes_with_its_documented_weight() -> None:
    det = make_det(ref("John", 3, 16), tier="fuzzy", distance=2, probs=(0.5, 0.7))
    s = score_detection(det)
    assert s.breakdown.book == pytest.approx(0.585)
    assert s.breakdown.asr == pytest.approx(0.6)
    assert (s.breakdown.structure, s.breakdown.validation) == (1.0, 1.0)
    assert s.confidence == 0.734  # 0.40 * 0.585 + 0.25 * 0.6 + 0.25 + 0.10


def test_asr_score_is_clamped_to_the_unit_interval() -> None:
    assert score_detection(make_det(ref("John", 3, 16), probs=(1.4,))).breakdown.asr == 1.0
    assert score_detection(make_det(ref("John", 3, 16), probs=(-0.2,))).breakdown.asr == 0.0


def test_the_best_possible_confidence_is_exactly_one() -> None:
    assert score_detection(make_det(ref("John", 3, 16), probs=(1.0,))).confidence == 1.0


def test_the_lowest_confidence_is_still_scored_not_discarded() -> None:
    det = make_det(ref("John", 3), tier="fuzzy", distance=50, probs=(0.0,))
    assert score_detection(det).confidence == 0.2375  # book 0, asr 0, 0.25 * 0.55 + 0.10


def test_a_context_carried_alternative_uses_the_context_structure() -> None:
    s = score_detection(make_det(ref("John", 3, 16), alts(ALT_VERSE), contextual=True))
    assert s.confidence == 0.8375  # 0.40 + 0.225 + 0.1125 + 0.10
    assert [a.confidence for a in s.alternatives] == [0.7875]  # validation 0.5


def test_confidence_is_rounded_to_four_decimals() -> None:
    s = score_detection(make_det(ref("John", 3, 16), probs=(0.123456789,)))
    assert s.confidence == 0.7809  # 0.40 + 0.0308641972 + 0.25 + 0.10


def test_corroboration_adds_exactly_the_bonus() -> None:
    s = score_detection(make_det(ref("John", 3), probs=(0.5,)))
    assert s.confidence == 0.7625
    assert apply_corroboration(s).confidence == 0.8625


def test_corroboration_does_not_touch_the_breakdown_or_alternatives() -> None:
    s = score_detection(make_det(ref("John", 3, 16), alts(ALT_CHAPTER), probs=(0.5,)))
    bumped = apply_corroboration(s)
    assert bumped.breakdown == s.breakdown
    assert bumped.alternatives == s.alternatives


def test_the_flag_threshold_is_compared_to_the_exact_confidence() -> None:
    det = make_det(ref("John", 3), tier="fuzzy", distance=50, probs=(0.0,))
    assert "low_confidence" in score_detection(det).flags
    at = DetectorConfig(low_confidence_threshold=0.2375)
    assert "low_confidence" not in score_detection(det, config=at).flags
    above = DetectorConfig(low_confidence_threshold=0.2376)
    assert "low_confidence" in score_detection(det, config=above).flags
