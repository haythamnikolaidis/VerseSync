"""T-13: canon validation (docs/04-reference-detection.md section 5) and duplicate suppression."""

from __future__ import annotations

from dataclasses import replace

import pytest
from word_helpers import words

from versesync.detect.canon import load_canon
from versesync.detect.detector import (
    DEFAULT_DUPLICATE_COOLDOWN_S,
    DEFAULT_MAX_RANGE,
    DetectorConfig,
    ScoredDetection,
    detect_references,
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

CANON = load_canon()


def ref(osis: str, chapter: int, verse: int | None = None, end: int | None = None) -> Reference:
    book = CANON.by_osis(osis)
    assert book is not None
    return Reference(book.name, osis, chapter, verse, end)


def found(*parts: str | float, config: DetectorConfig | None = None) -> tuple[ScoredDetection, ...]:
    return detect_references(words(*parts), config=config).detections


def displays(*parts: str | float, config: DetectorConfig | None = None) -> list[str]:
    return [s.reference.display for s in found(*parts, config=config)]


# -- rejection ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "jude 5 : 1",  # Jude has one chapter
        "psalm 151 : 1",  # Psalms ends at 150
        "john 3 : 100",  # John 3 has 36 verses
        "john chapter 22",  # John has 21 chapters
        "romans 8 : 40",
        "genesis 51",
    ],
)
def test_impossible_references_are_rejected(text: str) -> None:
    assert found(text) == ()


def test_boundary_references_are_kept() -> None:
    assert displays("john 3 : 36") == ["John 3:36"]
    assert displays("psalm 150") == ["Psalm 150"]
    assert displays("psalm 119 : 176") == ["Psalm 119:176"]
    assert displays("jude verse 25") == ["Jude 1:25"]


def test_single_chapter_book_with_verse_past_the_end_is_rejected() -> None:
    assert found("jude verse 26") == ()


def test_unknown_book_is_discarded() -> None:
    det = match_grammar(words("john 3 : 16")).detections[0]
    bogus = replace(det, reference=Reference("Hezekiah", "Hez", 1, 1))
    assert validate_detection(bogus, CANON) is None
    assert validate_reference(bogus.reference, CANON, DEFAULT_MAX_RANGE) is None


def test_a_rejected_reference_does_not_remove_the_rest() -> None:
    assert displays("jude 5 : 1", "then john 3 : 16") == ["John 3:16"]


# -- ranges ---------------------------------------------------------------------------------


def test_reversed_range_swaps_when_the_swap_validates() -> None:
    assert displays("john 3 : 18 - 16") == ["John 3:16-18"]
    assert displays("1 corinthians 6 , 20 and 19") == ["1 Corinthians 6:19-20"]


def test_reversed_range_drops_the_end_when_the_swap_is_invalid() -> None:
    fixed = validate_reference(ref("John", 3, 16, 0), CANON, DEFAULT_MAX_RANGE)
    assert fixed == ref("John", 3, 16)


def test_range_past_the_chapter_drops_the_end() -> None:
    assert displays("john 3 : 30 - 50") == ["John 3:30"]


def test_range_wider_than_max_range_drops_the_end() -> None:
    assert displays("psalm 119 : 1 - 60") == ["Psalm 119:1"]


def test_max_range_boundary() -> None:
    assert validate_reference(ref("Ps", 119, 1, 31), CANON, 30) == ref("Ps", 119, 1, 31)
    assert validate_reference(ref("Ps", 119, 1, 32), CANON, 30) == ref("Ps", 119, 1)


def test_max_range_is_configurable() -> None:
    cfg = DetectorConfig(max_range=5)
    assert displays("psalm 119 : 1 - 10", config=cfg) == ["Psalm 119:1"]
    assert displays("psalm 119 : 1 - 6", config=cfg) == ["Psalm 119:1-6"]


def test_single_verse_range_drops_the_end() -> None:
    assert displays("john 3 : 16 - 16") == ["John 3:16"]


def test_repaired_range_keeps_its_span_facts() -> None:
    (only,) = found("john 3 : 18 - 16")
    assert only.detection.token_span == (0, 5)


# -- alternative readings -------------------------------------------------------------------


