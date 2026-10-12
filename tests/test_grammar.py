"""T-12: the grammar (docs/04-reference-detection.md section 4).

Layout: the section 4 table row by row, then priority and span consumption, context carry, the
Psalms ambiguity, chapter-only forms, the negative fixtures, documented tolerances, span and
timing facts, the output contract, and the transcript fixture corpus.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import jsonschema
import pytest
from transcript_fixtures import FIXTURE_NAMES, load_labels, load_words

from versesync.detect.canon import load_canon
from versesync.detect.grammar import (
    FRAGMENT_PATTERN_IDS,
    FULL_PATTERN_IDS,
    PATTERN_IDS,
    REASON_CARRIED_ALTERNATIVE,
    REASON_PSALMS_SPLIT,
    Alternative,
    BookMatchInfo,
    Detection,
    GrammarConfig,
    GrammarResult,
    Reference,
    match_grammar,
)
from versesync.detect.normalize import normalize_words

SCHEMA = json.loads(
    (Path(__file__).resolve().parent.parent / "schemas" / "cue-document.schema.json").read_text(
        encoding="utf-8"
    )
)


@dataclass
class W:
    text: str
    start: float = 0.0
    end: float = 0.0
    probability: float = 0.9


def words(*parts: str | float, step: float = 0.4, prob: float = 0.9) -> list[W]:
    """Words from strings (split on spaces); a float part advances the clock by that many seconds.

    Word ``i`` spans ``[t, t + step * 0.75]``, so timestamps are distinct and increasing.
    """
    out: list[W] = []
    t = 0.0
    for part in parts:
        if isinstance(part, float):
            t += part
            continue
        for text in part.split():
            out.append(W(text, round(t, 4), round(t + step * 0.75, 4), prob))
            t += step
    return out


def run(*parts: str | float, **kw: float) -> GrammarResult:
    return match_grammar(words(*parts, **kw))


def detect(text: str) -> tuple[Detection, ...]:
    return run(text).detections


def one(text: str) -> Detection:
    found = detect(text)
    assert len(found) == 1, [(d.pattern, d.reference.display) for d in found]
    return found[0]


def ref(book: str, osis: str, chapter: int, verse: int | None = None, end: int | None = None):
    return Reference(book, osis, chapter, verse, end)


def filler(n: int) -> str:
    return " ".join(["blah"] * n)


# -- the section 4 table: every row, its tabulated example ------------------------------------

TABLE = [
    ("P1", "1 corinthians 6 : 19 - 20", ref("1 Corinthians", "1Cor", 6, 19, 20)),
    ("P2", "john 3 : 16", ref("John", "John", 3, 16)),
    ("P3", "john chapter 3 verses 16 through 18", ref("John", "John", 3, 16, 18)),
    ("P4", "2 timothy chapter 2 verse 15", ref("2 Timothy", "2Tim", 2, 15)),
    ("P5", "romans chapter 8", ref("Romans", "Rom", 8)),
    ("P6", "1 corinthians 6 , 19 and 20", ref("1 Corinthians", "1Cor", 6, 19, 20)),
    ("P7", "john 3 , 16", ref("John", "John", 3, 16)),
    ("P8", "john 3 16", ref("John", "John", 3, 16)),
    ("P9", "romans 8", ref("Romans", "Rom", 8)),
    ("P10", "the third chapter of john , verse 16", ref("John", "John", 3, 16)),
]


@pytest.mark.parametrize(("pattern", "text", "expected"), TABLE, ids=[t[0] for t in TABLE])
def test_table_example(pattern: str, text: str, expected: Reference) -> None:
    d = one(text)
    assert (d.pattern, d.reference, d.contextual, d.alternatives) == (pattern, expected, False, ())
    assert d.token_span == (0, len(text.split()) - 1)


def test_table_example_p11_and_p12_carry_from_a_full_reference() -> None:
    p11 = run("john 3 : 16 and then", 1.0, "verses 19 through 20").detections
    assert [(d.pattern, d.reference) for d in p11] == [
        ("P2", ref("John", "John", 3, 16)),
        ("P11", ref("John", "John", 3, 19, 20)),
    ]
    p12 = run("john 3 : 16 and then", 1.0, "verse 5").detections
    assert [(d.pattern, d.reference) for d in p12] == [
        ("P2", ref("John", "John", 3, 16)),
        ("P12", ref("John", "John", 3, 5)),
    ]
    assert all(d.contextual for d in (p11[1], p12[1]))


def test_every_pattern_id_is_covered_by_a_table_row_or_fragment() -> None:
    assert PATTERN_IDS == tuple(f"P{i}" for i in range(1, 13))
    assert FULL_PATTERN_IDS + FRAGMENT_PATTERN_IDS == PATTERN_IDS
    assert {t[0] for t in TABLE} == set(FULL_PATTERN_IDS)


# Three phrasings per pattern (docs/11 section 1): spoken, digit and Whisper-punctuated.
PHRASINGS = [
    # P1
    ("P1", "psalm 23 : 1 - 4", ref("Psalms", "Ps", 23, 1, 4)),
    ("P1", "turn to Romans 8:28-30 please", ref("Romans", "Rom", 8, 28, 30)),
    ("P1", "Second Timothy 3:16-17", ref("2 Timothy", "2Tim", 3, 16, 17)),
    ("P1", "First John four : seven - eight", ref("1 John", "1John", 4, 7, 8)),
    # P2
    ("P2", "John 3:16", ref("John", "John", 3, 16)),
    ("P2", "John three : sixteen", ref("John", "John", 3, 16)),
    ("P2", "look at Third John 1:4 now", ref("3 John", "3John", 1, 4)),
    ("P2", "Revelations 21:4", ref("Revelation", "Rev", 21, 4)),
    # P3
    ("P3", "John chapter three verses sixteen through eighteen", ref("John", "John", 3, 16, 18)),
    ("P3", "Romans chapter 8 verse 28 to 30", ref("Romans", "Rom", 8, 28, 30)),
    ("P3", "Psalm chapter 23 verses 1 - 4", ref("Psalms", "Ps", 23, 1, 4)),
    ("P3", "Acts chapter 2 verses 1 and 4", ref("Acts", "Acts", 2, 1, 4)),
    # P4
    ("P4", "Second Timothy chapter two verse fifteen", ref("2 Timothy", "2Tim", 2, 15)),
    ("P4", "Philippians chapter 4 verse 13", ref("Philippians", "Phil", 4, 13)),
    ("P4", "John chapter one verses one", ref("John", "John", 1, 1)),
    ("P4", "Genesis chapter one hundred verse one", ref("Genesis", "Gen", 100, 1)),
    # P5
    ("P5", "Romans chapter eight", ref("Romans", "Rom", 8)),
    ("P5", "turn to Second Timothy chapter 2", ref("2 Timothy", "2Tim", 2)),
    ("P5", "Psalm chapter one hundred and nineteen", ref("Psalms", "Ps", 119)),
    ("P5", "Isaiah chapter 53 today", ref("Isaiah", "Isa", 53)),
    # P6
    ("P6", "First Corinthians six, nineteen and twenty", ref("1 Corinthians", "1Cor", 6, 19, 20)),
    ("P6", "Romans 8, 28 through 30", ref("Romans", "Rom", 8, 28, 30)),
    ("P6", "John 3 , 16 to 18", ref("John", "John", 3, 16, 18)),
    ("P6", "Hebrews eleven, one and two", ref("Hebrews", "Heb", 11, 1, 2)),
    # P7
    ("P7", "John 3, 16", ref("John", "John", 3, 16)),
    ("P7", "Colossians three, two", ref("Colossians", "Col", 3, 2)),
    ("P7", "Romans eight , twenty eight", ref("Romans", "Rom", 8, 28)),
    ("P7", "Second Kings 5 , 14", ref("2 Kings", "2Kgs", 5, 14)),
    # P8
    ("P8", "John three sixteen", ref("John", "John", 3, 16)),
    ("P8", "Jeremiah 29 11", ref("Jeremiah", "Jer", 29, 11)),
    ("P8", "Philippians four thirteen", ref("Philippians", "Phil", 4, 13)),
    ("P8", "First Peter two nine", ref("1 Peter", "1Pet", 2, 9)),
    # P9
    ("P9", "Romans 8", ref("Romans", "Rom", 8)),
    ("P9", "turn to Second Timothy two", ref("2 Timothy", "2Tim", 2)),
    ("P9", "Genesis one", ref("Genesis", "Gen", 1)),
    ("P9", "Psalm one hundred and nineteen", ref("Psalms", "Ps", 119)),
    # P10
    ("P10", "the third chapter of John, verse 16", ref("John", "John", 3, 16)),
    ("P10", "the third chapter of John", ref("John", "John", 3)),
    ("P10", "the first chapter of Genesis , verses 1", ref("Genesis", "Gen", 1, 1)),
    ("P10", "the second chapter of First John, verse four", ref("1 John", "1John", 2, 4)),
]


@pytest.mark.parametrize(("pattern", "text", "expected"), PHRASINGS)
def test_phrasings(pattern: str, text: str, expected: Reference) -> None:
    d = one(text)
    assert d.pattern == pattern
    assert d.reference == expected
    assert d.contextual is False


def test_every_full_pattern_has_at_least_three_phrasings() -> None:
    for pid in FULL_PATTERN_IDS:
        assert sum(1 for p, _, _ in PHRASINGS if p == pid) >= 3, pid


@pytest.mark.parametrize(
    "text",
    [
        "verses 19 through 20",
        "verse 5",
        "and verse 5 tells us",
        "verses 3 to 5",
        "verses 16 and 17",
        "verses 1 - 4",
        "verse five",
    ],
)
def test_fragments_without_a_preceding_reference_are_discarded(text: str) -> None:
    assert detect(text) == ()


@pytest.mark.parametrize(
    ("text", "pattern", "verse", "end"),
    [
        ("verses 19 through 20", "P11", 19, 20),
        ("verses 3 to 5", "P11", 3, 5),
        ("verses 16 and 17", "P11", 16, 17),
        ("verses 1 - 4", "P11", 1, 4),
        ("verse 19 through 20", "P11", 19, 20),
        ("verse 5", "P12", 5, None),
        ("and verse twelve says", "P12", 12, None),
        ("verse 176 is the last", "P12", 176, None),
    ],
)
def test_fragment_phrasings(text: str, pattern: str, verse: int, end: int | None) -> None:
    found = run("john 3 : 1 as we read", 0.5, text).detections
    d = found[-1]
    assert (d.pattern, d.reference.verse, d.reference.verse_end) == (pattern, verse, end)
    assert d.reference == ref("John", "John", 3, verse, end)
    assert d.contextual


# -- priority and span consumption ----------------------------------


def test_p1_beats_p2_and_leaves_no_stray_number() -> None:
    found = detect("john 3 : 16 - 18")
    assert [(d.pattern, d.reference.verse_end) for d in found] == [("P1", 18)]


def test_p1_match_prevents_a_p9_match_on_the_same_words() -> None:
    found = detect("1 corinthians 6 : 19 - 20")
    assert [(d.pattern, d.reference) for d in found] == [
        ("P1", ref("1 Corinthians", "1Cor", 6, 19, 20))
    ]


@pytest.mark.parametrize(
    ("text", "winner", "span_end"),
    [
        ("john 3 : 16", "P2", 3),  # not P9 "john 3" plus stray ": 16"
        ("john chapter 3 verses 16 through 18", "P3", 6),  # not P4, P5
        ("john chapter 3 verse 16", "P4", 4),  # not P5 + P12
        ("john chapter 3", "P5", 2),  # not P9
        ("1 corinthians 6 , 19 and 20", "P6", 6),  # not P7, P9
        ("john 3 , 16", "P7", 3),  # not P9
        ("john 3 16", "P8", 2),  # not P9 + stray number
    ],
)
def test_longest_pattern_wins_and_consumes(text: str, winner: str, span_end: int) -> None:
    found = detect(text)
    assert [d.pattern for d in found] == [winner]
    assert found[0].token_span == (0, span_end)


def test_verse_keyword_inside_a_matched_reference_is_not_rematched_as_p12() -> None:
    found = run("john chapter 3 verse 16").detections
    assert [d.pattern for d in found] == ["P4"]
    assert not found[0].contextual


def test_p11_consumes_its_words_so_p12_cannot_take_the_first_verse() -> None:
    found = run("john 3 : 1", 0.5, "verses 19 through 20").detections
    assert [d.pattern for d in found] == ["P2", "P11"]


def test_consumed_book_ordinal_is_not_stolen_as_a_number_by_the_previous_reference() -> None:
    # "1" is the ordinal prefix of 1 John, so Romans must not read it as "verse 1" (P8).
    found = detect("romans 8 1 john 4 8")
    assert [(d.pattern, d.reference.display) for d in found] == [
        ("P9", "Romans 8"),
        ("P8", "1 John 4:8"),
    ]


def test_priority_is_global_not_left_to_right() -> None:
    # The earlier reference is the looser pattern; the later one still gets its own tight match.
    found = detect("romans 8 and then john 3 : 16 - 18")
    assert [(d.pattern, d.reference.display) for d in found] == [
        ("P9", "Romans 8"),
        ("P1", "John 3:16-18"),
    ]


def test_adjacent_references_do_not_bleed_into_each_other() -> None:
    found = detect("john 3 : 16 romans 8 : 28")
    assert [(d.pattern, d.reference.display, d.token_span) for d in found] == [
        ("P2", "John 3:16", (0, 3)),
        ("P2", "Romans 8:28", (4, 7)),
    ]


def test_detections_are_ordered_by_position() -> None:
    found = run("romans 8", 1.0, "john 3 : 16", 1.0, "genesis chapter 1").detections
    assert [d.reference.osis for d in found] == ["Rom", "John", "Gen"]
    assert list(found) == sorted(found, key=lambda d: d.token_span)


# -- context carry (P11, P12) ----------------------------------


def test_context_carry_inside_the_window() -> None:
    result = run("john 3 : 16", 20.0, "and verse 5 tells us")
    ref_d, frag = result.detections
    assert frag.pattern == "P12"
    assert frag.contextual is True
    assert frag.reference == ref("John", "John", 3, 5)
    assert frag.carried_from == ref_d.token_span
    assert ref_d.contextual is False and ref_d.carried_from is None


def test_carried_detection_spans_only_the_fragment() -> None:
    result = run("john 3 : 16", 20.0, "and verse 5 tells us")
    _, frag = result.detections
    tokens = result.normalized.tokens
    assert [t.text for t in tokens[frag.token_span[0] : frag.token_span[1] + 1]] == ["verse", "5"]
    assert frag.source_start == tokens[frag.token_span[0]].start


def test_carried_detection_inherits_the_sources_book_evidence() -> None:
    _, frag = run("philippines 4 13", 5.0, "verse 2").detections
    assert frag.book_match == BookMatchInfo("alias", 0)


def test_fragment_beyond_the_seconds_window_is_discarded() -> None:
    gap = 121.0
    assert [d.pattern for d in run("john 3 : 16", gap, "verse 5").detections] == ["P2"]


def test_seconds_window_boundary_is_inclusive() -> None:
    # reference ends at 0.3 * 4 words ... measure from the reference's last token end.
    base = words("john 3 : 16")
    end = base[-1].end
    start = round(end + 120.0, 4)
    w = [*base, W("verse", start, start + 0.3), W("5", start + 0.4, start + 0.7)]
    assert len(match_grammar(w).detections) == 2
    w[-2:] = [W("verse", start + 0.01, start + 0.3), W("5", start + 0.4, start + 0.7)]
    assert len(match_grammar(w).detections) == 1


def test_fragment_beyond_the_token_window_is_discarded_even_when_close_in_time() -> None:
    # 500 filler words at 0.01 s each: 5 s of audio, but more than 400 tokens.
    parts = ("john 3 : 16", filler(500), "verse 5")
    result = match_grammar(words(*parts, step=0.01))
    assert [d.pattern for d in result.detections] == ["P2"]


def test_token_window_boundary_is_inclusive() -> None:
    # gap in tokens = index of "verse" minus index of the reference's last token.
    inside = match_grammar(words("john 3 : 16", filler(399), "verse 5", step=0.01))
    outside = match_grammar(words("john 3 : 16", filler(400), "verse 5", step=0.01))
    assert [d.pattern for d in inside.detections] == ["P2", "P12"]
    assert [d.pattern for d in outside.detections] == ["P2"]


def test_the_window_is_the_shorter_of_the_two_bounds() -> None:
    # 115 s of silence (inside seconds) and only 3 filler words (inside tokens): carried.
    assert len(run("john 3 : 16", filler(3), 115.0, "verse 5").detections) == 2
    # 300 filler words spread over 130 s: inside the token bound, outside the seconds bound.
    slow = match_grammar(words("john 3 : 16", filler(300), "verse 5", step=130 / 300))
    assert [d.pattern for d in slow.detections] == ["P2"]


def test_window_is_configurable_but_both_bounds_still_apply() -> None:
    parts = ("john 3 : 16", 30.0, "verse 5")
    narrow = match_grammar(words(*parts), config=GrammarConfig(context_window_s=10.0))
    assert len(narrow.detections) == 1
    tokens = match_grammar(
        words("john 3 : 16", filler(10), "verse 5"), config=GrammarConfig(context_window_tokens=5)
    )
    assert len(tokens.detections) == 1
    wide = match_grammar(words(*parts), config=GrammarConfig(context_window_s=60.0))
    assert len(wide.detections) == 2


def test_context_does_not_leak_across_an_intervening_book() -> None:
    result = run("john 3 : 16", 5.0, "romans 8 : 28", 5.0, "verse 5")
    assert [d.reference.display for d in result.detections] == [
        "John 3:16",
        "Romans 8:28",
        "Romans 8:5",
    ]


def test_context_comes_from_the_most_recent_reference_even_if_chapter_only() -> None:
    result = run("john 3 : 16", 5.0, "romans chapter 12", 5.0, "and in verse 12")
    assert result.detections[-1].reference == ref("Romans", "Rom", 12, 12)


def test_one_reference_feeds_several_fragments_within_its_window() -> None:
    result = run("john 3 : 16", 10.0, "verse 5", 10.0, "and verses 7 through 9", 10.0, "verse 11")
    assert [(d.pattern, d.reference.verse, d.reference.verse_end) for d in result.detections] == [
        ("P2", 16, None),
        ("P12", 5, None),
        ("P11", 7, 9),
        ("P12", 11, None),
    ]
    assert len({d.carried_from for d in result.detections if d.contextual}) == 1


def test_window_is_measured_from_the_reference_not_from_the_previous_fragment() -> None:
    # Each fragment is 50 s after the last; the third is 150 s after the reference.
    result = run("john 3 : 16", 50.0, "verse 5", 50.0, "verse 6", 50.0, "verse 7")
    assert [d.pattern for d in result.detections] == ["P2", "P12", "P12"]


def test_fragment_before_any_reference_is_discarded_but_later_ones_carry() -> None:
    result = run("verse 5 was early", 5.0, "john 3 : 16", 5.0, "verse 6")
    assert [(d.pattern, d.reference.display) for d in result.detections] == [
        ("P2", "John 3:16"),
        ("P12", "John 3:6"),
    ]


def test_carried_p11_range_keeps_both_ends() -> None:
    result = run("romans 8", 5.0, "verses 28 through 30")
    assert result.detections[-1].reference == ref("Romans", "Rom", 8, 28, 30)


def test_same_chapter_word_stays_on_the_book_it_was_carried_from() -> None:
    result = run("1 john 4 : 8", 5.0, "verse 16")
    assert result.detections[-1].reference.osis == "1John"


# -- Psalms concatenation ambiguity ----------------------------------


def test_psalms_with_two_valid_readings_emits_both_concatenated_first() -> None:
    d = one("psalm twelve two")
    assert d.pattern == "P8"
    assert d.reference == ref("Psalms", "Ps", 122)
    assert [a.reference for a in d.alternatives] == [ref("Psalms", "Ps", 12, 2)]
    assert d.alternatives[0].reason == REASON_PSALMS_SPLIT


@pytest.mark.parametrize("text", ["psalm 12 2", "Psalms twelve two", "ps 12 2", "psalm 12 2 again"])
def test_psalms_ambiguity_across_spellings(text: str) -> None:
    d = detect(text)[0]
    assert d.reference.chapter == 122 and d.reference.verse is None
    assert d.alternatives[0].reference == ref("Psalms", "Ps", 12, 2)


def test_psalm_one_nineteen_is_chapter_119() -> None:
    # Psalm 1 has six verses, so 1:19 is not a valid reading: the concatenation stands alone.
    d = one("psalm one nineteen")
    assert d.reference == ref("Psalms", "Ps", 119)
    assert d.alternatives == ()


def test_psalms_split_only_when_the_concatenation_is_not_a_chapter() -> None:
    d = one("psalm 119 5")  # 1195 is not a chapter
    assert d.reference == ref("Psalms", "Ps", 119, 5)
    assert d.alternatives == ()


def test_psalms_with_neither_reading_valid_emits_the_plain_split_for_validation_to_reject() -> None:
    d = one("psalm 160 3")
    assert d.reference == ref("Psalms", "Ps", 160, 3)
    assert d.alternatives == ()


def test_the_rule_only_fires_for_psalms() -> None:
    for text in ("john 3 16", "romans 8 28", "genesis 12 2", "proverbs 3 5"):
        d = one(text)
        assert d.alternatives == ()
        assert d.reference.verse is not None


@pytest.mark.parametrize(
    "text",
    [
        "psalm 12 : 2",  # colon
        "psalm 12 , 2",  # comma
        "psalm chapter 12 verse 2",  # keywords
        "psalm chapter 12 , verse 2",
    ],
)
def test_psalms_with_structure_between_the_numbers_is_not_ambiguous(text: str) -> None:
    d = one(text)
    assert d.reference == ref("Psalms", "Ps", 12, 2)
    assert d.alternatives == ()


def test_psalms_ambiguity_survives_context_carry() -> None:
    result = run("psalm twelve two", 5.0, "verse 5")
    ambiguous, frag = result.detections
    assert frag.reference == ref("Psalms", "Ps", 122, 5)
    assert [a.reference for a in frag.alternatives] == [ref("Psalms", "Ps", 12, 5)]
    assert frag.alternatives[0].reason == REASON_CARRIED_ALTERNATIVE
    assert ambiguous.alternatives


def test_psalms_ambiguity_does_not_emit_a_winner_ranking() -> None:
    d = one("psalm twelve two")
    assert isinstance(d.alternatives[0], Alternative)
    # Both readings are present and the grammar attaches no score to either.
    assert not hasattr(d, "confidence")


# -- chapter-only forms (D12) ----------------------------------


@pytest.mark.parametrize(
    ("pattern", "text"),
    [
        ("P5", "romans chapter eight"),
        ("P5", "second timothy chapter 2"),
        ("P9", "romans eight"),
        ("P9", "psalm 119"),
        ("P10", "the third chapter of john"),
        ("P10", "the eighth chapter of romans"),
    ],
)
def test_chapter_only_forms_emit_no_verse(pattern: str, text: str) -> None:
    d = one(text)
    assert d.pattern == pattern
    assert d.reference.verse is None and d.reference.verse_end is None
    assert d.chapter_only


def test_concatenated_psalm_is_chapter_only() -> None:
    d = one("psalm twelve two")
    assert d.chapter_only
    assert d.reference.verse is None


def test_chapter_only_is_never_expanded_to_verse_one() -> None:
    for d in (
        *detect("romans 8"),
        *detect("romans chapter 8"),
        *detect("the third chapter of john"),
    ):
        assert d.reference.verse is None
    assert "verse" not in one("romans 8").reference.to_dict()


def test_p10_with_a_verse_is_not_chapter_only() -> None:
    assert not one("the third chapter of john , verse 16").chapter_only


# -- negative fixtures: the gate keeps ordinary English out --------------------


@pytest.mark.parametrize(
    "text",
    [
        "he lost his job last year",
        "faith without works acts dead",
        "mark my words",
        "the numbers don't lie",
        "he was a judge for thirty years",
        "in the book of life",
        "romans were known for their roads",
        "john turned forty last week",
        "the kings of the earth took counsel",
        "kings and queens 2 of them",
        "the revelation came to him in a dream",
        "revelation is a gift and 3 more",
        "numbers of people came",
        "job satisfaction was low in 2019",
        "he gave mark the 3 books",
        "ruth said nothing",
        "turn to philippines",
        "have a cook",
    ],
)
def test_ordinary_english_produces_no_detections(text: str) -> None:
    assert detect(text) == ()


@pytest.mark.parametrize(
    "text",
    [
        "the verse of the day",
        "chapter and verse",
        "chapter 3 verse 16",  # no book, no context
        "verse",
        "verses were read",
        "one two three",
        "3 : 16",
        "the third chapter of the book",
    ],
)
def test_structure_words_alone_produce_nothing(text: str) -> None:
    assert detect(text) == ()


def test_empty_transcript() -> None:
    result = match_grammar([])
    assert result.detections == ()
    assert result.normalized.tokens == []


def test_a_homograph_directly_before_a_number_is_a_candidate_for_validation() -> None:
    # The gate is the only filter at this stage: "mark 5" is a book followed by a number.
    # Whether the speaker meant it is for canon validation and confidence (T-13).
    d = one("it took mark 5 minutes")
    assert d.reference == ref("Mark", "Mark", 5)


def test_fuzzy_book_is_gated_on_the_following_number_through_the_grammar() -> None:
    assert detect("turn to philippines") == ()
    d = one("turn to philippines four thirteen")
    assert d.reference == ref("Philippians", "Phil", 4, 13)
    assert d.book_match == BookMatchInfo("alias", 0)


def test_fuzzy_tier_and_distance_pass_through() -> None:
    assert one("ephesians 2 : 8").book_match == BookMatchInfo("exact", 0)
    fuzzy = one("deuteronimy 6 : 4")
    assert fuzzy.reference.book == "Deuteronomy"
    assert fuzzy.book_match.tier == "fuzzy" and fuzzy.book_match.distance >= 1


# -- documented tolerances beyond the table ----------------------------------


@pytest.mark.parametrize(
    ("pattern", "text", "expected"),
    [
        ("P4", "romans chapter eight, verse twenty eight", ref("Romans", "Rom", 8, 28)),
        ("P4", "romans chapter 8 , verse 28", ref("Romans", "Rom", 8, 28)),
        ("P3", "romans chapter 8, verses 28 through 30", ref("Romans", "Rom", 8, 28, 30)),
    ],
)
def test_comma_between_chapter_and_verse_keyword(
    pattern: str, text: str, expected: Reference
) -> None:
    d = one(text)
    assert (d.pattern, d.reference) == (pattern, expected)


@pytest.mark.parametrize(
    ("pattern", "text", "expected"),
    [
        ("P3", "john chapter 3 verses 16 , 17 and 18", ref("John", "John", 3, 16, 18)),
        ("P3", "john chapter 3 verses 16 , 17 , and 18", ref("John", "John", 3, 16, 18)),
        ("P6", "romans 8 , 28 , 29 and 30", ref("Romans", "Rom", 8, 28, 30)),
    ],
)
def test_consecutive_verse_lists_collapse_to_one_range(
    pattern: str, text: str, expected: Reference
) -> None:
    d = one(text)
    assert (d.pattern, d.reference) == (pattern, expected)


def test_p11_verse_list_collapses_to_one_range() -> None:
    # docs/04 section 8: "verses 16, 17, and 18" produces one range.
    result = run("john 3 : 1", 2.0, "verses 16 , 17 , and 18")
    assert [d.reference.display for d in result.detections] == ["John 3:1", "John 3:16-18"]
    assert result.detections[-1].pattern == "P11"


def test_nonconsecutive_verse_lists_do_not_collapse() -> None:
    # 16, 18 and 20 is three verses, not a range; the first verse is matched and the rest left.
    d = one("john chapter 3 verses 16 , 18 and 20")
    assert (d.pattern, d.reference) == ("P4", ref("John", "John", 3, 16))
    d = one("romans 8 , 28 , 30 and 31")
    assert (d.pattern, d.reference) == ("P7", ref("Romans", "Rom", 8, 28))


def test_separate_moments_are_separate_cues_not_a_coalesced_range() -> None:
    # docs/04 section 8: verse 16 ... two minutes of preaching ... verse 17 are two cues.
    result = run("john 3 : 1", 5.0, "verse 16", 40.0, "verse 17")
    assert [(d.pattern, d.reference.verse) for d in result.detections] == [
        ("P2", 1),
        ("P12", 16),
        ("P12", 17),
    ]


@pytest.mark.parametrize(
    ("text", "chapter", "verse", "end"),
    [
        ("the third chapter of john , verses 16 through 18", 3, 16, 18),
        ("the third chapter of john , verses 16 and 17", 3, 16, 17),
        ("the third chapter of john verse 16", 3, 16, None),
        ("the third chapter of john , verses 16 , 17 and 18", 3, 16, 18),
        ("the third chapter of john , verses 16 , 18 and 20", 3, 16, None),
    ],
)
def test_p10_verse_part(text: str, chapter: int, verse: int, end: int | None) -> None:
    d = one(text)
    assert d.pattern == "P10"
    assert (d.reference.chapter, d.reference.verse, d.reference.verse_end) == (chapter, verse, end)


@pytest.mark.parametrize(
    ("ordinal", "chapter"),
    [
        ("first", 1),
        ("second", 2),
        ("third", 3),
        ("fourth", 4),
        ("fifth", 5),
        ("ninth", 9),
        ("tenth", 10),
        ("twelfth", 12),
        ("nineteenth", 19),
        ("twentieth", 20),
        ("twenty first", 21),
        ("twenty second", 22),
        ("twenty third", 23),
        ("twenty-fourth", 24),
        ("thirty fifth", 35),
        ("ninetieth", 90),
        ("hundredth", 100),
        ("one hundred and nineteenth", 119),
        ("one hundred twentieth", 120),
        ("one hundred and twenty third", 123),
        ("one hundred and fiftieth", 150),
        ("4th", 4),
        ("23rd", 23),
        ("119th", 119),
        ("1st", 1),
    ],
)
def test_p10_ordinal_chapter_numbers(ordinal: str, chapter: int) -> None:
    d = one(f"the {ordinal} chapter of psalms")
    assert d.pattern == "P10"
    assert d.reference == ref("Psalms", "Ps", chapter)


def test_p10_is_not_fooled_by_earlier_the_in_the_sentence() -> None:
    d = one("so the preacher said the third chapter of john")
    assert d.pattern == "P10"
    assert d.token_span == (4, 8)


@pytest.mark.parametrize(
    "text",
    [
        "the chapter of john",
        "a third chapter of john",
        "the many chapter of john",
        "third chapter of john",
        "the twenty twenty chapter of john",
    ],
)
def test_p10_requires_the_ordinal_form(text: str) -> None:
    assert detect(text) == ()


def test_p6_and_p7_connectors_are_exactly_the_tabulated_ones() -> None:
    # P6 takes and/through/to; a hyphen after the comma form leaves the range unmatched (P7).
    d = one("john 3 , 16 - 18")
    assert (d.pattern, d.reference) == ("P7", ref("John", "John", 3, 16))


# -- spans, timing and probabilities ----------------------------------


def test_spans_for_first_corinthians_start_at_the_ordinal_word() -> None:
    result = run("turn with me to", 0.2, "First Corinthians six , nineteen and twenty")
    (d,) = result.detections
    tokens = result.normalized.tokens
    assert d.pattern == "P6"
    assert tokens[d.token_span[0]].text == "1"
    assert tokens[d.token_span[1]].text == "20"
    assert d.source_start == tokens[d.token_span[0]].start == pytest.approx(1.8)
    assert d.source_end == tokens[d.token_span[1]].end
    assert d.word_span == (4, 10)


def test_word_span_and_token_span_differ_when_numbers_take_several_words() -> None:
    result = run("psalm one hundred and nineteen")
    (d,) = result.detections
    assert d.token_span == (0, 1)
    assert d.word_span == (0, 4)
    assert d.source_start == 0.0
    assert d.source_end == result.normalized.tokens[1].end


def test_spans_are_inclusive_and_round_trip_to_source_seconds() -> None:
    w = words("so then", 0.7, "John 3 : 16 says", 0.3, "love")
    result = match_grammar(w)
    (d,) = result.detections
    first, last = d.word_span
    assert [x.text for x in w[first : last + 1]] == ["John", "3", ":", "16"]
    assert d.source_start == w[first].start
    assert d.source_end == w[last].end


def test_p10_span_starts_at_the() -> None:
    result = run("so", 1.0, "the third chapter of John , verse 16 says")
    (d,) = result.detections
    assert result.normalized.tokens[d.token_span[0]].text == "the"
    assert d.word_span == (1, 8)
    assert d.source_start == pytest.approx(1.4)


def test_word_probs_are_per_distinct_source_word() -> None:
    w = words("john 3 : sixteen")
    w[3].probability = 0.5  # "sixteen"
    w[0].probability = 1.0
    (d,) = match_grammar(w).detections
    assert d.word_probs == (1.0, 0.9, 0.9, 0.5)
    assert d.min_word_prob == 0.5
    assert d.mean_word_prob == pytest.approx(0.825)


def test_a_two_word_number_counts_both_words_once() -> None:
    w = words("romans 8 : twenty eight")
    w[3].probability = 0.6
    w[4].probability = 0.8
    (d,) = match_grammar(w).detections
    assert d.word_probs == (0.9, 0.9, 0.9, 0.6, 0.8)


def test_punctuation_attached_to_words_is_stripped_but_timed() -> None:
    w = [W("John", 1.0, 1.3), W("3:16,", 1.4, 1.9), W("says", 2.0, 2.3)]
    (d,) = match_grammar(w).detections
    assert d.reference == ref("John", "John", 3, 16)
    assert (d.source_start, d.source_end) == (1.0, 1.9)
    assert d.word_span == (0, 1)


def test_fragment_probabilities_come_from_the_fragment_not_the_source() -> None:
    w = words("john 3 : 16", 2.0, "verse 5")
    w[-1].probability = 0.3
    ref_d, frag = match_grammar(w).detections
    assert frag.word_probs == (0.9, 0.3)
    assert ref_d.word_probs == (0.9, 0.9, 0.9, 0.9)


def test_ordinary_prose_between_references_never_leaks_into_spans() -> None:
    result = run("john 3 : 16", 3.0, "is a great verse", 3.0, "romans 8 : 28")
    assert [d.word_span for d in result.detections] == [(0, 3), (8, 11)]


# -- the output contract ----------------------------------


def _validate(definition: str, instance: object) -> None:
    schema = {"$defs": SCHEMA["$defs"], "$ref": f"#/$defs/{definition}"}
    jsonschema.validate(instance, schema)


def test_detections_are_immutable() -> None:
    d = one("john 3 : 16")
    with pytest.raises(AttributeError):
        d.pattern = "P1"  # type: ignore[misc]
    with pytest.raises(AttributeError):
        d.reference.chapter = 4  # type: ignore[misc]


def test_detection_block_matches_the_cue_document_schema() -> None:
    result = run("turn to", 0.5, "first corinthians six , nineteen and twenty", 4.0, "verse 5")
    assert len(result.detections) == 2
    for d in result.detections:
        _validate("detection", d.detection_block())
        _validate("reference", d.reference.to_dict())
    block = result.detections[0].detection_block()
    assert block["pattern"] == "P6" and block["contextual"] is False
    assert block["book_match"] == {"tier": "exact", "distance": 0}
    assert result.detections[1].detection_block()["contextual"] is True


def test_every_pattern_id_is_valid_in_the_schema_enum() -> None:
    enum = SCHEMA["$defs"]["detection"]["properties"]["pattern"]["enum"]
    assert list(PATTERN_IDS) == enum


def test_reference_dict_omits_absent_verses() -> None:
    assert ref("Romans", "Rom", 8).to_dict() == {"book": "Romans", "osis": "Rom", "chapter": 8}
    assert ref("Romans", "Rom", 8, 28).to_dict()["verse"] == 28
    assert "verse_end" not in ref("Romans", "Rom", 8, 28).to_dict()
    assert ref("Romans", "Rom", 8, 28, 30).to_dict()["verse_end"] == 30


@pytest.mark.parametrize(
    ("reference", "display"),
    [
        (ref("1 Corinthians", "1Cor", 6, 19, 20), "1 Corinthians 6:19-20"),
        (ref("John", "John", 3, 16), "John 3:16"),
        (ref("Romans", "Rom", 8), "Romans 8"),
        (ref("Psalms", "Ps", 122), "Psalm 122"),
        (ref("Psalms", "Ps", 12, 2), "Psalm 12:2"),
    ],
)
def test_reference_display(reference: Reference, display: str) -> None:
    assert reference.display == display


def test_alternatives_have_the_shape_the_cue_document_needs() -> None:
    (alt,) = one("psalm twelve two").alternatives
    _validate("reference", alt.reference.to_dict())
    assert alt.reason


def test_grammar_result_exposes_the_tokens_spans_index_into() -> None:
    w = words("turn to john 3 : 16")
    result = match_grammar(w)
    assert result.normalized.tokens == normalize_words(w).tokens
    (d,) = result.detections
    assert 0 <= d.token_span[0] <= d.token_span[1] < len(result.normalized.tokens)


def test_deterministic() -> None:
    parts = ("romans 8", 3.0, "psalm twelve two", 3.0, "verse 4")
    assert match_grammar(words(*parts)).detections == match_grammar(words(*parts)).detections


def test_every_emitted_book_is_in_the_canon() -> None:
    canon = load_canon()
    result = run(
        "genesis 1 1 exodus 2 3 song of solomon 2 : 4 third john chapter 1 revelations 21 : 4"
    )
    assert len(result.detections) == 5
    for d in result.detections:
        book = canon.by_osis(d.reference.osis)
        assert book is not None and book.name == d.reference.book


# -- the transcript fixture corpus (T-41) ----------------------------------


def _fixture(name: str) -> GrammarResult:
    from types import SimpleNamespace

    return match_grammar([SimpleNamespace(**w) for w in load_words(name)])


def _ref_texts(d: Detection) -> set[str]:
    return {d.reference.display, *(a.reference.display for a in d.alternatives)}


def _overlaps(d: Detection, span: list[float], slack: float = 0.5) -> bool:
    return d.source_start < span[1] + slack and d.source_end > span[0] - slack


EXPECTED_FIXTURE_DETECTIONS = {
    "numbers-and-ordinals": [
        ("P6", "1 Corinthians 6:19-20", False),
        ("P4", "2 Timothy 1:7", False),
        ("P5", "Romans 8", False),
        ("P4", "Psalm 119:176", False),
        ("P8", "Philippians 4:13", False),
        # "Third John, verse two": the grammar has no pattern for a verse in a single-chapter
        # book (P1-P12 all need a chapter number or a prior reference), so "verse two" is
        # carried from the nearest earlier reference. Pinned so any change is deliberate.
        ("P12", "Philippians 4:2", True),
    ],
    "context-and-ambiguity": [
        ("P4", "Romans 8:28", False),
        ("P5", "Romans 12", False),
        ("P12", "Romans 12:12", True),
        ("P8", "Psalm 122", False),
    ],
    "read-vs-paraphrase": [
        ("P6", "1 Corinthians 13:4-7", False),
        # Only the chapter is spoken; the verses are found later by alignment (T-17).
        ("P9", "1 Corinthians 13", False),
        ("P4", "Joshua 1:9", False),
    ],
    "long-sermon-filler": [
        ("P4", "John 3:16", False),
        ("P8", "John 3:16", False),
        ("P4", "John 3:16", False),
    ],
}

# Labelled references the grammar cannot reach, with the reason. Asserted to stay unreachable
# so that closing the gap forces this table to be updated.
UNREACHABLE_LABELS = {("numbers-and-ordinals", "3 John 2")}


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_detections(name: str) -> None:
    got = [(d.pattern, d.reference.display, d.contextual) for d in _fixture(name).detections]
    assert got == EXPECTED_FIXTURE_DETECTIONS[name]


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_labels_are_all_found_with_matching_times(name: str) -> None:
    result = _fixture(name)
    for label in load_labels(name):
        if label.get("negative"):
            continue
        key = (name, label["reference"])
        hits = [d for d in result.detections if _overlaps(d, label["mention_span_s"])]
        if key in UNREACHABLE_LABELS:
            assert not any(label["reference"] in _ref_texts(d) for d in result.detections)
            continue
        assert hits, label
        book_chapter = label["reference"].split(":")[0]
        assert any(any(r.split(":")[0] == book_chapter for r in _ref_texts(d)) for d in hits), (
            label,
            [_ref_texts(d) for d in hits],
        )
        # The detection starts inside the labelled mention, not before it.
        best = min(hits, key=lambda d: abs(d.source_start - label["mention_span_s"][0]))
        assert best.source_start >= label["mention_span_s"][0] - 0.1
        assert best.source_start <= label["mention_span_s"][1]


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_negative_spans_produce_zero_detections(name: str) -> None:
    result = _fixture(name)
    for label in load_labels(name):
        if not label.get("negative"):
            continue
        inside = [d for d in result.detections if _overlaps(d, label["span_s"], slack=0.0)]
        assert inside == [], label["note"]


def test_fixture_psalms_ambiguity_pair_matches_the_label() -> None:
    (label,) = [x for x in load_labels("context-and-ambiguity") if "alternative_reference" in x]
    (d,) = [d for d in _fixture("context-and-ambiguity").detections if d.pattern == "P8"]
    assert d.reference.display == label["reference"]
    assert [a.reference.display for a in d.alternatives] == [label["alternative_reference"]]


def test_fixture_chapter_only_label_has_no_verse() -> None:
    d = next(d for d in _fixture("numbers-and-ordinals").detections if d.pattern == "P5")
    assert d.reference.display == "Romans 8" and d.chapter_only


def test_fixture_context_carry_uses_the_labelled_chapter() -> None:
    frag = next(d for d in _fixture("context-and-ambiguity").detections if d.contextual)
    assert frag.reference.display == "Romans 12:12"
    assert frag.source_start - _fixture("context-and-ambiguity").detections[1].source_end < 120


def test_fixture_probabilities_reflect_the_mishearing() -> None:
    d = next(d for d in _fixture("numbers-and-ordinals").detections if d.pattern == "P8")
    assert d.book_match.tier == "alias"
    assert d.min_word_prob <= d.mean_word_prob <= 1.0


def test_long_fixture_runs_quickly() -> None:
    import time

    start = time.perf_counter()
    result = _fixture("long-sermon-filler")
    assert time.perf_counter() - start < 5.0
    assert len(result.normalized.tokens) > 7000


# -- robustness ------------------------------------------------------------------

_VOCAB = (
    "john romans psalm psalms 1 corinthians first second third job mark acts chapter verse verses "
    "the of and through to , : - 3 8 16 19 20 119 one two twelve nineteen twenty eight hundred "
    "blah philippines fourth".split()
)


def test_random_word_streams_keep_every_invariant() -> None:
    import random

    rng = random.Random(1203)
    for _ in range(300):
        text = " ".join(rng.choice(_VOCAB) for _ in range(rng.randint(0, 40)))
        w = words(text)
        result = match_grammar(w)
        tokens = result.normalized.tokens
        previous_end = -1
        for d in result.detections:
            first, last = d.token_span
            assert previous_end < first <= last < len(tokens), text
            previous_end = last
            lo, hi = d.word_span
            assert 0 <= lo <= hi < len(w)
            assert d.source_start == tokens[first].start and d.source_end == tokens[last].end
            assert d.source_start < d.source_end
            assert d.pattern in PATTERN_IDS
            assert d.contextual == (d.pattern in FRAGMENT_PATTERN_IDS)
            assert (d.carried_from is not None) == d.contextual
            assert d.word_probs and all(0.0 <= p <= 1.0 for p in d.word_probs)
            assert d.reference.chapter >= 1
            assert d.reference.verse_end is None or d.reference.verse is not None
            for a in d.alternatives:
                assert a.reference.osis == d.reference.osis
