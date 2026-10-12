"""Local adapter over a bundled public-domain translation (the World English Bible).

This is the offline provider: the test suite never needs the network, and a licensed local text
can be dropped in as a different store file without touching anything else (risk R-1).

The store is a gzip-compressed JSON file produced by ``tools/generate_web.py``. Its shape is
checked against the canon table on first use; a store that does not line up is
``ProviderUnavailable``, because serving misaligned verses would be worse than serving none.
"""

from __future__ import annotations

import gzip
import json
import threading
import zlib
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from versesync.detect.canon import load_canon

from .base import (
    PassageNotFound,
    ProviderUnavailable,
    RawPassage,
    RawVerse,
    Reference,
    Translation,
    TranslationNotLicensed,
)

SUPPORTED_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class _Store:
    translation: Translation
    books: dict[str, list[list[str | None]]]


def _read_bundled() -> bytes:
    return (resources.files("versesync.bible") / "data" / "web.json.gz").read_bytes()


def _parse_store(blob: bytes) -> _Store:
    try:
        data: dict[str, Any] = json.loads(gzip.decompress(blob).decode("utf-8"))
        if data["schema_version"] != SUPPORTED_SCHEMA_VERSION:
            raise ValueError(f"unsupported store schema {data['schema_version']}")
        t = data["translation"]
        translation = Translation(
            id=str(t["id"]),
            abbreviation=str(t["abbreviation"]),
            name=str(t["name"]),
            attribution=str(t["attribution"]),
            cache_allowed=bool(t["cache_allowed"]),
        )
        books: dict[str, list[list[str | None]]] = data["books"]
        canon = load_canon()
        if set(books) != {b.osis for b in canon.books}:
            raise ValueError("store books do not match the canon table")
        for book in canon.books:
            chapters = books[book.osis]
            if tuple(len(ch) for ch in chapters) != book.verse_counts:
                raise ValueError(f"store versification differs from canon for {book.osis}")
    except (OSError, EOFError, zlib.error, ValueError, KeyError, TypeError, AttributeError) as exc:
        # json.JSONDecodeError and UnicodeDecodeError are ValueError subclasses.
        raise ProviderUnavailable(f"local Bible store is unreadable: {exc}") from exc
    return _Store(translation, books)


class LocalProvider:
    """``BibleProvider`` backed by a local store; the bundled WEB unless ``store_path`` is given."""

    id = "local"

    def __init__(self, store_path: Path | None = None) -> None:
        self._store_path = store_path
        self._store: _Store | None = None
        self._lock = threading.Lock()

    def _load(self) -> _Store:
        with self._lock:
            if self._store is None:
                try:
                    blob = (
                        self._store_path.read_bytes()
                        if self._store_path is not None
                        else _read_bundled()
                    )
                except (OSError, ModuleNotFoundError) as exc:
                    raise ProviderUnavailable(f"local Bible store cannot be read: {exc}") from exc
                self._store = _parse_store(blob)
            return self._store

    def list_translations(self) -> list[Translation]:
        return [self._load().translation]

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        store = self._load()
        if translation_id != store.translation.id:
            raise TranslationNotLicensed(
                f"translation {translation_id!r} is not available from the local provider"
            )
        chapter = self._chapter(store, ref.book, ref.chapter)
        count = len(chapter)

        if ref.verse is None:
            if ref.verse_end is not None:
                raise PassageNotFound("a verse range needs a start verse")
            first, last = 1, count
        else:
            first = ref.verse
            last = ref.verse if ref.verse_end is None else ref.verse_end
            if first < 1 or last < first or last > count:
                raise PassageNotFound(
                    f"{ref.book} {ref.chapter}:{first}-{last} is not within the chapter's "
                    f"{count} verses"
                )

        verses = tuple(
            RawVerse(n, text)
            for n in range(first, last + 1)
            if (text := chapter[n - 1]) is not None
        )
        if not verses:
            # A verse this translation's text base omits (for example Acts 8:37 in the WEB).
            span = str(first) if first == last else f"{first}-{last}"
            raise PassageNotFound(
                f"{ref.book} {ref.chapter}:{span} has no text in {store.translation.abbreviation}"
            )
        return RawPassage(self.id, translation_id, ref.book, ref.chapter, verses)

    def fetch_chapter(self, book: str, chapter: int, translation_id: str) -> RawPassage:
        return self.fetch(Reference(book, chapter), translation_id)

    @staticmethod
    def _chapter(store: _Store, book: str, chapter: int) -> list[str | None]:
        chapters = store.books.get(book)
        if chapters is None:
            raise PassageNotFound(f"unknown book {book!r}")
        if not 1 <= chapter <= len(chapters):
            raise PassageNotFound(f"{book} has no chapter {chapter}")
        return chapters[chapter - 1]
