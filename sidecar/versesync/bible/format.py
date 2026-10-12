"""VerseFlow-compatible passage formatting (06 section 2).

The reference line and the body are byte-for-byte what VerseFlow's ``scripture-parser.js``
expects: ``Book C:V[-V] (ABBR)`` on one line, then the verse texts joined by single spaces with the
verse numbers kept. Verse numbers stay in the body on purpose; that was a client decision.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

from versesync.detect.canon import load_canon

from .base import PassageNotFound, RawPassage, Translation


@dataclass(frozen=True)
class PassageVerse:
    verse: int
    text: str


@dataclass(frozen=True)
class Passage:
    reference_display: str
    body: str
    verses: tuple[PassageVerse, ...]
    word_count: int
    translation: Translation
    truncated: bool
    source: str


# Footnotes and cross-references are removed together with their content.
_HTML_NOTE = re.compile(r"<(sup|note|footnote|fn)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>")
_USFM_NOTE = re.compile(r"\\(f|fe|x|ef|ex)\s.*?\\\1\*", re.DOTALL)
# \w word|lemma="x" strong="G1"\w*  ->  word
_USFM_WORD = re.compile(r"\\\+?(w|wg|wh|wa)\s+([^|\\]*)(?:\|[^\\]*)?\\\+?\1\*")
_USFM_VERSE = re.compile(r"\\v\s+\d+[a-z]?(?:-\d+)?\s*")
_USFM_MARKER = re.compile(r"\\\+?[A-Za-z]+\d*\*?")
_WHITESPACE = re.compile(r"\s+")


def strip_markup(text: str) -> str:
    """Remove HTML, USFM, footnotes, cross-references, red-letter spans and paragraph markers,
    then collapse whitespace."""
    text = _HTML_COMMENT.sub(" ", text)
    text = _HTML_NOTE.sub(" ", text)
    text = _HTML_TAG.sub(" ", text)
    text = _USFM_NOTE.sub(" ", text)
    text = _USFM_WORD.sub(lambda m: m.group(2), text)
    text = _USFM_VERSE.sub(" ", text)
    text = _USFM_MARKER.sub(" ", text)
    text = html.unescape(text).replace("\u00b6", " ")
    return _WHITESPACE.sub(" ", text).strip()


def format_passage(
    raw: RawPassage,
    translation: Translation,
    *,
    source: str,
    max_verses: int | None = None,
) -> Passage:
    """Turn a provider's raw passage into the ``Passage`` shape.

    The book is spelled from the canon table, never taken from the provider. ``max_verses`` cuts
    the passage after that many verses and sets ``truncated``.
    """
    book = load_canon().by_osis(raw.book)
    if book is None:
        raise PassageNotFound(f"unknown book {raw.book!r}")

    cleaned = [PassageVerse(v.number, strip_markup(v.text)) for v in raw.verses]
    verses = [v for v in cleaned if v.text]
    if not verses:
        raise PassageNotFound(f"{book.name} {raw.chapter} has no text")
    truncated = max_verses is not None and len(verses) > max_verses
    if truncated:
        verses = verses[:max_verses]

    first, last = verses[0].verse, verses[-1].verse
    span = str(first) if first == last else f"{first}-{last}"
    reference = f"{book.name} {raw.chapter}:{span} ({translation.abbreviation})"
    body = " ".join(f"{v.verse} {v.text}" for v in verses)
    return Passage(
        reference_display=reference,
        body=body,
        verses=tuple(verses),
        word_count=len(body.split()),
        translation=translation,
        truncated=truncated,
        source=source,
    )


def to_verseflow_txt(passages: list[Passage]) -> str:
    """Render passages as a VerseFlow ``.txt`` file: reference line, body line, blank line."""
    return "".join(f"{p.reference_display}\n{p.body}\n\n" for p in passages)
