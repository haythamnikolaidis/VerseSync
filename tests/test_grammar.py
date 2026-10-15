"""Tests for the grammar: book pre-pass, grammar view and patterns (04 section 4)."""

from __future__ import annotations

import re

from versesync.detect.canon import load_canon
from versesync.detect.grammar import build_view, find_books
from versesync.detect.normalize import normalize
from versesync.detect.types import Token
from versesync.types import Word

CANON = load_canon()


def words(text: str, start: float = 0.0, prob: float = 1.0) -> list[Word]:
    """Words half a second apart. The normaliser drops a lone ':' or '-', so the spaces around
    a chapter/verse separator are closed up, as Whisper writes "3:16"."""
    glued = re.sub(r"(?<=\d) ([:\-]) (?=\d)", r"\1", text)
    return [
        Word(text=w, start=start + 0.5 * i, end=start + 0.5 * i + 0.4, probability=prob)
        for i, w in enumerate(glued.split())
    ]


def toks(text: str, start: float = 0.0) -> list[Token]:
    return normalize(words(text, start), CANON)


def test_prepass_finds_non_overlapping_books_left_to_right():
    tokens = toks("see romans 8 and first corinthians 6")
    matches = find_books(tokens, CANON)
    assert [(m.book.osis, m.first, m.last) for m in matches] == [
        ("Rom", 1, 1),
        ("1Cor", 4, 5),
    ]


def test_prepass_fuzzy_only_fires_when_a_number_follows():
    assert find_books(toks("she lost her jub"), CANON) == []
    assert [m.book.osis for m in find_books(toks("philippines 4"), CANON)] == ["Phil"]
    assert [m.book.osis for m in find_books(toks("philippines chapter 4"), CANON)] == ["Phil"]
    assert [m.book.osis for m in find_books(toks("philippines , verse 4"), CANON)] == ["Phil"]
    assert find_books(toks("philippines chapter of"), CANON) == []


def test_view_folds_each_book_into_one_token_and_maps_back():
    tokens = toks("read first corinthians 6:19-20 now")
    view = build_view(tokens, find_books(tokens, CANON))
    assert view.search.text == "read §b0 6 : 19 - 20 now"
    assert view.spans[1] == (1, 2)  # "1 corinthians" is token 1..2
    assert view.spans[2] == (3, 3)
    book = view.tokens[1]
    assert (book.start, book.end) == (tokens[1].start, tokens[2].end)
