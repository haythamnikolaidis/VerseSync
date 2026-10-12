import json
from importlib import resources

import pytest

from versesync.detect.fuzzy import (
    EXACT_ONLY_OSIS,
    find_books,
    levenshtein,
    load_matcher,
    number_follows,
)


def toks(text: str) -> list[str]:
    return text.split()


def only(text: str):
    matches = find_books(toks(text))
    assert len(matches) == 1, matches
    return matches[0]


def _seed_entries() -> list[dict]:
    raw = (resources.files("versesync.detect") / "data" / "confusions.json").read_text("utf-8")
    return json.loads(raw)["entries"]


# -- the gate ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "he lost his job",
        "faith without works acts dead",
        "mark my words",
        "turn to philippines",
        "have a cook",
        "the book of job",
        "he is a good judge of numbers",
        "romans",
    ],
)
def test_no_following_number_means_no_match(text: str) -> None:
    assert find_books(toks(text)) == []


def test_gate_opens_with_a_following_number() -> None:
    assert only("turn to philippines 4").book.name == "Philippians"
    assert only("mark 3").book.name == "Mark"


def test_gate_accepts_chapter_keyword_and_chapter_of_forms() -> None:
    assert only("turn to philippines chapter 4").book.name == "Philippians"
    assert only("the third chapter of philippines").book.name == "Philippians"
    assert only("the third chapter of john").book.name == "John"


def test_chapter_keyword_without_number_does_not_open_gate() -> None:
    assert find_books(toks("philippines chapter and verse")) == []
    assert not number_follows(toks("a chapter"), 1)


def test_number_in_the_middle_of_prose_gates_only_adjacent_word() -> None:
    # "job" is exact and adjacent to a number; "acts" is not adjacent to one.
    matches = find_books(toks("acts of kindness job 3"))
    assert [m.book.name for m in matches] == ["Job"]


# -- tier 1 -----------------------------------------------------------------------------


def test_exact_tier_and_distance() -> None:
    m = only("romans 8")
    assert (m.book.name, m.tier, m.distance, m.start, m.end) == ("Romans", "exact", 0, 0, 1)


@pytest.mark.parametrize(
    ("text", "name"),
    [
        ("revelations 3", "Revelation"),
        ("revelation 3", "Revelation"),
        ("psalm 23", "Psalms"),
        ("ps 23", "Psalms"),
        ("song of solomon 2", "Song of Solomon"),
        ("song of songs 2", "Song of Solomon"),
        ("canticles 2", "Song of Solomon"),
        ("first corinthians 6", "1 Corinthians"),
        ("1 corinthians 6", "1 Corinthians"),
        ("one corinthians 6", "1 Corinthians"),
        ("second timothy 2", "2 Timothy"),
        ("3 john 4", "3 John"),
        ("1 john 4", "1 John"),
        ("john 4", "John"),
    ],
)
def test_exact_names_and_aliases(text: str, name: str) -> None:
    m = only(text)
    assert (m.book.name, m.tier, m.distance) == (name, "exact", 0)


def test_ordinal_is_part_of_the_span() -> None:
    m = only("turn to first corinthians 6")
    assert (m.start, m.end) == (2, 4)


def test_multiple_books_in_one_stream() -> None:
    matches = find_books(toks("romans 8 and then 1 john 3 16"))
    assert [(m.book.name, m.start, m.end) for m in matches] == [
        ("Romans", 0, 1),
        ("1 John", 4, 6),
    ]


# -- tier 2 -----------------------------------------------------------------------------


def test_every_seed_confusion_resolves_to_its_book() -> None:
    entries = _seed_entries()
    assert len(entries) >= 20
    canon = load_matcher()._canon
    for entry in entries:
        heard = entry["heard"].split()
        target = entry["book"]
        if target == "Thessalonians":
            heard = ["2", *heard]
            target = "2 Thessalonians"
        m = only(" ".join([*heard, "4"]))
        assert m.book.name == target, entry
        assert m.book is canon.resolve(target)
        assert m.tier in {"exact", "alias"}


@pytest.mark.parametrize(
    ("text", "name"),
    [
        ("philippines 4", "Philippians"),
        ("philippi ans 4", "Philippians"),
        ("collations 3", "Colossians"),
        ("tight us 2", "Titus"),
        ("have a cook 2", "Habakkuk"),
        ("thessalonica ns 5", "Thessalonians"),
    ],
)
def test_curated_tier_reports_alias_with_zero_distance(text: str, name: str) -> None:
    tokens = toks(text)
    if name == "Thessalonians":
        tokens = ["1", *tokens]
        name = "1 Thessalonians"
    m = only(" ".join(tokens))
    assert (m.book.name, m.tier, m.distance) == (name, "alias", 0)


