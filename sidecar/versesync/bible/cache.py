"""Verse cache: a SQLite-backed ``BibleProvider`` wrapper (06 sections 4, 5)."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from versesync.bible.base import BibleProvider, RawPassage, RawVerse, Translation
from versesync.detect.canon import load_canon
from versesync.paths import cache_dir
from versesync.types import Reference

_SCHEMA = """
CREATE TABLE IF NOT EXISTS verses (
    provider_id TEXT NOT NULL,
    translation_id TEXT NOT NULL,
    osis_book TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    verse_start INTEGER NOT NULL,
    verse_end INTEGER NOT NULL,
    payload TEXT NOT NULL,
    verses TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, translation_id, osis_book, chapter, verse_start, verse_end)
)
"""

_Key = tuple[str, str, str, int, int, int]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CachingProvider:
    """Wraps any ``BibleProvider``; entries never expire and only cacheable translations persist."""

    def __init__(
        self,
        inner: BibleProvider,
        db_path: Path | None = None,
        now: Callable[[], str] = _utc_now,
    ) -> None:
        self._inner = inner
        self.id = inner.id
        self._path = Path(db_path) if db_path is not None else cache_dir() / "verses.sqlite3"
        self._now = now  # injected so the fetch timestamp never touches the key path
        self._cacheable: dict[str, bool] = {}

    def list_translations(self) -> list[Translation]:
        translations = self._inner.list_translations()
        for t in translations:
            self._cacheable[t.id] = t.cache_allowed
        return translations

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        first = ref.verse if ref.verse is not None else 0
        last = ref.verse_end if ref.verse_end is not None else first
        key = (self.id, translation_id, ref.osis, ref.chapter, first, last)
        return self._through(
            key, ref, translation_id, lambda: self._inner.fetch(ref, translation_id)
        )

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        key = (self.id, translation_id, book_osis, chapter, 0, 0)
        raw = self._lookup(key) if self._allowed(translation_id) else None
        if raw is not None:
            return raw
        fetched = self._inner.fetch_chapter(book_osis, chapter, translation_id)
        if self._allowed(translation_id):
            self._store(key, fetched)
        return fetched

    def clear(self) -> None:
        if not self._path.exists():
            return
        with closing(sqlite3.connect(self._path)) as db, db:
            db.execute(_SCHEMA)
            db.execute("DELETE FROM verses")

    def _allowed(self, translation_id: str) -> bool:
        if translation_id not in self._cacheable:
            self.list_translations()
        # An unknown translation is treated as not cacheable (the conservative reading).
        return self._cacheable.get(translation_id, False)

    def _through(
        self,
        key: _Key,
        ref: Reference,
        translation_id: str,
        load: Callable[[], RawPassage],
    ) -> RawPassage:
        if not self._allowed(translation_id):
            return load()
        hit = self._lookup(key, ref)
        if hit is not None:
            return hit
        fetched = load()
        self._store(key, fetched)
        return fetched

    def _lookup(self, key: _Key, ref: Reference | None = None) -> RawPassage | None:
        if not self._path.exists():
            return None
        with closing(sqlite3.connect(self._path)) as db:
            try:
                row = db.execute(
                    "SELECT payload, verses FROM verses WHERE provider_id=? AND translation_id=? "
                    "AND osis_book=? AND chapter=? AND verse_start=? AND verse_end=?",
                    key,
                ).fetchone()
            except sqlite3.OperationalError:
                return None
        if row is None:
            return None
        provider_id, translation_id, osis, chapter, _, _ = key
        verses = tuple(RawVerse(int(v["verse"]), str(v["text"])) for v in json.loads(row[1]))
        reference = (
            ref if ref is not None else Reference(load_canon().by_osis(osis).name, osis, chapter)
        )
        return RawPassage(provider_id, translation_id, reference, verses, row[0])

    def _store(self, key: _Key, raw: RawPassage) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        verses = json.dumps([{"verse": v.verse, "text": v.text} for v in raw.verses])
        with closing(sqlite3.connect(self._path)) as db, db:
            db.execute(_SCHEMA)
            db.execute(
                "INSERT OR REPLACE INTO verses VALUES (?,?,?,?,?,?,?,?,?)",
                (*key, raw.payload, verses, self._now()),
            )
