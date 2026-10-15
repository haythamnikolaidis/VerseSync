"""Tests for the normalisation pass (04 section 3)."""

from __future__ import annotations

from versesync.detect.canon import load_canon
from versesync.detect.normalize import normalize
from versesync.detect.types import Token
from versesync.types import Word

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