def test_curated_multi_token_span_covers_every_token() -> None:
    m = only("open to have a cook 2")
    assert (m.start, m.end) == (2, 5)


def test_curated_family_entry_needs_an_ordinal() -> None:
    assert find_books(toks("thessalonica ns 5")) == []
    assert only("second thessalonica ns 5").book.name == "2 Thessalonians"


def test_confusions_file_targets_are_valid() -> None:
    # Loading validates every target; a bad entry raises.
    assert load_matcher() is not None


# -- tier 3 -----------------------------------------------------------------------------


def test_fuzzy_reports_tier_and_distance() -> None:
    m = only("ephesions 6")  # one substitution from ephesians
    assert (m.book.name, m.tier, m.distance) == ("Ephesians", "fuzzy", 1)
    m = only("galtions 3")  # two edits, length >= 6
    assert (m.book.name, m.tier, m.distance) == ("Galatians", "fuzzy", 2)


def test_fuzzy_joins_split_tokens() -> None:
    m = only("zephan iah 1")
    assert (m.book.name, m.tier, m.start, m.end) == ("Zephaniah", "fuzzy", 0, 2)


def test_fuzzy_numbered_family_uses_the_ordinal() -> None:
    m = only("second timithy 3")
    assert (m.book.name, m.tier, m.distance) == ("2 Timothy", "fuzzy", 1)
    m = only("first corinthans 13")
    assert (m.book.name, m.tier, m.distance) == ("1 Corinthians", "fuzzy", 1)


def test_fuzzy_family_without_ordinal_does_not_match() -> None:
    assert find_books(toks("timithy 3")) == []


def test_fuzzy_respects_distance_limits() -> None:
    assert find_books(toks("ephxxxns 6")) == []  # three edits, no phonetic help
    assert only("hosia 2").distance == 1  # short candidate: one edit allowed
    assert find_books(toks("hoxia 2")) == []  # short candidate: two edits not allowed


def test_phonetic_key_widens_long_candidates_by_one_edit() -> None:
    # Three edits from "deuteronomy" but the same Double Metaphone key, and length >= 8.
    assert levenshtein("dutaronamy", "deuteronomy") == 3
    m = only("dutaronamy 5")
    assert (m.book.name, m.tier, m.distance) == ("Deuteronomy", "fuzzy", 3)


def test_phonetic_widening_needs_a_matching_key() -> None:
    assert levenshtein("deuteronoxxx", "deuteronomy") == 3
    assert find_books(toks("deuteronoxxx 5")) == []


# -- short high-frequency names ----------------------------------------------------------


EXACT_ONLY_NAMES = ["job", "mark", "acts", "numbers", "judges", "ruth", "james", "amos"]


@pytest.mark.parametrize(
    "heard",
    [
        "jobs", "jab", "jobe", "marc", "marks", "mart", "act", "axe", "number", "member",
        "judge", "budges", "truth", "roth", "rut", "games", "jams", "amok", "amas", "amus",
        "numbrs", "judgs", "jamess",
    ],
)  # fmt: skip
def test_short_names_never_resolve_via_fuzzy(heard: str) -> None:
    found = find_books([heard, "3"])
    assert all(m.tier == "exact" for m in found), found


@pytest.mark.parametrize("name", EXACT_ONLY_NAMES)
def test_short_names_match_at_tier_one(name: str) -> None:
    m = only(f"{name} 3")
    assert (m.tier, m.distance) == ("exact", 0)
    assert m.book.name.lower() == name


def test_exact_only_set_is_the_eight_spec_names() -> None:
    assert EXACT_ONLY_OSIS == {"Job", "Mark", "Acts", "Num", "Judg", "Ruth", "Jas", "Amos"}


@pytest.mark.parametrize("heard", ["like", "look", "join", "dude", "palm", "long", "jol"])
def test_other_short_words_do_not_fuzz_into_books(heard: str) -> None:
    assert find_books([heard, "3"]) == []


def test_no_fuzzy_match_may_land_on_an_exact_only_book() -> None:
    matcher = load_matcher()
    for pool_books in matcher._fuzzy_plain.values():
        assert not {b.osis for b in pool_books} & EXACT_ONLY_OSIS


# -- helpers ----------------------------------------------------------------------------


def test_levenshtein() -> None:
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("", "abc") == 3
    assert levenshtein("same", "same") == 0
    assert levenshtein("abcdef", "uvwxyz", 2) == 3
