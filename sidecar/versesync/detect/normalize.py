"""Normalisation pass: ``Word`` array to ``Token`` array (docs/04 section 3).

Every token keeps ``word_ids`` back into the source ``Word`` array, which is how a regex match
over the search string is turned back into timestamps.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass

from versesync.detect.canon import Canon
from versesync.detect.numbers import parse_cardinal, parse_ordinal
from versesync.detect.types import Token
from versesync.types import Word

# A word's text is split into pieces; each piece is (text, is_punct, source word index).
_Piece = tuple[str, bool, int]

_EDGES = re.compile(r"([\W_]*)(.*?)([\W_]*)", re.DOTALL)
_DIGIT_JOINER = re.compile(r"(?<=\d)([:\-])(?=\d)")
_DROP = re.compile(r"[^\w:\-]|_")
_ROMAN = frozenset({"i", "ii", "iii"})
# Rule 4 applies to the bare units 1..3 only: the highest numbered-book prefix is "3 John".
_MAX_BOOK_PREFIX = 3


def _pieces(text: str, index: int) -> list[_Piece]:
    """Rule 1: lowercase, split into core and punctuation, keep structural punctuation."""
    lowered = text.lower().strip()
    match = _EDGES.fullmatch(lowered)
    assert match is not None  # the pattern accepts any string
    lead, core, trail = match.groups()
    # A word with no letters or digits at all (",") has everything in `lead`.
    comma = "," in (trail if core else lead + trail)

    out: list[_Piece] = []
    cleaned = _DROP.sub("", core)
    for part in _DIGIT_JOINER.split(cleaned):
        if part in (":", "-") and out:
            out.append((part, True, index))
            continue
        # Stray structural characters not between digits are dropped; internal hyphens of
        # spelled-out numerals ("twenty-eight") are kept for parse_cardinal.
        part = part.replace(":", "").strip("-")
        if part:
            out.append((part, False, index))
    if comma:
        out.append((",", True, index))
    return out


def normalize(words: Sequence[Word], canon: Canon) -> list[Token]:
    """Turn ``words`` into normalised tokens, keeping the link back to each source word."""
    pieces: list[_Piece] = []
    for i, word in enumerate(words):
        pieces.extend(_pieces(word.text, i))
    texts = [p[0] if not p[1] else "" for p in pieces]
    bases = canon.numbered_bases()

    tokens: list[Token] = []
    j = 0
    while j < len(pieces):
        text, is_punct, _ = pieces[j]
        if is_punct:
            tokens.append(_make(words, text, "punct", None, [pieces[j][2]]))
            j += 1
            continue
        before_base = j + 1 < len(texts) and texts[j + 1] in bases
        # Rule 3. Roman numerals are book prefixes only, so "I have" stays a word.
        ordinal = parse_ordinal(texts, j)
        if ordinal is not None and (text not in _ROMAN or before_base):
            value, used = ordinal
            ids = [p[2] for p in pieces[j : j + used]]
            tokens.append(_make(words, str(value), "ordinal", value, ids))
            j += used
            continue
        card = parse_cardinal(texts, j)
        if card is not None:
            value, used = card
            ids = [p[2] for p in pieces[j : j + used]]
            # Rule 4: "one corinthians" is the book, not chapter 1.
            is_prefix = used == 1 and value <= _MAX_BOOK_PREFIX and before_base
            kind = "ordinal" if is_prefix else "number"
            tokens.append(_make(words, str(value), kind, value, ids))
            j += used
            continue
        tokens.append(_make(words, text, "word", None, [pieces[j][2]]))
        j += 1
    return tokens


def _make(words: Sequence[Word], text: str, kind: str, value: int | None, ids: list[int]) -> Token:
    word_ids = tuple(sorted(set(ids)))
    return Token(
        text=text,
        kind=kind,
        value=value,
        word_ids=word_ids,
        start=words[word_ids[0]].start,
        end=words[word_ids[-1]].end,
        prob=min(words[i].probability for i in word_ids),
    )


@dataclass(frozen=True)
class SearchText:
    """Token texts joined by single spaces, plus the map from characters back to tokens."""

    text: str  # token texts joined by single spaces
    starts: tuple[int, ...]  # sorted start offset of each token within ``text``

    def token_at(self, char_offset: int) -> int:
        """Index of the token containing ``char_offset``; a space maps to the token before it."""
        if not 0 <= char_offset < len(self.text):
            raise IndexError(f"char offset {char_offset} outside search text")
        return bisect_right(self.starts, char_offset) - 1

    def token_span(self, char_start: int, char_end: int) -> tuple[int, int]:
        """Inclusive ``[first, last]`` token span of a regex match span.

        ``char_end`` is exclusive, as in ``re.Match.span()``; the match must be non-empty.
        """
        if char_end <= char_start:
            raise ValueError("empty character span")
        return self.token_at(char_start), self.token_at(char_end - 1)


def build_search_text(tokens: Sequence[Token]) -> SearchText:
    """Join token texts with single spaces and record where each token starts."""
    starts: list[int] = []
    pos = 0
    for token in tokens:
        starts.append(pos)
        pos += len(token.text) + 1
    return SearchText(text=" ".join(t.text for t in tokens), starts=tuple(starts))


def word_span(tokens: Sequence[Token], first: int, last: int) -> tuple[int, int]:
    """Inclusive ``Word`` index span covered by tokens ``first..last`` (inclusive)."""
    return tokens[first].word_ids[0], tokens[last].word_ids[-1]


def seconds(tokens: Sequence[Token], first: int, last: int) -> tuple[float, float]:
    """Source ``(start, end)`` seconds covered by tokens ``first..last`` (inclusive)."""
    return tokens[first].start, tokens[last].end
