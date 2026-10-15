"""Stage 2, the grammar (docs/04-reference-detection.md section 4).

A book pre-pass collapses every book name into one view token, the patterns run as regexes over
the search text of that view, and the first pattern to match a span consumes it.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import NamedTuple

from versesync.detect.canon import Book, Canon
from versesync.detect.fuzzy import match_book
from versesync.detect.normalize import SearchText, build_search_text, seconds, word_span
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


# --- Pattern registry --------------------------------------------------------------------------


class Fields(NamedTuple):
    """What a pattern's builder reads out of a match."""

    chapter: int
    verse: int | None
    verse_end: int | None


@dataclass(frozen=True)
class Pattern:
    name: str
    regex: re.Pattern[str]
    build: Callable[[re.Match[str]], Fields]


def _compile(body: str) -> re.Pattern[str]:
    # Whole-token boundaries: a pattern may not start or stop inside a token's text.
    return re.compile(rf"(?<!\S){body}(?!\S)")


def _int(match: re.Match[str], group: str) -> int:
    return int(match.group(group))


_BOOK = r"§b(?P<b>\d+)"
_RANGE = r"(?:through|to|-|and)"  # the connectives of a verse range (04 section 4, P3)

# The registry is the priority order: the first pattern to match a span wins it (04 section 4).
PATTERNS: tuple[Pattern, ...] = (
    Pattern(
        "P1",
        _compile(rf"{_BOOK} (?P<c>\d+) : (?P<v>\d+) - (?P<ve>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), _int(m, "ve")),
    ),
    Pattern(
        "P2",
        _compile(rf"{_BOOK} (?P<c>\d+) : (?P<v>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), None),
    ),
    Pattern(
        "P3",
        _compile(rf"{_BOOK} chapter (?P<c>\d+) verses? (?P<v>\d+) {_RANGE} (?P<ve>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), _int(m, "ve")),
    ),
    Pattern(
        "P4",
        _compile(rf"{_BOOK} chapter (?P<c>\d+) verses? (?P<v>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), None),
    ),
    Pattern(
        "P5",
        _compile(rf"{_BOOK} chapter (?P<c>\d+)"),
        lambda m: Fields(_int(m, "c"), None, None),
    ),
    Pattern(
        "P6",
        _compile(rf"{_BOOK} (?P<c>\d+) , (?P<v>\d+) (?:and|through|to) (?P<ve>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), _int(m, "ve")),
    ),
    Pattern(
        "P7",
        _compile(rf"{_BOOK} (?P<c>\d+) , (?P<v>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), None),
    ),
    # Always the split reading "ch v". The Psalms concatenation rule (04 section 3.1) is T-12.4.
    Pattern(
        "P8",
        _compile(rf"{_BOOK} (?P<c>\d+) (?P<v>\d+)"),
        lambda m: Fields(_int(m, "c"), _int(m, "v"), None),
    ),
    Pattern(
        "P9",
        _compile(rf"{_BOOK} (?P<c>\d+)"),
        lambda m: Fields(_int(m, "c"), None, None),
    ),
)


def _consumed(flags: Sequence[bool], first: int, last: int) -> bool:
    return any(flags[first : last + 1])


def find_candidates(
    tokens: Sequence[Token], canon: Canon, cfg: GrammarConfig = GrammarConfig()
) -> list[Candidate]:
    """Every reference the grammar finds, sorted by ``source_start``.

    The grammar does no canon validation; that is stage 3's job (docs/04 section 5).
    """
    del cfg  # the context window applies to P11/P12 only
    view = build_view(tokens, find_books(tokens, canon))
    consumed = [False] * len(view.tokens)
    out: list[Candidate] = []
    text = view.search.text
    for pattern in PATTERNS:
        pos = 0
        while True:
            match = pattern.regex.search(text, pos)
            if match is None:
                break
            v_first, v_last = view.search.token_span(*match.span())
            if _consumed(consumed, v_first, v_last):
                # Retry one character on: a later, non-overlapping match may still exist.
                pos = match.start() + 1
                continue
            for k in range(v_first, v_last + 1):
                consumed[k] = True
            out.append(_candidate(pattern, match, view, tokens, (v_first, v_last)))
            pos = match.end()
    out.sort(key=lambda c: (c.source_start, c.token_span))
    return out


def _candidate(
    pattern: Pattern,
    match: re.Match[str],
    view: GrammarView,
    tokens: Sequence[Token],
    view_span: tuple[int, int],
) -> Candidate:
    first = view.spans[view_span[0]][0]
    last = view.spans[view_span[1]][1]
    book_match = view.books[int(match.group("b"))]
    fields = pattern.build(match)
    start, end = seconds(tokens, first, last)
    covered = tokens[first : last + 1]
    return Candidate(
        book=book_match.book,
        chapter=fields.chapter,
        verse=fields.verse,
        verse_end=fields.verse_end,
        pattern=pattern.name,
        contextual=False,
        book_match=book_match,
        token_span=(first, last),
        word_span=word_span(tokens, first, last),
        source_start=start,
        source_end=end,
        asr_prob=sum(t.prob for t in covered) / len(covered),
    )
