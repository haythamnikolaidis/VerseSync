"""detect(): duplicate suppression, snippets and JSON output (docs/04 sections 6 and 7)."""

from __future__ import annotations

import json
import time

from transcript_fixtures import FIXTURES_DIR

from versesync.detect.canon import load_canon
from versesync.detect.detector import DetectConfig, detect
from versesync.types import Word, load_words

CANON = load_canon()

JSON_KEYS = {
    "id",
    "reference",
    "display",
    "pattern",
    "contextual",
    "token_span",
    "word_span",
    "source_start",
    "source_end",
    "snippet",
    "confidence",
    "book_match",
    "alternatives",
}


def say(text: str, start: float) -> list[Word]:
    """Words of ``text`` laid out 0.3 s apart from ``start``."""
    return [
        Word(text=t, start=start + i * 0.3, end=start + i * 0.3 + 0.25, probability=0.95)
        for i, t in enumerate(text.split())
    ]


def john_mentions(times: list[float]) -> list[Word]:
    words: list[Word] = []
    for t in times:
        words += say("as it says in John 3:16 for God so loved", t)
    return words


def test_three_mentions_in_50s_keep_one_and_return_all() -> None:
    found = detect(john_mentions([0.0, 25.0, 50.0]), CANON)
    assert [d.reference.verse for d in found] == [16, 16, 16]
    assert [bool("suppressed_duplicate" in d.flags) for d in found] == [False, True, True]
    assert [d.id for d in found] == ["det_001", "det_002", "det_003"]


def test_fourth_mention_after_cooldown_is_kept() -> None:
    found = detect(john_mentions([0.0, 25.0, 50.0, 70.0]), CANON)
    assert len(found) == 4
    assert [("suppressed_duplicate" in d.flags) for d in found] == [False, True, True, False]


def test_cooldown_is_configurable() -> None:
    found = detect(john_mentions([0.0, 25.0]), CANON, DetectConfig(duplicate_cooldown_s=10.0))
    assert all("suppressed_duplicate" not in d.flags for d in found)


def test_different_references_are_not_duplicates() -> None:
    words = say("John 3:16", 0.0) + say("John 3:17", 10.0)
    assert all(d.flags == () for d in detect(words, CANON))


def test_chapter_only_flag() -> None:
    found = detect(say("turn to Romans chapter 8", 0.0), CANON)
    assert len(found) == 1
    assert found[0].reference.verse is None
    assert found[0].flags == ("chapter_only",)


def test_snippet_is_cut_with_ellipses() -> None:
    words = say("a b c d e f g h John 3:16 i j k l m n o", 0.0)
    (d,) = detect(words, CANON)
    lo, hi = d.candidate.word_span
    assert d.snippet == "…" + " ".join(w.text for w in words[lo - 5 : hi + 6]) + "…"


def test_snippet_has_no_ellipsis_at_transcript_edges() -> None:
    (d,) = detect(say("see John 3:16 now", 0.0), CANON)
    assert d.snippet == "see John 3:16 now"


def test_invalid_reference_is_dropped_and_low_confidence_is_not() -> None:
    assert detect(say("Jude 5:1", 0.0), CANON) == []
    (d,) = detect(say("John 3:16", 0.0), CANON)
    assert 0.0 <= d.confidence <= 1.0


def test_to_json_shape() -> None:
    (d,) = detect(say("turn with me to John 3:16 please", 0.0), CANON)
    out = d.to_json(CANON)
    assert set(out) == JSON_KEYS
    assert out["id"] == "det_001"
    assert out["display"] == "John 3:16"
    assert out["reference"] == {"book": "John", "osis": "John", "chapter": 3, "verse": 16}
    assert out["book_match"] == {"tier": "exact", "distance": 0}
    assert out["alternatives"] == []
    assert out["source_start"] == 1.2
    json.dumps(out)


def test_long_sermon_is_fast_and_deterministic() -> None:
    words = load_words(FIXTURES_DIR / "long-sermon-filler.words.json")
    start = time.perf_counter()
    first = detect(words, CANON)
    elapsed = time.perf_counter() - start
    second = detect(words, CANON)
    assert elapsed < 1.0
    dump = [d.to_json(CANON) for d in first]
    assert dump == [d.to_json(CANON) for d in second]
    assert json.dumps(dump) == json.dumps([d.to_json(CANON) for d in second])
