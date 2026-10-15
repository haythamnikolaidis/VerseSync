"""VerseFlow-compatible passage formatting (06 section 2)."""

from __future__ import annotations

import html
import re

from versesync.bible.base import Passage, RawPassage, RawVerse, Translation
from versesync.detect.canon import Canon

# USFM footnotes and cross-references: drop the marker pair and everything between them.
_USFM_NOTE = re.compile(r"\\(f|fe|x)\b.*?\\\1\*", re.DOTALL)
# Remaining USFM character and paragraph markers (\wj, \wj*, \add*, \p, \q1, \v 3 ...).
_USFM_MARKER = re.compile(r"\\\+?[a-z][a-z0-9]*\*?(?:\s+\d+[a-z]?(?=\s))?")
# HTML elements that carry a footnote, cross-reference or note body.
_HTML_NOTE = re.compile(
    r"<(sup|span|a|note|div)\b[^>]*\b(?:class|type)=[\"'][^\"']*"
    r"(?:foot|xref|crossref|cross-ref|note)[^\"']*[\"'][^>]*>.*?</\1\s*>",
    re.DOTALL | re.IGNORECASE,
)
# A lone superscript callout such as <sup>a</sup> or <sup>[12]</sup>.
_HTML_CALLOUT = re.compile(r"<sup\b[^>]*>\s*\[?[A-Za-z0-9*\u2020\u2021]{1,3}\]?\s*</sup>", re.I)
_HTML_TAG = re.compile(r"<[^>]*>")
_WHITESPACE = re.compile(r"\s+")
# Pilcrow paragraph marks and the stray bracketed callouts some providers leave behind.
_PILCROW = re.compile("[\u00b6\u2761]")


def strip_markup(text: str) -> str:
    """Remove provider markup and collapse whitespace; the result has no verse number."""
    text = _USFM_NOTE.sub(" ", text)
    text = _HTML_NOTE.sub(" ", text)
    text = _HTML_CALLOUT.sub("", text)
    text = _HTML_TAG.sub(" ", text)
    text = _USFM_MARKER.sub(" ", text)
    text = html.unescape(text)
    text = _PILCROW.sub(" ", text)
    text = _WHITESPACE.sub(" ", text).strip()
    # Tags replaced by a space can leave a gap before punctuation ("word ,").
    return re.sub(r"\s+([,.;:!?])", r"\1", text)


def word_count(body: str) -> int:
    """VerseFlow's rule (``_finalize`` in scripture-parser.js): whitespace-split, empty is 0."""
    collapsed = _WHITESPACE.sub(" ", body).strip()
    return 0 if collapsed == "" else len(collapsed.split(" "))


def format_passage(
    raw: RawPassage,
    translation: Translation,
    canon: Canon,
    *,
    max_verses: int = 6,
    source: str = "provider",
) -> Passage:
    """Build the 06 section 1 ``Passage``: canon reference, numbered body, truncation."""
    truncated = len(raw.verses) > max_verses
    kept = raw.verses[:max_verses]
    verses = tuple(RawVerse(v.verse, strip_markup(v.text)) for v in kept)
    body = _WHITESPACE.sub(" ", " ".join(f"{v.verse} {v.text}" for v in verses)).strip()
    display = f"{raw.reference.display(canon)} ({translation.abbreviation})"
    return Passage(
        reference=raw.reference,
        reference_display=display,
        body=body,
        verses=verses,
        word_count=word_count(body),
        translation=translation,
        truncated=truncated,
        source=source,
    )


def to_verseflow_block(p: Passage) -> str:
    """One block of VerseFlow's ``.txt`` format: reference line, then the body line."""
    return f"{p.reference_display}\n{p.body}\n"
