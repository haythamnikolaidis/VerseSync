"""Stage 2, the grammar (docs/04-reference-detection.md section 4).

A book pre-pass collapses every book name into one view token, the patterns run as regexes over
the search text of that view, and the first pattern to match a span consumes it.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
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
    # The split reading "ch v"; for Psalms find_candidates applies the concatenation rule
    # (04 section 3.1) on top of it.
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
    # "the third chapter of john , verse 16". The ordinal token's text is its value in digits,
    # and any ordinal prefix of the book is already folded into the book token.
    Pattern(
        "P10",
        _compile(rf"the (?P<c>\d+) chapter of {_BOOK}(?: , verses? (?P<v>\d+))?"),
        lambda m: Fields(
            _int(m, "c"), int(m.group("v")) if m.group("v") is not None else None, None
        ),
    ),
)


@dataclass(frozen=True)
class ContextPattern:
    """A bare verse fragment (P11, P12); the book and chapter come from an earlier reference."""

    name: str
    regex: re.Pattern[str]
    build: Callable[[re.Match[str]], tuple[int, int | None]]  # (verse, verse_end)


# Tried after every full pattern, so a fragment inside a full reference is already consumed.
CONTEXT_PATTERNS: tuple[ContextPattern, ...] = (
    ContextPattern(
        "P11",
        _compile(rf"verses? (?P<v>\d+) {_RANGE} (?P<ve>\d+)"),
        lambda m: (_int(m, "v"), _int(m, "ve")),
    ),
    ContextPattern(
        "P12",
        _compile(r"verse (?P<v>\d+)"),
        lambda m: (_int(m, "v"), None),
    ),
)


_PSALMS = "Ps"
_PSALMS_SPLIT_REASON = "Split chapter:verse reading — 'Psalm N N' is ambiguous"


def _psalms_readings(canon: Canon, book: Book, split: Fields) -> tuple[Fields, Fields | None]:
    """The Psalms rule for P8 (docs/04 section 3.1): "psalm one nineteen" is 119, not 1:19.

    ``split`` is the plain "chapter verse" reading. When the two numbers also concatenate to a
    valid chapter and the split reading is valid too, the concatenation is the primary
    (chapter-only) reading and the split reading is its alternative. When only one reading is
    valid, only that one is returned. When neither is, the split reading stays as the P8 default
    and stage 3 rejects it.
    """
    assert split.verse is not None
    joined = int(f"{split.chapter}{split.verse}")
    concatenated = Fields(joined, None, None)
    joined_valid = canon.verse_count(book, joined) is not None
    verses = canon.verse_count(book, split.chapter)
    split_valid = verses is not None and 1 <= split.verse <= verses
    if joined_valid and split_valid:
        return concatenated, split
    if joined_valid:
        return concatenated, None
    return split, None


def _consumed(flags: Sequence[bool], first: int, last: int) -> bool:
    return any(flags[first : last + 1])


def _scan(
    regex: re.Pattern[str], view: GrammarView, consumed: list[bool]
) -> list[tuple[re.Match[str], tuple[int, int]]]:
    """Every match of ``regex`` that overlaps no consumed view token; marks them consumed."""
    found: list[tuple[re.Match[str], tuple[int, int]]] = []
    text = view.search.text
    pos = 0
    while True:
        match = regex.search(text, pos)
        if match is None:
            return found
        v_first, v_last = view.search.token_span(*match.span())
        if _consumed(consumed, v_first, v_last):
            # Retry one character on: a later, non-overlapping match may still exist.
            pos = match.start() + 1
            continue
        for k in range(v_first, v_last + 1):
            consumed[k] = True
        found.append((match, (v_first, v_last)))
        pos = match.end()


def find_candidates(
    tokens: Sequence[Token], canon: Canon, cfg: GrammarConfig = GrammarConfig()
) -> list[Candidate]:
    """Every reference the grammar finds, sorted by ``source_start``.

    The grammar does no canon validation; that is stage 3's job (docs/04 section 5).
    """
    view = build_view(tokens, find_books(tokens, canon))
    consumed = [False] * len(view.tokens)
    out: list[Candidate] = []
    for pattern in PATTERNS:
        for match, view_span in _scan(pattern.regex, view, consumed):
            book_match = view.books[int(match.group("b"))]
            fields = pattern.build(match)
            alternative: Fields | None = None
            if pattern.name == "P8" and book_match.book.osis == _PSALMS:
                fields, alternative = _psalms_readings(canon, book_match.book, fields)
            candidate = _candidate(
                tokens, view, view_span, pattern.name, book_match, fields, contextual=False
            )
            if alternative is not None:
                split = _candidate(
                    tokens, view, view_span, pattern.name, book_match, alternative, contextual=False
                )
                candidate = replace(
                    candidate,
                    alternatives=(split,),
                    alternative_reason=_PSALMS_SPLIT_REASON,
                )
            out.append(candidate)
    full = sorted(out, key=lambda c: c.token_span)
    for ctx in CONTEXT_PATTERNS:
        for match, view_span in _scan(ctx.regex, view, consumed):
            first = view.spans[view_span[0]][0]
            source = _carry_source(full, tokens, first, cfg)
            if source is None:
                continue  # outside the context window: the fragment is discarded
            verse, verse_end = ctx.build(match)
            out.append(
                _candidate(
                    tokens,
                    view,
                    view_span,
                    ctx.name,
                    source.book_match,
                    Fields(source.chapter, verse, verse_end),
                    contextual=True,
                )
            )
    out.sort(key=lambda c: (c.source_start, c.token_span))
    return out


def _carry_source(
    full: Sequence[Candidate], tokens: Sequence[Token], first: int, cfg: GrammarConfig
) -> Candidate | None:
    """The most recent full reference before token ``first``, if it is inside the window.

    The window is "120 seconds or 400 tokens, whichever is shorter" (docs/04 section 4), so both
    bounds must hold. Only the most recent reference is considered: if it is out of range, an
    earlier one is further out still, and carrying from it would attach to the wrong passage.
    """
    previous = [c for c in full if c.token_span[1] < first]
    if not previous:
        return None
    source = max(previous, key=lambda c: c.token_span[1])
    if tokens[first].start - source.source_end > cfg.context_window_s:
        return None
    if first - source.token_span[1] > cfg.context_window_tokens:
        return None
    return source


def _candidate(
    tokens: Sequence[Token],
    view: GrammarView,
    view_span: tuple[int, int],
    pattern: str,
    book_match: BookMatch,
    fields: Fields,
    *,
    contextual: bool,
) -> Candidate:
    first = view.spans[view_span[0]][0]
    last = view.spans[view_span[1]][1]
    start, end = seconds(tokens, first, last)
    covered = tokens[first : last + 1]
    return Candidate(
        book=book_match.book,
        chapter=fields.chapter,
        verse=fields.verse,
        verse_end=fields.verse_end,
        pattern=pattern,
        contextual=contextual,
        book_match=book_match,
        token_span=(first, last),
        word_span=word_span(tokens, first, last),
        source_start=start,
        source_end=end,
        # fsum, not sum: sum() of floats rounds differently before Python 3.12, and the golden
        # files are compared byte for byte on every supported version.
        asr_prob=math.fsum(t.prob for t in covered) / len(covered),
    )
