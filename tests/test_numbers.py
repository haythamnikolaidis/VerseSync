"""Tests for the spoken-number and ordinal parser (04 section 3.1)."""

from __future__ import annotations

import pytest

from versesync.detect.numbers import parse_cardinal, parse_ordinal

_UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
_TEENS = [
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
]  # fmt: skip
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def to_words(n: int, sep: str = " ", use_and: bool = True) -> str:
    """Spell out 1..176 (test-only helper)."""
    if n >= 100:
        rest = n - 100
        head = "one hundred"
        if rest == 0:
            return head
        return head + (" and " if use_and else " ") + to_words(rest, sep, use_and)
    if n >= 20:
        tens, unit = divmod(n, 10)
        return _TENS[tens] + (sep + _UNITS[unit] if unit else "")
    if n >= 10:
        return _TEENS[n - 10]
    return _UNITS[n]


def parse(text: str) -> tuple[int, int] | None:
    return parse_cardinal(text.split(), 0)


@pytest.mark.parametrize("n", range(1, 177))
@pytest.mark.parametrize("sep", [" ", "-"])
@pytest.mark.parametrize("use_and", [True, False])
def test_round_trip_all_numbers(n: int, sep: str, use_and: bool) -> None:
    text = to_words(n, sep, use_and)
    assert parse(text) == (n, len(text.split()))


def test_spec_rows() -> None:
    assert parse("twenty eight") == (28, 2)
    assert parse("twenty-eight") == (28, 1)
    assert parse("forty two") == (42, 2)
    assert parse("one hundred") == (100, 2)
    assert parse("one hundred and nineteen") == (119, 4)
    assert parse("one hundred nineteen") == (119, 3)
    assert parse("176") == (176, 1)
    assert parse("119") == (119, 1)


def test_not_a_number() -> None:
    assert parse_cardinal(["and"], 0) is None
    assert parse_cardinal(["john"], 0) is None
    assert parse_cardinal([], 0) is None
    assert parse_cardinal(["one"], 1) is None
    assert parse("0") is None
    assert parse("177") is None


def test_hundred_and_without_remainder_leaves_and() -> None:
    assert parse_cardinal(["one", "hundred", "and"], 0) == (100, 2)
    assert parse_cardinal(["one", "hundred", "and", "john"], 0) == (100, 2)


def test_greedy_stops_at_range_and_non_numbers() -> None:
    assert parse("one hundred eighty") == (100, 2)
    assert parse("two hundred") == (2, 1)
    assert parse("twenty and") == (20, 1)
    assert parse("twenty eight verse") == (28, 2)
    assert parse("twenty twenty") == (20, 1)


def test_offset_start() -> None:
    words = ["turn", "to", "john", "three", "sixteen"]
    assert parse_cardinal(words, 3) == (3, 1)
    assert parse_cardinal(words, 4) == (16, 1)


def test_ordinal_words() -> None:
    names = [
        "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
    ]  # fmt: skip
    for n, name in enumerate(names, 1):
        assert parse_ordinal([name], 0) == (n, 1)
    assert parse_ordinal(["tenth"], 0) == (10, 1)
    assert parse_ordinal(["twelfth"], 0) == (12, 1)
    assert parse_ordinal(["nineteenth"], 0) == (19, 1)
    assert parse_ordinal(["twentieth"], 0) == (20, 1)
    assert parse_ordinal(["thirtieth"], 0) == (30, 1)


def test_ordinal_compounds() -> None:
    assert parse_ordinal(["twenty-first"], 0) == (21, 1)
    assert parse_ordinal(["twenty", "first"], 0) == (21, 2)
    assert parse_ordinal(["twenty-ninth"], 0) == (29, 1)
    assert parse_ordinal(["thirty-first"], 0) == (31, 1)
    assert parse_ordinal(["thirty", "first"], 0) == (31, 2)
    assert parse_ordinal(["thirty-second"], 0) is None
    assert parse_ordinal(["twenty"], 0) is None


def test_ordinal_digits() -> None:
    assert parse_ordinal(["1st"], 0) == (1, 1)
    assert parse_ordinal(["2nd"], 0) == (2, 1)
    assert parse_ordinal(["3rd"], 0) == (3, 1)
    assert parse_ordinal(["4th"], 0) == (4, 1)
    assert parse_ordinal(["11th"], 0) == (11, 1)
    assert parse_ordinal(["23rd"], 0) == (23, 1)
    assert parse_ordinal(["119th"], 0) == (119, 1)
    assert parse_ordinal(["2th"], 0) is None
    assert parse_ordinal(["0th"], 0) is None


def test_ordinal_roman() -> None:
    assert parse_ordinal(["i"], 0) == (1, 1)
    assert parse_ordinal(["ii"], 0) == (2, 1)
    assert parse_ordinal(["iii"], 0) == (3, 1)
    assert parse_ordinal(["iv"], 0) is None


def test_ordinal_none() -> None:
    assert parse_ordinal(["john"], 0) is None
    assert parse_ordinal(["one"], 0) is None
    assert parse_ordinal([], 0) is None
