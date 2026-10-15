"""Tests for the grammar: book pre-pass, grammar view and patterns (04 section 4)."""

from __future__ import annotations

import re

from versesync.detect.canon import load_canon
from versesync.detect.grammar import Candidate, build_view, find_books, find_candidates
from versesync.detect.normalize import normalize
from versesync.detect.types import Token
from versesync.types import Word

CANON = load_canon()


def words(text: str, start: float = 0.0, prob: float = 1.0) -> list[Word]:
    """Words half a second apart. The normaliser drops a lone ':' or '-', so the spaces around
    a chapter/verse separator are closed up, as Whisper writes "3:16"."""
    glued = re.sub(r"(?<=\d) ([:\-]) (?=\d)", r"\1", text)
    return [
        Word(text=w, start=start + 0.5 * i, end=start + 0.5 * i + 0.4, probability=prob)
        for i, w in enumerate(glued.split())
    ]


def toks(text: str, start: float = 0.0) -> list[Token]:
    return normalize(words(text, start), CANON)


def test_prepass_finds_non_overlapping_books_left_to_right():
    tokens = toks("see romans 8 and first corinthians 6")
    matches = find_books(tokens, CANON)
    assert [(m.book.osis, m.first, m.last) for m in matches] == [
        ("Rom", 1, 1),
        ("1Cor", 4, 5),
    ]


def test_prepass_fuzzy_only_fires_when_a_number_follows():
    assert find_books(toks("she lost her jub"), CANON) == []
    assert [m.book.osis for m in find_books(toks("philippines 4"), CANON)] == ["Phil"]
    assert [m.book.osis for m in find_books(toks("philippines chapter 4"), CANON)] == ["Phil"]
    assert [m.book.osis for m in find_books(toks("philippines , verse 4"), CANON)] == ["Phil"]
    assert find_books(toks("philippines chapter of"), CANON) == []


def test_view_folds_each_book_into_one_token_and_maps_back():
    tokens = toks("read first corinthians 6:19-20 now")
    view = build_view(tokens, find_books(tokens, CANON))
    assert view.search.text == "read §b0 6 : 19 - 20 now"
    assert view.spans[1] == (1, 2)  # "1 corinthians" is token 1..2
    assert view.spans[2] == (3, 3)
    book = view.tokens[1]
    assert (book.start, book.end) == (tokens[1].start, tokens[2].end)


# --- Patterns ----------------------------------------------------------------------------------


def find(text: str, start: float = 0.0) -> list[Candidate]:
    return find_candidates(toks(text, start), CANON)


def fields(c: Candidate) -> tuple[str, int, int | None, int | None, str]:
    return c.book.osis, c.chapter, c.verse, c.verse_end, c.pattern


def test_p1_book_chapter_verse_range():
    found = find("1 corinthians 6 : 19 - 20", start=10.0)
    assert [fields(c) for c in found] == [("1Cor", 6, 19, 20, "P1")]


def test_p2_book_chapter_verse():
    assert [fields(c) for c in find("john 3 : 16", start=10.0)] == [("John", 3, 16, None, "P2")]


def test_p9_book_chapter_only():
    found = find("romans 8", start=10.0)
    assert [fields(c) for c in found] == [("Rom", 8, None, None, "P9")]
    assert found[0].verse is None  # chapter-only is never expanded to verse 1


def test_spoken_numbers_reach_the_patterns():
    assert [fields(c) for c in find("romans eight")] == [("Rom", 8, None, None, "P9")]


def test_candidate_spans_and_times():
    # words: 0 "so" 1 "john" 2 "3:16" 3 "says"
    found = find("so john 3 : 16 says", start=10.0)
    assert len(found) == 1
    c = found[0]
    assert c.token_span == (1, 4)
    assert c.word_span == (1, 2)
    assert (c.source_start, c.source_end) == (10.5, 11.4)
    assert c.contextual is False
    assert c.book_match.book.osis == "John"
    assert c.alternatives == () and c.alternative_reason is None


