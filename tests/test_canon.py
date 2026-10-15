import json
import time

import pytest
from tests.transcript_fixtures import FIXTURE_NAMES, FIXTURES_DIR

from versesync.detect.canon import Canon, load_canon, normalise_alias
from versesync.types import Reference, Word, load_words


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_load_words_round_trips_fixtures(name):
    path = FIXTURES_DIR / f"{name}.words.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    words = load_words(path)
    assert all(isinstance(w, Word) for w in words)
    assert [
        {"text": w.text, "start": w.start, "end": w.end, "probability": w.probability}
        for w in words
    ] == raw


def test_load_words_accepts_str_path():
    path = FIXTURES_DIR / f"{FIXTURE_NAMES[0]}.words.json"
    assert load_words(str(path)) == load_words(path)


def test_display_forms(canon):
    assert Reference("1 Corinthians", "1Cor", 6, 19, 20).display(canon) == "1 Corinthians 6:19-20"
    assert Reference("John", "John", 3, 16).display(canon) == "John 3:16"
    assert Reference("Psalms", "Ps", 122).display(canon) == "Psalm 122"
    assert Reference("Romans", "Rom", 8).display(canon) == "Romans 8"
    assert "–" not in Reference("1 Corinthians", "1Cor", 6, 19, 20).display(canon)


def test_to_json_omits_none_keys():
    bare = Reference("Romans", "Rom", 8).to_json()
    assert bare == {"book": "Romans", "osis": "Rom", "chapter": 8}
    assert Reference("1 Corinthians", "1Cor", 6, 19, 20).to_json() == {
        "book": "1 Corinthians",
        "osis": "1Cor",
        "chapter": 6,
        "verse": 19,
        "verse_end": 20,
    }


def test_normalise_alias():
    assert normalise_alias("  Philippians. ") == "philippians"
    assert normalise_alias("1  Cor.") == "1 cor"
    assert normalise_alias("Song-of  Solomon") == "song of solomon"
    assert normalise_alias("Café") == "cafe"


def test_sixty_six_books_and_cache(canon):
    assert len(canon.books) == 66
    assert load_canon() is canon
    assert isinstance(canon, Canon)


def test_every_alias_resolves(canon):
    for book in canon.books:
        for alias in (book.name, book.display_name, *book.aliases):
            assert canon.lookup(alias) is not None, alias
        for alias in book.aliases:
            found = canon.lookup(alias)
            assert found is not None
            if found is not book:
                # Shared aliases are allowed only when the canon data has them twice.
                assert alias in found.aliases


def test_lookup_normalises(canon):
    assert canon.lookup("Philippians.").osis == "Phil"
    assert canon.lookup("PSALM").osis == "Ps"
    assert canon.lookup("Psalms").osis == "Ps"
    assert canon.lookup("not a book") is None


def test_by_osis_and_by_name(canon):
    assert canon.by_osis("1Cor").name == "1 Corinthians"
    assert canon.by_name("Psalms").display_name == "Psalm"
    with pytest.raises(KeyError):
        canon.by_osis("Nope")


def test_numbered_bases_and_alias_tokens(canon):
    bases = canon.numbered_bases()
    assert {"samuel", "kings", "chronicles", "corinthians", "john", "peter"} <= bases
    assert canon.max_alias_tokens() >= 3


def test_verse_count(canon):
    assert canon.verse_count(canon.by_osis("Ps"), 119) == 176
    assert canon.verse_count(canon.by_osis("3John"), 1) == 14
    assert canon.verse_count(canon.by_osis("Jude"), 2) is None
    assert canon.verse_count(canon.by_osis("Jude"), 0) is None


def test_warm_load_is_fast():
    load_canon()
    start = time.perf_counter()
    load_canon()
    assert time.perf_counter() - start < 0.05
