"""Normalisation pass: ``Word`` array to ``Token`` array (docs/04 section 3).

Every token keeps ``word_ids`` back into the source ``Word`` array, which is how a regex match
over the search string is turned back into timestamps.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from versesync.detect.canon import Canon
from versesync.detect.numbers import parse_cardinal
from versesync.detect.types import Token
from versesync.types import Word

# A word's text is split into pieces; each piece is (text, is_punct, source word index).
_Piece = tuple[str, bool, int]

_EDGES = re.compile(r"([\W_]*)(.*?)([\W_]*)", re.DOTALL)
_DIGIT_JOINER = re.compile(r"(?<=\d)([:\-])(?=\d)")
_DROP = re.compile(r"[^\w:\-]|_")


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

    tokens: list[Token] = []
    j = 0
    while j < len(pieces):
        text, is_punct, _ = pieces[j]
        if is_punct:
            tokens.append(_make(words, text, "punct", None, [pieces[j][2]]))
            j += 1
            continue
        card = parse_cardinal(texts, j)
        if card is not None:
            value, used = card
            ids = [p[2] for p in pieces[j : j + used]]
            tokens.append(_make(words, str(value), "number", value, ids))
            j += used
            continue
        tokens.append(_make(words, text, "word", None, [pieces[j][2]]))
        j += 1
    return tokens


def _make(
    words: Sequence[Word], text: str, kind: str, value: int | None, ids: list[int]
) -> Token:
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
