import json
import time
from importlib import resources

import generate_canon
import pytest

from versesync.detect import canon as canon_mod
from versesync.detect.canon import load_canon, normalize_name

ORDINALS = {
    1: ["1", "first", "1st", "i"],
    2: ["2", "second", "2nd", "ii"],
    3: ["3", "third", "3rd", "iii"],
}


def _raw() -> dict:
    text = (resources.files("versesync.detect") / "data" / "canon.json").read_text("utf-8")
    return json.loads(text)


def test_totals() -> None:
    canon = load_canon()
    assert len(canon.books) == 66
    assert sum(b.chapter_count for b in canon.books) == 1189
    assert sum(sum(b.verse_counts) for b in canon.books) == 31102


def test_testament_split_cross_check() -> None:
    # Independent published figures for the KJV: OT 39 books / 929 chapters / 23,145 verses,
    # NT 27 books / 260 chapters / 7,957 verses.
    books = load_canon().books
    ot, nt = books[:39], books[39:]
    assert (len(ot), sum(b.chapter_count for b in ot), sum(sum(b.verse_counts) for b in ot)) == (
        39,
        929,
        23145,
    )
    assert (len(nt), sum(b.chapter_count for b in nt), sum(sum(b.verse_counts) for b in nt)) == (
        27,
        260,
        7957,
    )


def test_file_metadata_matches_content() -> None:
    raw = _raw()
    assert raw["totals"] == {"books": 66, "chapters": 1189, "verses": 31102}
    assert raw["versification"] == "KJV"
    assert raw["source"]["sha256"]
    for book in raw["books"]:
        assert book["chapter_count"] == len(book["verse_counts"])
        assert all(v >= 1 for v in book["verse_counts"])


def test_known_counts() -> None:
    canon = load_canon()
    assert canon.resolve("Psalms").verses_in(119) == 176  # type: ignore[union-attr]
    assert canon.resolve("Jude").chapter_count == 1  # type: ignore[union-attr]
    assert canon.resolve("Obadiah").verses_in(1) == 21  # type: ignore[union-attr]
    assert canon.resolve("3 John").verses_in(1) == 14  # type: ignore[union-attr]
    assert canon.resolve("Genesis").verses_in(1) == 31  # type: ignore[union-attr]
    assert canon.resolve("John").verses_in(3) == 36  # type: ignore[union-attr]
    assert canon.resolve("Revelation").verses_in(22) == 21  # type: ignore[union-attr]
    assert canon.resolve("Psalms").chapter_count == 150  # type: ignore[union-attr]


def test_osis_ids_unique_and_ordered() -> None:
    books = load_canon().books
    assert len({b.osis for b in books}) == 66
    assert [b.order for b in books] == list(range(1, 67))
    assert books[0].osis == "Gen" and books[-1].osis == "Rev"
    assert load_canon().by_osis("1Cor").name == "1 Corinthians"  # type: ignore[union-attr]


def test_every_book_resolves_from_canonical_osis_and_aliases() -> None:
    canon = load_canon()
    for book in canon.books:
        assert book.aliases, book.name
        for alias in (book.name, book.osis, *book.aliases):
            assert canon.resolve(alias) is book, (alias, book.name)


def test_numbered_books_resolve_from_every_ordinal_form() -> None:
    canon = load_canon()
    numbered = {
        "1Sam": "Samuel", "2Sam": "Samuel", "1Kgs": "Kings", "2Kgs": "Kings",
        "1Chr": "Chronicles", "2Chr": "Chronicles", "1Cor": "Corinthians",
        "2Cor": "Corinthians", "1Thess": "Thessalonians", "2Thess": "Thessalonians",
        "1Tim": "Timothy", "2Tim": "Timothy", "1Pet": "Peter", "2Pet": "Peter",
        "1John": "John", "2John": "John", "3John": "John",
    }  # fmt: skip
    for osis, base in numbered.items():
        book = canon.by_osis(osis)
        assert book is not None
        n = int(osis[0])
        for prefix in ORDINALS[n]:
            assert canon.resolve(f"{prefix} {base}") is book, (prefix, base)
            assert canon.resolve(f"{prefix}. {base}") is book, (prefix, base)
    # Abbreviated and spoken forms from the task file.
    assert canon.resolve("1 Cor").osis == "1Cor"  # type: ignore[union-attr]
    assert canon.resolve("1st Corinthians").osis == "1Cor"  # type: ignore[union-attr]
    assert canon.resolve("I Corinthians").osis == "1Cor"  # type: ignore[union-attr]
    assert canon.resolve("first corinthians").osis == "1Cor"  # type: ignore[union-attr]
    assert canon.resolve("1Cor").osis == "1Cor"  # type: ignore[union-attr]
    assert canon.resolve("Second Timothy").osis == "2Tim"  # type: ignore[union-attr]
    assert canon.resolve("third john").osis == "3John"  # type: ignore[union-attr]


def test_every_book_has_a_name_abbreviation_and_spoken_form() -> None:
    canon = load_canon()
    for book in canon.books:
        norm = {normalize_name(a) for a in book.aliases}
        assert normalize_name(book.name) in norm
        assert normalize_name(book.osis) in norm
        # at least one alias shorter than the canonical name (an abbreviation) unless the
        # canonical name is itself already short
        if len(normalize_name(book.name)) > 5:
            assert any(len(a) < len(normalize_name(book.name)) for a in norm), book.name


@pytest.mark.parametrize(
    ("spoken", "osis"),
    [
        ("Psalm", "Ps"),
        ("psalms", "Ps"),
        ("Ps", "Ps"),
        ("Phil", "Phil"),
        ("Rev", "Rev"),
        ("Revelation", "Rev"),
        ("Revelations", "Rev"),
        ("Song of Solomon", "Song"),
        ("Song of Songs", "Song"),
        ("songs of solomon", "Song"),
        ("Canticles", "Song"),
        ("Canticle of Canticles", "Song"),
        ("Philemon", "Phlm"),
        ("Jude", "Jude"),
        ("Judges", "Judg"),
        ("  JOHN  ", "John"),
        ("Matt.", "Matt"),
    ],
)
def test_spoken_and_abbreviated_forms(spoken: str, osis: str) -> None:
    book = load_canon().resolve(spoken)
    assert book is not None and book.osis == osis


def test_unknown_names_do_not_resolve() -> None:
    canon = load_canon()
    for name in ("", "Hezekiah", "Maccabees", "1 Hezekiah", "4 John", "the"):
        assert canon.resolve(name) is None, name


def test_validity_checks() -> None:
    canon = load_canon()
    jude = canon.resolve("Jude")
    assert jude is not None
    assert canon.is_valid(jude, 1, 25)
    assert not canon.is_valid(jude, 2)
    assert not canon.is_valid(jude, 1, 26)
    assert not canon.is_valid(jude, 0)
    assert not canon.is_valid(jude, 1, 0)


def test_normalize_matches_generator() -> None:
    for text in ["1Cor.", " 1  COR ", "Song of Solomon", "I Corinthians", "St. John", "2nd Pet"]:
        assert normalize_name(text) == generate_canon._norm(text)
    assert normalize_name("1Cor.") == normalize_name("1 cor") == "1 cor"


def test_loads_in_under_50ms() -> None:
    canon_mod.load_canon.cache_clear()
    start = time.perf_counter()
    canon = canon_mod.load_canon()
    elapsed = time.perf_counter() - start
    assert len(canon.books) == 66
    assert elapsed < 0.05, f"canon load took {elapsed * 1000:.1f} ms"
