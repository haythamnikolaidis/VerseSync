"""Bible provider interface, shared value types and the error taxonomy.

Adapters (``local.py`` now, an API adapter later) implement :class:`BibleProvider`. Every failure
leaves an adapter as one of the four :class:`ProviderError` subclasses, never as a bare
exception (06 section 3.2).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


class ProviderError(Exception):
    """Base of the error taxonomy. Adapters raise only its subclasses."""


class ProviderUnavailable(ProviderError):
    """Network, 5xx, timeout, or an unreadable or corrupt local store."""


class RateLimited(ProviderError):
    """The provider asked us to slow down."""


class PassageNotFound(ProviderError):
    """The reference does not exist, or the translation has no text for it."""


class TranslationNotLicensed(ProviderError):
    """The translation is not available to these credentials."""


@dataclass(frozen=True)
class Translation:
    id: str
    abbreviation: str
    name: str
    attribution: str
    cache_allowed: bool


@dataclass(frozen=True)
class Reference:
    """A verse, a verse range, or (with ``verse`` None) a whole chapter.

    ``book`` is the OSIS id from the canon table (``"1Cor"``), not a display name.
    """

    book: str
    chapter: int
    verse: int | None = None
    verse_end: int | None = None


@dataclass(frozen=True)
class RawVerse:
    number: int
    text: str


@dataclass(frozen=True)
class RawPassage:
    """What an adapter returns: provider text, possibly still carrying markup."""

    provider_id: str
    translation_id: str
    book: str
    chapter: int
    verses: tuple[RawVerse, ...]


@runtime_checkable
class BibleProvider(Protocol):
    id: str

    def list_translations(self) -> list[Translation]:
        """Translations available to these credentials, with attribution text."""

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        """One passage. Raises ProviderUnavailable, PassageNotFound, RateLimited,
        or TranslationNotLicensed, never a bare exception."""

    def fetch_chapter(self, book: str, chapter: int, translation_id: str) -> RawPassage:
        """Whole chapter, for the chapter-only enhancement."""
