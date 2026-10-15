from __future__ import annotations

import re

import pytest

from versesync.bible.base import Passage, RawPassage, RawVerse, Translation
from versesync.bible.format import (
    format_passage,
    strip_markup,
    to_verseflow_block,
    word_count,
)
from versesync.detect.canon import load_canon
from versesync.types import Reference

KJV = Translation("kjv", "KJV", "King James Version", "Public domain.")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("<p>For God so <i>loved</i> the world</p>", "For God so loved the world"),
        ("For God\\f + \\fr 3:16 \\ft note\\f* so loved", "For God so loved"),
        ("see\\x - \\xo 3:16 \\xt Rom 5:8\\x* this", "see this"),
        ("\\wj Verily\\wj* I say \\add unto\\add* you", "Verily I say unto you"),
        ("\\p \\v 16 For God", "For God"),
        ("Jesus said<sup>a</sup>, Follow me", "Jesus said, Follow me"),
        ('Peace<sup class="footnote">1 Or shalom</sup> be', "Peace be"),
        ('<span class="wj">Follow me</span>', "Follow me"),
        ("\u00b6 In the beginning\u00b6  God", "In the beginning God"),
        ("  a\n\t b   c  ", "a b c"),
        ("fish &amp; bread", "fish & bread"),
    ],
)
def test_strip_markup(raw: str, expected: str) -> None:
    assert strip_markup(raw) == expected


def test_word_count_matches_verseflow() -> None:
    assert word_count("") == 0
    assert word_count("   ") == 0
    assert word_count("16 For God  so\nloved") == 5


def _passage(
    book: str, osis: str, ch: int, v: int, end: int | None, texts: list[str], max_verses: int = 6
) -> Passage:
    ref = Reference(book, osis, ch, v, end)
    verses = tuple(RawVerse(v + i, t) for i, t in enumerate(texts))
    raw = RawPassage("local", "kjv", ref, verses, "{}")
    return format_passage(raw, KJV, load_canon(), max_verses=max_verses, source="local")


def test_format_passage_truncates_and_keeps_numbers() -> None:
    texts = [f"<p>text {i}</p>" for i in range(10)]
    p = _passage("Psalms", "Ps", 23, 1, 10, texts)
    assert p.truncated is True
    assert len(p.verses) == 6
    assert p.body.startswith("1 text 0 2 text 1")
    assert p.word_count == 18
    assert p.verses[0].text == "text 0"
    assert p.source == "local"


# Copied from reference/verseflow/js/scripture-parser.js (REFERENCE_RE).
VERSEFLOW_REFERENCE_RE = re.compile(
    r"^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$"
)


def _parse_block(text: str) -> tuple[str, str, str]:
    """Port of parseScriptures for a single entry: (reference, translation, body)."""
    lines = [ln.strip() for ln in re.split(r"\r?\n", text)]
    m = VERSEFLOW_REFERENCE_RE.match(lines[0])
    assert m is not None
    body = re.sub(r"\s+", " ", " ".join(ln for ln in lines[1:] if ln)).strip()
    return lines[0], m.group(2), body


@pytest.mark.parametrize(
    ("args", "reference", "body"),
    [
        (
            ("John", "John", 3, 16, None, ["For God so loved the world."]),
            "John 3:16 (KJV)",
            "16 For God so loved the world.",
        ),
        (
            ("John", "John", 3, 16, 17, ["For God so loved", "For God sent not"]),
            "John 3:16-17 (KJV)",
            "16 For God so loved 17 For God sent not",
        ),
        (
            ("1 Corinthians", "1Cor", 6, 19, 20, ["What? know ye not", "For ye are <i>bought</i>"]),
            "1 Corinthians 6:19-20 (KJV)",
            "19 What? know ye not 20 For ye are bought",
        ),
    ],
)
def test_round_trip_through_verseflow_parser(
    args: tuple[str, str, int, int, int | None, list[str]], reference: str, body: str
) -> None:
    p = _passage(*args)
    block = to_verseflow_block(p)
    parsed_ref, translation, parsed_body = _parse_block(block)
    assert parsed_ref == p.reference_display == reference
    assert translation == "KJV"
    assert parsed_body == p.body == body


def test_ranges_use_hyphen_never_en_dash() -> None:
    p = _passage("1 Corinthians", "1Cor", 6, 19, 20, ["a", "b"])
    assert "-" in p.reference_display
    assert "\u2013" not in p.reference_display
    assert "\u2013" not in to_verseflow_block(p)
