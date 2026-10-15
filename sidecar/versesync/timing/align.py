"""Read-span alignment: normalisation, window and token equality (05 section 4.1)."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

import jellyfish

from versesync.types import Word


@dataclass(frozen=True)
class AlignConfig:
    read_coverage_threshold: float = 0.55
    max_skip: int = 6
    k_starts: int = 12
    fuzzy_min_len: int = 5  # Levenshtein <= 1 only for tokens of length >= 5
    lookbehind_mult: float = 0.6
    lookbehind_add: int = 20
    lookahead_mult: float = 1.8
    lookahead_add: int = 30


STOP_WORDS = frozenset({"the", "a", "an", "and", "of", "to", "in", "that"})

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class AToken:
    """Alignment token over the transcript."""

    text: str
    word_index: int
    start: float
    end: float


def _normalise_word(raw: str) -> str | None:
    """Lowercase and strip punctuation; None if the word is dropped.

    Drops stop words and digit-only tokens (verse numbers). Applied identically to the
    verse side and the transcript side (05 section 4.1).
    """
    text = _NON_ALNUM.sub("", raw.lower())
    if not text or text.isdigit() or text in STOP_WORDS:
        return None
    return text


def normalise_verse(verse_texts: Sequence[str]) -> list[str]:
    """Normalised content tokens of the resolved verse text."""
    tokens: list[str] = []
    for verse in verse_texts:
        for raw in verse.split():
            text = _normalise_word(raw)
            if text is not None:
                tokens.append(text)
    return tokens


def transcript_tokens(words: Sequence[Word]) -> list[AToken]:
    """Normalised transcript tokens, each keeping its source word index."""
    tokens: list[AToken] = []
    for index, word in enumerate(words):
        text = _normalise_word(word.text)
        if text is not None:
            tokens.append(AToken(text, index, word.start, word.end))
    return tokens


def window_bounds(
    m: int, n_verse_tokens: int, n_tokens: int, cfg: AlignConfig = AlignConfig()
) -> tuple[int, int]:
    """Half-open ``(lo, hi)`` token window around mention token ``m``, clamped to the transcript.

    The window is ``T[m - (0.6|V| + 20) .. m + (1.8|V| + 30)]`` with ``hi`` exclusive
    (05 section 4.1); fractional bounds are floored.
    """
    behind = int(cfg.lookbehind_mult * n_verse_tokens + cfg.lookbehind_add)
    ahead = int(cfg.lookahead_mult * n_verse_tokens + cfg.lookahead_add)
    lo = min(max(0, m - behind), n_tokens)
    hi = max(lo, min(n_tokens, m + ahead + 1))
    return lo, hi


def tokens_equal(a: str, b: str, cfg: AlignConfig = AlignConfig()) -> bool:
    """Exact match, or Levenshtein distance <= 1 when both tokens are long enough."""
    if a == b:
        return True
    if len(a) < cfg.fuzzy_min_len or len(b) < cfg.fuzzy_min_len:
        return False
    return bool(jellyfish.levenshtein_distance(a, b) <= 1)
