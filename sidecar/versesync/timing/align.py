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


@dataclass(frozen=True)
class Alignment:
    """Outcome of aligning a resolved passage against the transcript (05 section 4.2)."""

    classification: str  # 'read' | 'paraphrase' (the schema enum values)
    coverage: float
    read_start_s: float | None
    read_end_s: float | None
    read_word_span: tuple[int, int] | None  # inclusive word indices, for the panel's underline


@dataclass(frozen=True)
class _Run:
    matched: int
    first_match: int | None
    last_match: int | None


def align_from(
    verse: Sequence[str],
    window: Sequence[AToken],
    start_j: int,
    cfg: AlignConfig = AlignConfig(),
) -> _Run:
    """Monotonic greedy alignment of ``verse`` tokens against ``window`` from ``start_j``.

    A run of more than ``cfg.max_skip`` consecutive misses means the speaker skipped a verse
    word, so the verse pointer advances (05 section 4.1).
    """
    i = 0
    j = start_j
    matched = 0
    misses = 0
    first_match: int | None = None
    last_match: int | None = None
    while i < len(verse) and j < len(window):
        if tokens_equal(window[j].text, verse[i], cfg):
            if first_match is None:
                first_match = j
            last_match = j
            matched += 1
            i += 1
            j += 1
            misses = 0
        else:
            j += 1
            misses += 1
            if misses > cfg.max_skip:
                i += 1
                misses = 0
    return _Run(matched, first_match, last_match)


def _best_run(verse: Sequence[str], window: Sequence[AToken], cfg: AlignConfig) -> _Run | None:
    """Best run over the first ``k_starts`` positions matching ``V[0]`` or ``V[1]``.

    Ties on coverage keep the earliest start, because only a strictly better run replaces
    the incumbent.
    """
    openers = verse[:2]
    best: _Run | None = None
    tried = 0
    for j, token in enumerate(window):
        if tried >= cfg.k_starts:
            break
        if not any(tokens_equal(token.text, opener, cfg) for opener in openers):
            continue
        tried += 1
        run = align_from(verse, window, j, cfg)
        if best is None or run.matched > best.matched:
            best = run
    return best


def align(
    verse_texts: Sequence[str],
    words: Sequence[Word],
    mention_word_index: int,
    cfg: AlignConfig = AlignConfig(),
) -> Alignment:
    """Classify a cue as read or paraphrase and locate the reading in the transcript.

    ``coverage`` is always reported. An empty verse (unresolved passage) or a window with no
    candidate start yields a paraphrase with coverage 0.0 (05 section 4.3).
    """
    verse = normalise_verse(verse_texts)
    tokens = transcript_tokens(words)
    if not verse or not tokens:
        return Alignment("paraphrase", 0.0, None, None, None)

    # First transcript token at or after the mention word (tokens are in word order).
    m = len(tokens)
    for index, token in enumerate(tokens):
        if token.word_index >= mention_word_index:
            m = index
            break
    lo, hi = window_bounds(m, len(verse), len(tokens), cfg)
    window = tokens[lo:hi]

    best = _best_run(verse, window, cfg)
    if best is None or best.first_match is None or best.last_match is None:
        return Alignment("paraphrase", 0.0, None, None, None)

    coverage = best.matched / len(verse)
    if coverage < cfg.read_coverage_threshold:
        return Alignment("paraphrase", coverage, None, None, None)
    first = window[best.first_match]
    last = window[best.last_match]
    return Alignment("read", coverage, first.start, last.end, (first.word_index, last.word_index))
