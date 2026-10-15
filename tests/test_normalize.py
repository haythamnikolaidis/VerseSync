"""Tests for the normalisation pass (04 section 3)."""

from __future__ import annotations

from tests.transcript_fixtures import FIXTURES_DIR

from versesync.detect.canon import load_canon
from versesync.detect.normalize import normalize
from versesync.detect.types import Token
from versesync.types import Word, load_words

CANON = load_canon()


def make_words(text: str) -> list[Word]:
    return [
        Word(text=w, start=float(i), end=i + 0.5, probability=1.0 - i / 100)
        for i, w in enumerate(text.split())
    ]


def norm(text: str) -> list[Token]:
    return normalize(make_words(text), CANON)


def shape(tokens: list[Token]) -> list[tuple[str, str]]:
    return [(t.kind, t.text) for t in tokens]


def test_spoken_numbers_collapse_across_words():
    tokens = norm("twenty eight")
    assert shape(tokens) == [("number", "28")]
    assert tokens[0].value == 28
    assert tokens[0].word_ids == (0, 1)
    assert (tokens[0].start, tokens[0].end) == (0.0, 1.5)


def test_hyphenated_numeral_is_one_token():
    assert shape(norm("twenty-eight")) == [("number", "28")]


def test_digits_and_words_agree():
    for spoken, digits in [("nineteen", "19"), ("one hundred and nineteen", "119")]:
        a, b = norm(spoken), norm(digits)
        assert [(t.text, t.value) for t in a] == [(t.text, t.value) for t in b]


def test_colon_and_dash_between_digits_are_punct():
    assert shape(norm("3:16")) == [("number", "3"), ("punct", ":"), ("number", "16")]
    assert shape(norm("19-20")) == [("number", "19"), ("punct", "-"), ("number", "20")]
    tokens = norm("3:16")
    assert [t.word_ids for t in tokens] == [(0,), (0,), (0,)]


def test_trailing_comma_is_punct_and_other_punctuation_dropped():
    assert shape(norm("Six, nineteen.")) == [
        ("number", "6"),
        ("punct", ","),
        ("number", "19"),
    ]
    assert shape(norm('"God!" he said; (really?)')) == [
        ("word", "god"),
        ("word", "he"),
        ("word", "said"),
        ("word", "really"),
    ]
    assert shape(norm(",")) == [("punct", ",")]
    assert norm("...") == []


def test_comma_blocks_number_merging():
    assert shape(norm("twenty, eight")) == [
        ("number", "20"),
        ("punct", ","),
        ("number", "8"),
    ]


def test_prob_is_minimum_over_source_words():
    words = [Word("twenty", 0.0, 0.4, 0.9), Word("eight", 0.5, 0.9, 0.6)]
    (token,) = normalize(words, CANON)
    assert token.prob == 0.6
    assert (token.start, token.end) == (0.0, 0.9)


def test_book_prefix_units_become_ordinals():
    assert shape(norm("one corinthians")) == [("ordinal", "1"), ("word", "corinthians")]
    assert shape(norm("2 timothy")) == [("ordinal", "2"), ("word", "timothy")]
    assert shape(norm("three john")) == [("ordinal", "3"), ("word", "john")]
    assert shape(norm("ii kings")) == [("ordinal", "2"), ("word", "kings")]


def test_unit_not_before_book_stays_a_number():
    assert shape(norm("chapter one verse two")) == [
        ("word", "chapter"),
        ("number", "1"),
        ("word", "verse"),
        ("number", "2"),
    ]
    assert shape(norm("four corinthians")) == [("number", "4"), ("word", "corinthians")]
    assert shape(norm("I have")) == [("word", "i"), ("word", "have")]


def test_ordinal_words_and_digit_forms():
    assert shape(norm("first second 3rd twenty-first")) == [
        ("ordinal", "1"),
        ("ordinal", "2"),
        ("ordinal", "3"),
        ("ordinal", "21"),
    ]
    assert norm("twenty first")[0].word_ids == (0, 1)


def _fixture_tokens() -> tuple[list[Word], list[Token]]:
    words = load_words(FIXTURES_DIR / "numbers-and-ordinals.words.json")
    return words, normalize(words, CANON)


def test_fixture_first_corinthians_reference():
    _, tokens = _fixture_tokens()
    expected = [
        ("ordinal", "1"),
        ("word", "corinthians"),
        ("number", "6"),
        ("punct", ","),
        ("number", "19"),
        ("word", "and"),
        ("number", "20"),
    ]
    assert shape(tokens[4:11]) == expected
    assert [t.value for t in tokens[4:11]] == [1, None, 6, None, 19, None, 20]


def test_fixture_other_references():
    _, tokens = _fixture_tokens()
    texts = " ".join(t.text for t in tokens)
    assert "2 timothy chapter 1 verse 7" in texts
    assert "psalm chapter 119 , verse 176" in texts
    assert "3 john , verse 2" in texts
    assert "philippines 4 13" in texts


def test_fixture_word_ids_ascending_and_cover_all_number_words():
    words, tokens = _fixture_tokens()
    for t in tokens:
        assert t.word_ids
        assert list(t.word_ids) == sorted(set(t.word_ids))
    covered = {i for t in tokens for i in t.word_ids}
    assert covered == set(range(len(words)))
