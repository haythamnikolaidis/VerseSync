"""Bible provider interface, passage types and the typed error taxonomy (06 sections 1, 3)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from versesync.types import Reference


@dataclass(frozen=True)
class Translation:
    id: str
    abbreviation: str
    name: str
    attribution: str
    cache_allowed: bool = True

    def to_json(self) -> dict[str, Any]:
        """The 07 ``GET /translations`` item shape."""
        return {
            "id": self.id,
            "abbreviation": self.abbreviation,
            "name": self.name,
            "attribution": self.attribution,
            "cache_allowed": self.cache_allowed,
        }


@dataclass(frozen=True)
class RawVerse:
    verse: int
    text: str  # provider text, may still contain markup


@dataclass(frozen=True)
class RawPassage:
    provider_id: str
    translation_id: str
    reference: Reference
    verses: tuple[RawVerse, ...]
    payload: str  # raw response, kept for the cache


@dataclass(frozen=True)
class Passage:
    reference: Reference
    reference_display: str
    body: str
    verses: tuple[RawVerse, ...]  # cleaned text, no verse numbers
    word_count: int
    translation: Translation
    truncated: bool
    source: str  # 'provider' | 'cache' | 'local'

    def to_json(self) -> dict[str, Any]:
        """The 06 section 1 / ``POST /resolve`` shape."""
        return {
            "reference": self.reference.to_json(),
            "reference_display": self.reference_display,
            "body": self.body,
            "verses": [{"verse": v.verse, "text": v.text} for v in self.verses],
            "word_count": self.word_count,
            "translation": self.translation.to_json(),
            "truncated": self.truncated,
            "source": self.source,
        }


class BibleError(Exception):
    """Base of all provider failures; ``code`` is stable and message is editor-readable."""

    code: str = "bible_error"
    default_message: str = "The Bible text service reported an error."

    def __init__(self, message: str | None = None) -> None:
        self.message = message or self.default_message
        super().__init__(self.message)


class ProviderUnavailable(BibleError):
    code = "provider_unavailable"
    default_message = "The Bible text provider could not be reached."


class RateLimited(BibleError):
    code = "rate_limited"
    default_message = "The Bible text provider is rate limiting requests."


class PassageNotFound(BibleError):
    code = "passage_not_found"
    default_message = "The requested passage does not exist in this translation."


class TranslationNotLicensed(BibleError):
    code = "translation_not_licensed"
    default_message = "This translation is not available with the configured credentials."


class BibleProvider(Protocol):
    id: str

    def list_translations(self) -> list[Translation]: ...

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage: ...

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage: ...
