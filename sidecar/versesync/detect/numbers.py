"""Spoken-number and ordinal parsing (docs/04-reference-detection.md section 3.1).

Inputs are already lowercased and punctuation-stripped words. Both parsers look at
``words[i:]`` only and return ``(value, words_consumed)`` or ``None``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

# 176 is the highest verse number in the canon (Psalm 119:176); chapters stop at 150.
MAX_VALUE = 176

_UNITS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
}
_TEENS = {
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
}
_TENS = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}

_ORD_UNITS = {
    "first": 1,
    "second": 2,
    "third": 3,
    "fourth": 4,
    "fifth": 5,
    "sixth": 6,
    "seventh": 7,
    "eighth": 8,
    "ninth": 9,
}
_ORD_SIMPLE = {
    **_ORD_UNITS,
    "tenth": 10,
    "eleventh": 11,
    "twelfth": 12,
    "thirteenth": 13,
    "fourteenth": 14,
    "fifteenth": 15,
    "sixteenth": 16,
    "seventeenth": 17,
    "eighteenth": 18,
    "nineteenth": 19,
    "twentieth": 20,
    "thirtieth": 30,
}
# Only twenty-first..twenty-ninth and thirty-first are needed (first..thirty-first).
_ORD_TENS = {"twenty": 20, "thirty": 30}
_ROMAN = {"i": 1, "ii": 2, "iii": 3}
_DIGITS = re.compile(r"[0-9]+")
_DIGIT_ORDINAL = re.compile(r"([0-9]+)(st|nd|rd|th)")


def _split(word: str) -> list[str]:
    """Split a hyphenated word into its parts; a plain word is one part."""
    return word.split("-") if "-" in word else [word]


def _flatten(words: Sequence[str], i: int, limit: int) -> list[tuple[str, int]]:
    """Up to ``limit`` word parts from ``words[i:]``, each tagged with its source index."""
    parts: list[tuple[str, int]] = []
    for j in range(i, len(words)):
        for part in _split(words[j]):
            parts.append((part, j))
        if len(parts) >= limit:
            break
    return parts


def _below_hundred(parts: list[tuple[str, int]], k: int) -> tuple[int, int] | None:
    """Parse 1..99 at ``parts[k:]``; returns (value, parts_consumed)."""
    if k >= len(parts):
        return None
    word = parts[k][0]
    if word in _TEENS:
        return _TEENS[word], 1
    if word in _TENS:
        if k + 1 < len(parts) and parts[k + 1][0] in _UNITS:
            return _TENS[word] + _UNITS[parts[k + 1][0]], 2
        return _TENS[word], 1
    if word in _UNITS:
        return _UNITS[word], 1
    return None


def parse_cardinal(words: Sequence[str], i: int) -> tuple[int, int] | None:
    """Parse a cardinal number starting at words[i] (already lowercased, punctuation-stripped).

    Returns (value, words_consumed), or None. Covers digits ("119"), units/teens, tens,
    hyphenated and spaced compounds ("twenty-eight", "twenty eight"), and hundreds with an
    optional "and" ("one hundred and nineteen"). Range 1..176.
    """
    if i < 0 or i >= len(words):
        return None
    first = words[i]
    if _DIGITS.fullmatch(first):
        value = int(first)
        return (value, 1) if 1 <= value <= MAX_VALUE else None

    parts = _flatten(words, i, 6)
    if not parts:
        return None

    def consumed(last_part: int) -> int:
        return parts[last_part][1] - i + 1

    head = _below_hundred(parts, 0)
    if head is None:
        return None
    value, n = head
    best = (value, consumed(n - 1))

    # "<unit> hundred [and] [remainder]"
    if value in range(1, 10) and n == 1 and len(parts) > 1 and parts[1][0] == "hundred":
        hundreds = value * 100
        if hundreds > MAX_VALUE:
            return best
        best = (hundreds, consumed(1))
        k = 2
        if k < len(parts) and parts[k][0] == "and":
            k += 1
        rest = _below_hundred(parts, k)
        if rest is not None and hundreds + rest[0] <= MAX_VALUE:
            best = (hundreds + rest[0], consumed(k + rest[1] - 1))
        # With "and" but no valid remainder, "and" is left behind: best stays "x hundred".
    return best


def parse_ordinal(words: Sequence[str], i: int) -> tuple[int, int] | None:
    """first..thirty-first in words, and digit forms "1st", "2nd", "3rd", "23rd", "119th".

    Also the roman numerals "i", "ii", "iii" (book prefixes only). Returns (value, consumed).
    """
    if i < 0 or i >= len(words):
        return None
    word = words[i]
    if word in _ORD_SIMPLE:
        return _ORD_SIMPLE[word], 1
    if word in _ROMAN:
        return _ROMAN[word], 1

    match = _DIGIT_ORDINAL.fullmatch(word)
    if match:
        value = int(match.group(1))
        if 1 <= value <= MAX_VALUE and match.group(2) == _suffix(value):
            return value, 1
        return None

    # twenty-first .. twenty-ninth, thirty-first (hyphenated or spaced)
    parts = _flatten(words, i, 2)
    if len(parts) >= 2 and parts[0][0] in _ORD_TENS and parts[1][0] in _ORD_UNITS:
        value = _ORD_TENS[parts[0][0]] + _ORD_UNITS[parts[1][0]]
        if value <= 31:
            return value, parts[1][1] - i + 1
    return None


def _suffix(value: int) -> str:
    """English ordinal suffix for a digit form (1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st)."""
    if value % 100 in (11, 12, 13):
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(value % 10, "th")
