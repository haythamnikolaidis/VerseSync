from __future__ import annotations

import sqlite3
from pathlib import Path

from versesync.bible.base import RawPassage, RawVerse, Translation
from versesync.bible.cache import CachingProvider
from versesync.types import Reference


class CountingProvider:
    id = "fake"

    def __init__(self) -> None:
        self.calls = 0
        self.translations = [
            Translation("open", "OPEN", "Open", "Open licence.", cache_allowed=True),
            Translation("closed", "CLS", "Closed", "Restricted.", cache_allowed=False),
        ]

    def list_translations(self) -> list[Translation]:
        return list(self.translations)

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        self.calls += 1
        first = ref.verse or 1
        last = ref.verse_end or first
        verses = tuple(RawVerse(n, f"text {n}") for n in range(first, last + 1))
        return RawPassage(self.id, translation_id, ref, verses, f"payload {first}-{last}")

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        self.calls += 1
        ref = Reference("John", book_osis, chapter)
        return RawPassage(self.id, translation_id, ref, (RawVerse(1, "one"),), "chapter")


def _ref(book: str = "John", verse: int = 16, end: int | None = None) -> Reference:
    return Reference(book, "John", 3, verse, end)


def _rows(db_path: Path) -> int:
    con = sqlite3.connect(db_path)
    try:
        return int(con.execute("SELECT COUNT(*) FROM verses").fetchone()[0])
    finally:
        con.close()


def test_warm_fetch_makes_no_inner_calls(tmp_path: Path) -> None:
    inner = CountingProvider()
    cache = CachingProvider(inner, tmp_path / "v.sqlite3", now=lambda: "t0")
    first = cache.fetch(_ref(), "open")
    second = cache.fetch(_ref(), "open")
    assert inner.calls == 1
    assert second == first
    chapter = cache.fetch_chapter("John", 3, "open")
    assert cache.fetch_chapter("John", 3, "open") == chapter
    assert inner.calls == 2


def test_uncacheable_translation_leaves_no_trace(tmp_path: Path) -> None:
    inner = CountingProvider()
    db = tmp_path / "v.sqlite3"
    cache = CachingProvider(inner, db)
    cache.fetch(_ref(), "closed")
    cache.fetch(_ref(), "closed")
    cache.fetch_chapter("John", 3, "closed")
    assert inner.calls == 3
    assert not db.exists()
    cache.fetch(_ref(), "open")
    assert _rows(db) == 1
    cache.fetch(_ref(), "closed")
    assert _rows(db) == 1


def test_clear_empties_cache(tmp_path: Path) -> None:
    inner = CountingProvider()
    db = tmp_path / "v.sqlite3"
    cache = CachingProvider(inner, db)
    cache.fetch(_ref(), "open")
    assert _rows(db) == 1
    cache.clear()
    assert _rows(db) == 0
    cache.fetch(_ref(), "open")
    assert inner.calls == 2


def test_clear_without_database_is_harmless(tmp_path: Path) -> None:
    db = tmp_path / "v.sqlite3"
    CachingProvider(CountingProvider(), db).clear()
    assert not db.exists()


def test_cache_survives_new_instance(tmp_path: Path) -> None:
    db = tmp_path / "v.sqlite3"
    CachingProvider(CountingProvider(), db).fetch(_ref(), "open")
    inner = CountingProvider()
    again = CachingProvider(inner, db).fetch(_ref(), "open")
    assert inner.calls == 0
    assert again.verses == (RawVerse(16, "text 16"),)
    assert again.payload == "payload 16-16"


def test_equivalent_references_share_one_entry(tmp_path: Path) -> None:
    inner = CountingProvider()
    db = tmp_path / "v.sqlite3"
    cache = CachingProvider(inner, db)
    cache.fetch(_ref("John"), "open")
    cache.fetch(_ref("Jn"), "open")
    cache.fetch(_ref("John", 16, 16), "open")
    assert inner.calls == 1
    assert _rows(db) == 1


def test_default_path_uses_app_home(app_home: Path) -> None:
    CachingProvider(CountingProvider()).fetch(_ref(), "open")
    assert _rows(app_home / "cache" / "verses.sqlite3") == 1
