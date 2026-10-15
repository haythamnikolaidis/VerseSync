"""Book-name matching (docs/04-reference-detection.md section 4.1)."""

from __future__ import annotations

import functools
import json
from collections.abc import Callable, Sequence
from pathlib import Path

from versesync.detect.canon import Canon
from versesync.detect.types import BookMatch, Token

# Short, high-frequency English words that are also book names: tier 1 (exact) only.
SHORT_BOOKS = frozenset({"job", "mark", "acts", "numbers", "judges", "ruth", "james", "amos"})

_CONFUSIONS_PATH = Path(__file__).resolve().parent / "data" / "confusions.json"


@functools.cache
def _load_confusions() -> dict[str, str]:
    """Tier 2 table: normalised heard form -> OSIS id (04 section 4.1)."""
    with _CONFUSIONS_PATH.open("r", encoding="utf-8") as f:
        table: dict[str, str] = json.load(f)
    return table


# Only words and ordinal prefixes can be part of a book name; numbers and punctuation end it.
_NAME_KINDS = frozenset({"word", "ordinal"})


def _is_name_window(window: Sequence[Token]) -> bool:
    # Abbreviated forms ("1 sa", "2 co") are not tagged as ordinals by the normaliser, which only
    # does so before a full base name, so a leading number token may open a name. Only the first
    # token may be a number; the alias lookup rejects values that are not real book prefixes.
    for k, token in enumerate(window):
        if token.kind in _NAME_KINDS or (k == 0 and token.kind == "number" and len(window) > 1):
            continue
        return False
    return True


def match_book(
    tokens: Sequence[Token],
    i: int,
    canon: Canon,
    *,
    fuzzy_gate: Callable[[int], bool] | None = None,
) -> BookMatch | None:
    """Longest match starting at token i. An ordinal token at i followed by a numbered-book base
    is consumed as part of the book ("1 corinthians")."""
    if i < 0 or i >= len(tokens):
        return None
    for n in range(min(canon.max_alias_tokens(), len(tokens) - i), 0, -1):
        window = tokens[i : i + n]
        if not _is_name_window(window):
            continue
        book = canon.lookup(" ".join(t.text for t in window))
        if book is not None:
            return BookMatch(book=book, tier="exact", distance=0, first=i, last=i + n - 1)
    # Tier 2 is only safe behind the number-follows gate; without a gate, tier 1 only.
    if fuzzy_gate is None:
        return None
    table = _load_confusions()
    longest = max(len(key.split()) for key in table)
    for n in range(min(longest, len(tokens) - i), 0, -1):
        window = tokens[i : i + n]
        if not _is_name_window(window):
            continue
        osis = table.get(" ".join(t.text for t in window))
        if osis is not None and fuzzy_gate(i + n):
            return BookMatch(
                book=canon.by_osis(osis), tier="alias", distance=0, first=i, last=i + n - 1
            )
    return None