def test_psalms_with_one_valid_reading_has_no_alternative() -> None:
    (only,) = found("psalm one nineteen")
    assert only.reference == ref("Ps", 119)
    assert only.alternatives == ()


def test_psalms_dual_reading_keeps_both_and_prefers_the_concatenation() -> None:
    (only,) = found("psalm twelve two")
    assert only.reference == ref("Ps", 122)
    assert [a.reference for a in only.alternatives] == [ref("Ps", 12, 2)]
    assert only.breakdown.validation == 1.0


def test_impossible_primary_promotes_the_valid_alternative() -> None:
    det = Detection(
        pattern="P8",
        reference=ref("John", 3, 100),
        alternatives=(Alternative(ref("John", 3, 10), "alt"),),
        contextual=False,
        book_match=BookMatchInfo("exact", 0),
        token_span=(0, 3),
        word_span=(0, 3),
        source_start=0.0,
        source_end=1.0,
        word_probs=(0.9,),
    )
    result = validate_detection(det, CANON)
    assert result is not None
    fixed, promoted = result
    assert promoted
    assert fixed.reference == ref("John", 3, 10)
    assert fixed.alternatives == ()


def test_alternatives_that_are_impossible_are_dropped() -> None:
    det = match_grammar(words("psalm twelve two")).detections[0]
    bad = replace(det, alternatives=(Alternative(ref("Ps", 12, 99), "bad"),))
    result = validate_detection(bad, CANON)
    assert result is not None
    assert result[0].alternatives == ()
    assert not result[1]


def test_carried_verse_is_validated_against_the_carried_chapter() -> None:
    assert displays("jude verse 3", 5.0, "and verse 40") == ["Jude 1:3"]
    assert displays("john 3 : 16", 5.0, "and verse 17") == ["John 3:16", "John 3:17"]
    assert displays("john 3 : 16", 5.0, "and verse 99") == ["John 3:16"]


# -- duplicate suppression ------------------------------------------------------------------


def test_repeat_inside_the_window_is_retained_and_suppressed() -> None:
    first, second = found("john 3 : 16", 20.0, "john 3 : 16")
    assert not first.suppressed
    assert second.suppressed
    assert "suppressed_duplicate" in second.flags
    assert "suppressed_duplicate" not in first.flags


def test_three_repeats_give_one_cue_and_two_suppressed_rows() -> None:
    rows = found("john 3 : 16", 10.0, "john 3 : 16", 10.0, "john 3 : 16")
    assert [r.suppressed for r in rows] == [False, True, True]


def test_repeat_after_the_cooldown_is_a_new_cue() -> None:
    rows = found("john 3 : 16", 90.0, "john 3 : 16")
    assert [r.suppressed for r in rows] == [False, False]


def test_suppressed_repeats_do_not_extend_the_window() -> None:
    # Mentions at about 0 s, 40 s and 80 s: the third is 80 s after the last kept one.
    rows = found("john 3 : 16", 40.0, "john 3 : 16", 40.0, "john 3 : 16")
    assert [r.suppressed for r in rows] == [False, True, False]


def test_cooldown_is_configurable() -> None:
    cfg = DetectorConfig(duplicate_cooldown_s=5.0)
    tight = found("john 3 : 16", 2.0, "john 3 : 16", config=cfg)
    assert tight[1].suppressed
    loose = found("john 3 : 16", 30.0, "john 3 : 16", config=cfg)
    assert not loose[1].suppressed
    assert DEFAULT_DUPLICATE_COOLDOWN_S == 60.0


def test_different_references_are_never_suppressed() -> None:
    rows = found("john 3 : 16", 5.0, "john 3 : 17", 5.0, "john 3 : 16 - 17", 5.0, "john 3")
    assert [r.suppressed for r in rows] == [False] * 4


def test_suppressed_rows_survive_in_transcript_order() -> None:
    rows = found("john 3 : 16", 5.0, "romans 8 : 28", 5.0, "john 3 : 16")
    assert [r.reference.display for r in rows] == ["John 3:16", "Romans 8:28", "John 3:16"]
    assert [r.suppressed for r in rows] == [False, False, True]
