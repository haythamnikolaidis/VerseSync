"""Tests for tier 1 book matching (04 section 4.1)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from versesync.detect.canon import load_canon, normalise_alias
from versesync.detect.fuzzy import SHORT_BOOKS, match_book
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


def _confusions() -> dict[str, str]:
    path = Path(__file__).resolve().parents[1] / "sidecar/versesync/detect/data/confusions.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _always(_index: int) -> bool:
    return True


def _never(_index: int) -> bool:
    return False


@pytest.mark.parametrize("heard, osis", sorted(_confusions().items()))
def test_every_confusion_resolves_as_alias_behind_the_gate(heard, osis):
    tokens = norm(heard)
    match = match_book(tokens, 0, CANON, fuzzy_gate=_always)
    assert match is not None
    assert (match.book.osis, match.tier, match.distance) == (osis, "alias", 0)
    assert (match.first, match.last) == (0, len(tokens) - 1)
    assert match_book(tokens, 0, CANON) is None
    assert match_book(tokens, 0, CANON, fuzzy_gate=_never) is None


def test_gate_receives_index_after_the_match():
    seen: list[int] = []

    def gate(index: int) -> bool:
        seen.append(index)
        return True

    match = match_book(norm("see have a cook one"), 1, CANON, fuzzy_gate=gate)
    assert match is not None and match.book.osis == "Hab"
    assert seen == [4]


def test_seed_forms_cover_the_spec_table():
    heard = set(_confusions())
    for form in [
        "philippines",
        "philippi ans",
        "collations",
        "colossions",
        "tight us",
        "have a cook",
        "habakuk",
        "habbakuk",
        "ecclesiasties",
        "deuter onomy",
        "zachariah",
        "zecharia",
        "nehemia",
        "nehamiah",
        "1 thessalonica ns",
        "2 thessalonions",
        "1 thesalonians",
    ]:
        assert form in heard
    # The normaliser strips apostrophes, so these possessives reach the matcher as these forms.
    assert match_book(norm("titus's"), 0, CANON, fuzzy_gate=_always).book.osis == "Titus"
    assert match_book(norm("deuteronomy's"), 0, CANON, fuzzy_gate=_always).book.osis == "Deut"
    assert match_book(norm("ecclesiastes'"), 0, CANON).book.osis == "Eccl"


def _fuzzy(text: str, gate=_always):
    return match_book(norm(text), 0, CANON, fuzzy_gate=gate)


def test_philippines_is_caught_by_tier_2_not_tier_3():
    match = _fuzzy("philippines")
    assert (match.book.osis, match.tier, match.distance) == ("Phil", "alias", 0)


def test_one_edit_misspelling_is_fuzzy_at_distance_1():
    match = _fuzzy("philipians")
    assert (match.book.osis, match.tier, match.distance) == ("Phil", "fuzzy", 1)
    assert (match.first, match.last) == (0, 0)


def test_two_edits_match_on_long_names_and_three_do_not():
    match = _fuzzy("lebitikus")
    assert (match.book.osis, match.tier, match.distance) == ("Lev", "fuzzy", 2)
    assert _fuzzy("lexitxcxs") is None


def test_shorter_candidates_allow_only_one_edit():
    assert _fuzzy("hoseb").book.osis == "Hos"  # five letters: one edit allowed
    assert _fuzzy("hosbc") is None


def test_fuzzy_requires_the_gate():
    assert _fuzzy("philipians", gate=None) is None
    assert _fuzzy("philipians", gate=_never) is None


def test_gate_is_asked_about_the_token_after_the_window():
    seen: list[int] = []

    def gate(index: int) -> bool:
        seen.append(index)
        return True

    assert match_book(norm("see philipians one"), 1, CANON, fuzzy_gate=gate) is not None
    assert seen == [2]


def test_two_token_window_and_ordinal_prefix():
    match = _fuzzy("1 corinthyans")
    assert (match.book.osis, match.tier, match.distance) == ("1Cor", "fuzzy", 1)
    assert (match.first, match.last) == (0, 1)
    # The ordinal must agree exactly: "4 john" must not drift to "1 john".
    assert _fuzzy("4 johm") is None


@pytest.mark.parametrize("word", ["jobs", "marks", "number", "ruths", "jame", "amo", "judgess"])
def test_short_book_neighbours_never_fuzzy_match(word):
    assert _fuzzy(word) is None


@pytest.mark.parametrize("name", sorted(SHORT_BOOKS))
def test_short_books_never_resolve_via_fuzzy(name):
    for variant in (name + "s", name[:-1], name + "x", name[1:]):
        match = _fuzzy(variant)
        assert match is None or match.tier != "fuzzy" or match.book.name.lower() not in SHORT_BOOKS


@pytest.mark.parametrize(
    "sentence",
    [
        "he lost his job last year",
        "faith without works acts dead",
        "mark my words",
        "the numbers don't lie",
        "he was a judge for thirty years",
        "in the book of life",
        "romans were known for their roads",
    ],
)
def test_negative_sentences_never_reach_tier_2_or_3(sentence):
    # Without a passing gate only tier 1 can fire. Whether an exact "job" or "romans" is a
    # reference is decided later by the grammar and canon validation, so only the tier is asserted.
    tokens = norm(sentence)
    for i in range(len(tokens)):
        for gate in (None, _never):
            match = match_book(tokens, i, CANON, fuzzy_gate=gate)
            assert match is None or match.tier == "exact"


def test_mark_still_matches_at_tier_1_when_exact():
    match = match_book(norm("mark"), 0, CANON)
    assert (match.book.osis, match.tier, match.distance) == ("Mark", "exact", 0)
