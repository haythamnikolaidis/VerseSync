"""Detection-stage types (docs/04-reference-detection.md section 3)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Token:
    """One normalised token with a back-reference to the words it came from."""

    text: str  # normalised surface; numbers render as digits, e.g. "28"
    kind: str  # 'word' | 'number' | 'ordinal' | 'punct'
    value: int | None  # numeric value when kind is number/ordinal
    word_ids: tuple[int, ...]  # indices into the Word array; never empty, ascending
    start: float  # seconds, from the first source word
    end: float  # seconds, from the last source word
    prob: float  # min probability across source words
