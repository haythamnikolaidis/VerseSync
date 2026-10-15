import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from versesync.bible.base import Passage, RawVerse, Translation
from versesync.bible.resolver import Resolution
from versesync.cues import LOW_CONFIDENCE_THRESHOLD, build_cue
from versesync.detect.canon import Canon
from versesync.detect.detector import Detection
from versesync.detect.grammar import Candidate
from versesync.detect.types import BookMatch
from versesync.timing.align import Alignment
from versesync.timing.anchor import TimingConfig, compute_timing
from versesync.types import Reference

SCHEMA = json.loads(
    (Path(__file__).resolve().parent.parent / "schemas" / "cue-document.schema.json").read_text(
        encoding="utf-8"
    )
)
CUE_SCHEMA = {"$ref": "#/$defs/cue", "$defs": SCHEMA["$defs"]}
TRANSLATION = Translation("t1", "KJV", "King James Version", "Public domain.")
PANEL_FLAGS = {"cut_from_edit", "multiple_placements", "speed_change_unsupported"}


def _detection(
    canon: Canon,
    verse: int | None = 16,
    confidence: float = 0.9,
    flags: tuple[str, ...] = (),
    alternatives: tuple[tuple[Reference, float, str], ...] = (),
) -> Detection:
    book = canon.by_osis("John")
    cand = Candidate(
        book=book,
        chapter=3,
        verse=verse,
        verse_end=None,
        pattern="P2",
        contextual=False,
        book_match=BookMatch(book, "exact", 0, 0, 0),
        token_span=(10, 13),
        word_span=(12, 15),
        source_start=150.0,
        source_end=151.8,
        asr_prob=0.9,
    )
    return Detection(
        id="det_001",
        candidate=cand,
        reference=Reference(book.name, "John", 3, verse),
        confidence=confidence,
        validation_score=1.0,
        flags=flags,
        snippet="...turn with me to John three sixteen...",
        alternatives=alternatives,
    )


def _passage(canon: Canon, truncated: bool = False) -> Passage:
    ref = Reference("John", "John", 3, 16)
    text = "For God so loved the world."
    return Passage(
        reference=ref,
        reference_display="John 3:16",
        body="16 " + text,
        verses=(RawVerse(16, text),),
        word_count=6,
        translation=TRANSLATION,
        truncated=truncated,
        source="local",
    )


def _read() -> Alignment:
    return Alignment("read", 0.9, 152.8, 160.1, (20, 30))


def _validate(cue: dict[str, Any]) -> None:
    jsonschema.validate(cue, CUE_SCHEMA)


def test_read_cue_is_schema_valid(canon: Canon) -> None:
    det = _detection(canon)
    res = Resolution(_passage(canon), ())
    timing = compute_timing(150.0, _read(), 6, det.confidence)
    cue = build_cue(3, det, res, _read(), timing, TRANSLATION, canon)
    _validate(cue)
    assert cue["id"] == "cue_003"
    assert cue["origin"] == "detected"
    assert cue["enabled"] is True
    assert cue["reference_display"] == "John 3:16 (KJV)"
    assert cue["body"] == "16 For God so loved the world."
    assert cue["read_start_s"] == 152.8
    assert cue["detection"]["word_span"] == [12, 15]
    assert list(cue)[:3] == ["id", "enabled", "origin"]


def test_chapter_only_cue_is_disabled_with_fixed_duration(canon: Canon) -> None:
    det = _detection(canon, verse=None, flags=("chapter_only",))
    res = Resolution(None, ())
    timing = compute_timing(150.0, None, None, det.confidence)
    cue = build_cue(1, det, res, None, timing, TRANSLATION, canon)
    _validate(cue)
    assert cue["enabled"] is False
    assert cue["body"] == ""
    assert cue["body_word_count"] == 0
    assert cue["flags"] == ["chapter_only"]
    assert cue["source_duration_s"] == TimingConfig().fixed_duration_s
    assert cue["reference_display"] == "John 3 (KJV)"


@pytest.mark.parametrize("flag", ["text_unavailable", "passage_not_found"])
def test_unavailable_flags_disable_the_cue(canon: Canon, flag: str) -> None:
    det = _detection(canon)
    timing = compute_timing(150.0, None, None, det.confidence)
    cue = build_cue(1, det, Resolution(None, (flag,)), None, timing, TRANSLATION, canon)
    _validate(cue)
    assert cue["enabled"] is False


def test_long_passage_stays_enabled_and_flags_are_ordered(canon: Canon) -> None:
    det = _detection(canon, confidence=0.3, flags=("suppressed_duplicate",))
    res = Resolution(_passage(canon, truncated=True), ("long_passage",))
    timing = compute_timing(150.0, None, 6, det.confidence)
    cue = build_cue(1, det, res, None, timing, TRANSLATION, canon)
    _validate(cue)
    assert cue["flags"] == ["low_confidence", "long_passage", "suppressed_duplicate"]
    assert cue["body_truncated"] is True


def test_low_confidence_threshold(canon: Canon) -> None:
    res = Resolution(_passage(canon), ())
    low = _detection(canon, confidence=0.5)
    timing = compute_timing(150.0, None, 6, low.confidence)
    cue = build_cue(1, low, res, None, timing, TRANSLATION, canon)
    assert cue["flags"] == ["low_confidence"]
    assert cue["enabled"] is True

    corroborated = compute_timing(150.0, _read(), 6, 0.5)
    assert corroborated.confidence >= LOW_CONFIDENCE_THRESHOLD
    cue = build_cue(1, low, res, _read(), corroborated, TRANSLATION, canon)
    assert "low_confidence" not in cue["flags"]


def test_alternatives_have_empty_body(canon: Canon) -> None:
    alt = Reference("John", "John", 3, 1, 6)
    det = _detection(canon, alternatives=((alt, 0.4, "psalms concatenation"),))
    timing = compute_timing(150.0, None, 6, det.confidence)
    cue = build_cue(1, det, Resolution(_passage(canon), ()), None, timing, TRANSLATION, canon)
    _validate(cue)
    assert cue["alternatives"] == [
        {
            "reference": alt.to_json(),
            "reference_display": "John 3:1-6 (KJV)",
            "body": "",
            "confidence": 0.4,
            "reason": "psalms concatenation",
        }
    ]


def test_panel_owned_flags_never_appear(canon: Canon) -> None:
    for confidence in (0.1, 0.5, 0.95):
        for res in (
            Resolution(None, ("text_unavailable",)),
            Resolution(_passage(canon, True), ("long_passage",)),
        ):
            det = _detection(canon, confidence=confidence, flags=("suppressed_duplicate",))
            timing = compute_timing(150.0, None, 6, confidence)
            cue = build_cue(1, det, res, None, timing, TRANSLATION, canon)
            assert not PANEL_FLAGS & set(cue["flags"])
