"""Stage 2, the grammar (docs/04-reference-detection.md section 4).

A book pre-pass collapses every book name into one view token, the patterns run as regexes over
the search text of that view, and the first pattern to match a span consumes it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from versesync.detect.canon import Book, Canon
from versesync.detect.fuzzy import match_book
from versesync.detect.normalize import SearchText, build_search_text
from versesync.detect.types import BookMatch, Token


@dataclass(frozen=True)
class GrammarConfig:
    context_window_s: float = 120.0
    context_window_tokens: int = 400


@dataclass(frozen=True)
class Candidate:
    book: Book
    chapter: int
    verse: int | None
    verse_end: int | None
    pattern: str  # "P1".."P12"
    contextual: bool  # True only for P11/P12
    book_match: BookMatch  # for P11/P12: the match of the reference carried from
    token_span: tuple[int, int]  # inclusive, into normalize() tokens
    word_span: tuple[int, int]  # inclusive, into the Word array
    source_start: float  # start of the FIRST token of the match (04 section 7)
    source_end: float
    asr_prob: float  # mean Token.prob over token_span
    alternatives: tuple[Candidate, ...] = ()
    alternative_reason: str | None = None


# --- Book pre-pass and grammar view ----------------------------------------------------------

_BOOK_KIND = "book"
_VERSE_WORDS = frozenset({"verse", "verses"})


def _is_number(tokens: Sequence[Token], index: int) -> bool:
    return 0 <= index < len(tokens) and tokens[index].kind == "number"


def _number_follows(tokens: Sequence[Token], index: int) -> bool:
    """The gate for fuzzy book matching (docs/tasks/T-11-book-matching.md).

    True when ``tokens[index]`` is a number, or ``chapter``/``verse``/``verses`` followed by a
    number, or ``,`` followed by ``verse``/``verses`` and a number.
    """
    if not 0 <= index < len(tokens):
        return False
    token = tokens[index]
    if token.kind == "number":
        return True
    if token.text == "chapter" or token.text in _VERSE_WORDS:
        return _is_number(tokens, index + 1)
    if token.text == ",":
        following = index + 1
        return (
            following < len(tokens)
            and tokens[following].text in _VERSE_WORDS
            and _is_number(tokens, following + 1)
        )
    return False


def find_books(tokens: Sequence[Token], canon: Canon) -> list[BookMatch]:
    """Left-to-right book pre-pass; the matches never overlap."""

    def gate(index: int) -> bool:
        return _number_follows(tokens, index)

    matches: list[BookMatch] = []
    i = 0
    while i < len(tokens):
        match = match_book(tokens, i, canon, fuzzy_gate=gate)
        if match is None:
            i += 1
        else:
            matches.append(match)
            i = match.last + 1
    return matches


@dataclass(frozen=True)
class GrammarView:
    """The token stream with each book match folded into a single ``§b<k>`` token."""

    tokens: tuple[Token, ...]  # the view tokens
    spans: tuple[tuple[int, int], ...]  # view index -> inclusive (first, last) source token
    books: tuple[BookMatch, ...]  # book match k is the view token ``§b<k>``
    search: SearchText


def build_view(tokens: Sequence[Token], books: Sequence[BookMatch]) -> GrammarView:
    view: list[Token] = []
    spans: list[tuple[int, int]] = []
    by_first = {match.first: k for k, match in enumerate(books)}
    i = 0
    while i < len(tokens):
        k = by_first.get(i)
        if k is None:
            view.append(tokens[i])
            spans.append((i, i))
            i += 1
            continue
        first, last = books[k].first, books[k].last
        covered = tokens[first : last + 1]
        view.append(
            Token(
                text=f"§b{k}",
                kind=_BOOK_KIND,
                value=None,
                word_ids=tuple(sorted({covered[0].word_ids[0], covered[-1].word_ids[-1]})),
                start=covered[0].start,
                end=covered[-1].end,
                prob=min(t.prob for t in covered),
            )
        )
        spans.append((first, last))
        i = last + 1
    return GrammarView(
        tokens=tuple(view),
        spans=tuple(spans),
        books=tuple(books),
        search=build_search_text(view),
    )