def test_source_start_is_the_ordinal_for_numbered_books():
    c = find("first corinthians 6 : 19", start=10.0)[0]
    assert c.book.osis == "1Cor"
    assert c.token_span[0] == 0
    assert c.word_span[0] == 0
    assert c.source_start == 10.0


def test_asr_prob_is_the_mean_token_prob():
    ws = words("john 3 : 16")  # tokens: john, 3, :, 16; the last three share a word
    ws = [ws[0], Word(ws[1].text, ws[1].start, ws[1].end, 0.5)]
    c = find_candidates(normalize(ws, CANON), CANON)[0]
    assert c.asr_prob == (1.0 + 0.5 * 3) / 4


def test_range_gives_one_p1_and_no_stray_p9():
    found = find("john 3 : 16 - 18")
    assert [fields(c) for c in found] == [("John", 3, 16, 18, "P1")]


def test_a_consumed_span_cannot_be_matched_again():
    # P2 consumes "john 3 : 16", so P9 must not re-match "john 3" inside it.
    found = find("john 3 : 16 and romans 8")
    assert [fields(c) for c in found] == [("John", 3, 16, None, "P2"), ("Rom", 8, None, None, "P9")]


def test_rejected_overlap_does_not_hide_a_later_match():
    # The P9 match for "romans 8" sits after the consumed P2 span and is still found.
    found = find("john 3 : 16 romans 8")
    assert [c.pattern for c in found] == ["P2", "P9"]


def test_patterns_do_not_stop_inside_a_token():
    # "16" must not be cut out of a longer number such as "165".
    assert [fields(c) for c in find("john 3 : 165")] == [("John", 3, 165, None, "P2")]


def test_results_sorted_by_source_start():
    found = find("romans 8 then john 3 : 16 - 18")
    assert [c.pattern for c in found] == ["P9", "P1"]
    assert found[0].source_start < found[1].source_start


def test_no_book_no_candidates():
    assert find("we read chapter 3 verse 16") == []


# --- P3-P5: the chapter keyword forms ---------------------------------------------------------


def test_p3_chapter_verses_range_three_phrasings():
    assert [fields(c) for c in find("john chapter 3 verses 16 through 18", start=10.0)] == [
        ("John", 3, 16, 18, "P3")
    ]
    assert [fields(c) for c in find("romans chapter 8 verses 28 to 30")] == [
        ("Rom", 8, 28, 30, "P3")
    ]
    assert [fields(c) for c in find("first corinthians chapter 6 verses 19 and 20")] == [
        ("1Cor", 6, 19, 20, "P3")
    ]
    assert [fields(c) for c in find("john chapter 3 verse 16 - 18")] == [("John", 3, 16, 18, "P3")]


def test_p4_chapter_verse_three_phrasings():
    assert [fields(c) for c in find("2 timothy chapter 2 verse 15", start=10.0)] == [
        ("2Tim", 2, 15, None, "P4")
    ]
    assert [fields(c) for c in find("john chapter three verse sixteen")] == [
        ("John", 3, 16, None, "P4")
    ]
    assert [fields(c) for c in find("psalm chapter 23 verses 4")] == [("Ps", 23, 4, None, "P4")]


def test_p5_chapter_only_three_phrasings():
    found = find("romans chapter 8", start=10.0)
    assert [fields(c) for c in found] == [("Rom", 8, None, None, "P5")]
    assert found[0].verse is None
    assert [fields(c) for c in find("john chapter three")] == [("John", 3, None, None, "P5")]
    assert [fields(c) for c in find("first john chapter 1 is short")] == [
        ("1John", 1, None, None, "P5")
    ]


def test_keyword_forms_cover_the_whole_phrase_and_leave_no_stray_pattern():
    c = find("john chapter 3 verses 16 through 18", start=10.0)[0]
    assert c.token_span == (0, 6)
    assert (c.source_start, c.source_end) == (10.0, 13.4)


