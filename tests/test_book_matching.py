"""Tests for tier 1 book matching (04 section 4.1)."""

from __future__ import annotations

import pytest

from versesync.detect.canon import load_canon, normalise_alias
from versesync.detect.fuzzy import match_book
from versesync.detect.normalize import normalize
from versesync.detect.types import Token
from versesync.types import Word

CANON = load_canon()


def norm(text: str) -> list[Token]:
    words = [
        Word(text=w, start=float(i), end=i + 0.5, probability=1.0)
        for i, w in enumerate(text.split())
    ]
    return normalize(words, CANON)


@pytest.mark.parametrize("book", CANON.books, ids=lambda b: b.osis)
def test_every_book_resolves_from_its_canonical_name(book):
    tokens = norm(book.name.lower())
    match = match_book(tokens, 0, CANON)
    assert match is not None
    assert match.book.osis == book.osis
    assert (match.first, match.last) == (0, len(tokens) - 1)


def test_every_alias_resolves():
    for book in CANON.books:
        for alias in book.aliases:
            tokens = norm(alias)
            match = match_book(tokens, 0, CANON)
            assert match is not None, alias
            assert match.book.osis == book.osis, alias
            assert (match.tier, match.distance) == ("exact", 0)
            assert (match.first, match.last) == (0, len(tokens) - 1), alias
            assert normalise_alias(alias)  # aliases are non-empty once normalised


@pytest.mark.parametrize(
    "spoken, osis, last",
    [
        ("1 corinthians", "1Cor", 1),
        ("first corinthians", "1Cor", 1),
        ("one corinthians", "1Cor", 1),
        ("ii timothy", "2Tim", 1),
        ("second timothy", "2Tim", 1),
        ("3rd john", "3John", 1),
        ("song of songs", "Song", 2),
        ("revelations", "Rev", 0),
        ("psalm", "Ps", 0),
    ],
)
def test_ordinal_prefixes_and_multiword_names(spoken, osis, last):
    match = match_book(norm(spoken), 0, CANON)
    assert match is not None
    assert match.book.osis == osis
    assert (match.first, match.last) == (0, last)


def test_match_reports_offsets_within_a_sentence():
    tokens = norm("turn to first corinthians chapter 13")
    assert match_book(tokens, 0, CANON) is None
    match = match_book(tokens, 2, CANON)
    assert match is not None
    assert (match.book.osis, match.first, match.last) == ("1Cor", 2, 3)
    # Starting on the base word alone is the ambiguous bare form.
    assert match_book(tokens, 3, CANON) is None


def test_longest_match_wins():
    match = match_book(norm("song of solomon 2"), 0, CANON)
    assert match is not None
    assert (match.book.osis, match.first, match.last) == ("Song", 0, 2)


def test_bare_numbered_base_is_ambiguous():
    assert match_book(norm("corinthians"), 0, CANON) is None
    assert match_book(norm("timothy"), 0, CANON) is None


def test_non_names_and_bounds_return_none():
    tokens = norm("we lost our keys")
    assert all(match_book(tokens, i, CANON) is None for i in range(len(tokens)))
    assert match_book(tokens, len(tokens), CANON) is None
    assert match_book(tokens, -1, CANON) is None


def test_number_token_ends_a_name():
    tokens = norm("john 3 16")
    match = match_book(tokens, 0, CANON)
    assert match is not None
    assert (match.first, match.last) == (0, 0)
