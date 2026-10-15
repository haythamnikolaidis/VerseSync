"""Local Bible provider over the bundled KJV and optional imported stores (06 section 3.1)."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

from versesync.bible.base import (
    PassageNotFound,
    RawPassage,
    RawVerse,
    Translation,
    TranslationNotLicensed,
)
from versesync.detect.canon import load_canon
from versesync.types import Reference

_BUNDLED = Path(__file__).resolve().parent / "data" / "kjv.json.gz"


def _read_store(path: Path) -> tuple[Translation, dict[str, list[list[str]]]]:
    """Parse one ``*.json.gz`` store: ``{"translation": {...}, "books": [{osis, chapters}]}``."""
    with gzip.open(path, "rt", encoding="utf-8") as f:
        raw: dict[str, Any] = json.load(f)
    meta = raw["translation"]
    translation = Translation(
        id=str(meta["id"]),
        abbreviation=str(meta["abbreviation"]),
        name=str(meta["name"]),
        attribution=str(meta["attribution"]),
        cache_allowed=bool(meta.get("cache_allowed", True)),
    )
    books = {str(b["osis"]): [list(ch) for ch in b["chapters"]] for b in raw["books"]}
    return translation, books


class LocalProvider:
    """Serves verse text from local ``*.json.gz`` stores; never touches the network."""

    id = "local"

    def __init__(self, store_dir: Path | None = None) -> None:
        self._translations: dict[str, Translation] = {}
        self._books: dict[str, dict[str, list[list[str]]]] = {}
        paths = [_BUNDLED]
        if store_dir is not None and Path(store_dir).is_dir():
            paths.extend(sorted(Path(store_dir).glob("*.json.gz")))
        for path in paths:
            translation, books = _read_store(path)
            # Bundled KJV is loaded first; an imported store may not shadow an earlier id.
            if translation.id not in self._translations:
                self._translations[translation.id] = translation
                self._books[translation.id] = books

    def list_translations(self) -> list[Translation]:
        return list(self._translations.values())

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        if ref.verse is None:
            raise PassageNotFound(
                "A chapter-only reference cannot be fetched as a passage; use fetch_chapter."
            )
        last = ref.verse if ref.verse_end is None else ref.verse_end
        return self._passage(ref, translation_id, ref.verse, last)

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        chapter_verses = self._chapter(book_osis, chapter, translation_id)
        book = load_canon().by_osis(book_osis)
        ref = Reference(book.name, book_osis, chapter)
        return self._passage(ref, translation_id, 1, len(chapter_verses))

    def _chapter(self, book_osis: str, chapter: int, translation_id: str) -> list[str]:
        store = self._books.get(translation_id)
        if store is None:
            raise TranslationNotLicensed(
                f"Translation '{translation_id}' is not available in the local store."
            )
        chapters = store.get(book_osis)
        if chapters is None or not 1 <= chapter <= len(chapters):
            raise PassageNotFound(f"{book_osis} {chapter} does not exist in this translation.")
        return chapters[chapter - 1]

    def _passage(self, ref: Reference, translation_id: str, first: int, last: int) -> RawPassage:
        chapter_verses = self._chapter(ref.osis, ref.chapter, translation_id)
        if first < 1 or last < first or last > len(chapter_verses):
            raise PassageNotFound(
                f"Verses {first}-{last} do not exist in {ref.osis} {ref.chapter}."
            )
        verses = tuple(RawVerse(n, chapter_verses[n - 1]) for n in range(first, last + 1))
        payload = json.dumps([{"verse": v.verse, "text": v.text} for v in verses])
        return RawPassage(self.id, translation_id, ref, verses, payload)