# --- P6-P8: the comma and bare-number forms ---------------------------------------------------


def test_p6_comma_verse_range_three_phrasings():
    assert [fields(c) for c in find("1 corinthians 6 , 19 and 20", start=10.0)] == [
        ("1Cor", 6, 19, 20, "P6")
    ]
    assert [fields(c) for c in find("romans 8, 28 through 30")] == [("Rom", 8, 28, 30, "P6")]
    assert [fields(c) for c in find("john 3 , 16 to 18")] == [("John", 3, 16, 18, "P6")]


def test_p7_comma_verse_three_phrasings():
    assert [fields(c) for c in find("john 3 , 16", start=10.0)] == [("John", 3, 16, None, "P7")]
    assert [fields(c) for c in find("john 3, 16")] == [("John", 3, 16, None, "P7")]
    assert [fields(c) for c in find("second timothy two, fifteen")] == [
        ("2Tim", 2, 15, None, "P7")
    ]


def test_p8_bare_numbers_split_chapter_and_verse_three_phrasings():
    assert [fields(c) for c in find("john 3 16", start=10.0)] == [("John", 3, 16, None, "P8")]
    assert [fields(c) for c in find("romans eight twenty eight")] == [("Rom", 8, 28, None, "P8")]
    assert [fields(c) for c in find("first corinthians 13 4")] == [("1Cor", 13, 4, None, "P8")]


def test_p8_outside_psalms_has_no_alternative_reading():
    c = find("john 3 16")[0]
    assert c.alternatives == () and c.alternative_reason is None


# --- P10: "the ORD chapter of B" -------------------------------------------------------------


def test_p10_ordinal_chapter_of_book_with_verse_three_phrasings():
    found = find("the third chapter of john , verse 16", start=10.0)
    assert [fields(c) for c in found] == [("John", 3, 16, None, "P10")]
    assert found[0].token_span == (0, 7)
    assert found[0].source_start == 10.0
    assert [fields(c) for c in find("the second chapter of romans, verse 4")] == [
        ("Rom", 2, 4, None, "P10")
    ]
    assert [fields(c) for c in find("the eighth chapter of first corinthians , verses 28")] == [
        ("1Cor", 8, 28, None, "P10")
    ]


def test_p10_without_verse_is_chapter_only_three_phrasings():
    found = find("the third chapter of john", start=10.0)
    assert [fields(c) for c in found] == [("John", 3, None, None, "P10")]
    assert found[0].verse is None
    assert [fields(c) for c in find("the eighth chapter of romans")] == [
        ("Rom", 8, None, None, "P10")
    ]
    assert [fields(c) for c in find("the twenty third chapter of first john")] == [
        ("1John", 23, None, None, "P10")
    ]


# --- Priority ---------------------------------------------------------------------------------


def test_priority_order_is_p1_to_p10():
    from versesync.detect.grammar import PATTERNS

    assert [p.name for p in PATTERNS] == [f"P{n}" for n in range(1, 11)]


def test_higher_priority_pattern_wins_when_several_could_match():
    # Each input is also matched by every lower pattern in the same family, and by P9.
    cases = {
        "john 3 : 16 - 18": "P1",  # P1 > P2 > P9
        "john chapter 3 verses 16 through 18": "P3",  # P3 > P4 > P5
        "john chapter 3 verse 16": "P4",  # P4 > P5
        "john 3 , 16 and 17": "P6",  # P6 > P7 > P9
        "john 3 , 16": "P7",  # P7 > P9
        "john 3 16": "P8",  # P8 > P9
    }
    for text, expected in cases.items():
        found = find(text)
        assert [c.pattern for c in found] == [expected], text
        assert found[0].token_span[1] == len(toks(text)) - 1, text


def test_comma_forms_leave_no_stray_chapter_match():
    assert [c.pattern for c in find("john 3 , 16 and 17 then romans 8")] == ["P6", "P9"]
