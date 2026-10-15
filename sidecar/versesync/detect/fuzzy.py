"""Book-name matching (docs/04-reference-detection.md section 4.1)."""

from __future__ import annotations

import functools
import json
from collections.abc import Callable, Sequence
from pathlib import Path

import jellyfish

from versesync.detect.canon import Canon, normalise_alias
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


# Tier 3 never compares strings shorter than this. Abbreviations such as "ps" or "is" sit within
# distance 1 of ordinary words ("as", "his"), so fuzzy matching them would be pure noise. The
# spec leaves this floor unstated; 5 also keeps "judge" away from Jude and "like" from Luke.
_MIN_FUZZY_LENGTH = 5


def _max_distance(text: str) -> int:
    """Spec 04 section 4.1 tier 3: 2 edits for length >= 6, otherwise 1."""
    return 2 if len(text) >= 6 else 1


@functools.cache
def _fuzzy_candidates(canon: Canon) -> tuple[tuple[str, str], ...]:
    """(normalised canonical name or alias, OSIS id) pairs, in canon order, minus short books."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for book in canon.books:
        if book.name.lower() in SHORT_BOOKS:
            continue
        for alias in (book.name, book.display_name, *book.aliases):
            key = normalise_alias(alias)
            if key in seen or len(key) < _MIN_FUZZY_LENGTH:
                continue
            seen.add(key)
            out.append((key, book.osis))
    return tuple(out)


def _fuzzy_match(
    tokens: Sequence[Token], i: int, canon: Canon, fuzzy_gate: Callable[[int], bool]
) -> BookMatch | None:
    """Tier 3: edit distance against names and aliases, single- and two-token windows only."""
    for n in (2, 1):
        if i + n > len(tokens):
            continue
        window = tokens[i : i + n]
        if not _is_name_window(window):
            continue
        text = " ".join(t.text for t in window)
        if len(text) < _MIN_FUZZY_LENGTH or not fuzzy_gate(i + n):
            continue
        limit = _max_distance(text)
        best: list[tuple[int, str]] = []  # (distance, osis) of the closest candidates
        for key, osis in _fuzzy_candidates(canon):
            parts = key.split()
            # Same token count, and a numbered book keeps its exact ordinal: "4 john" must not
            # drift to "1 john".
            if len(parts) != n or (n == 2 and window[0].text != parts[0]):
                continue
            distance = jellyfish.levenshtein_distance(text, key)
            if distance > limit:
                continue
            if not best or distance < best[0][0]:
                best = [(distance, osis)]
            elif distance == best[0][0]:
                best.append((distance, osis))
        if not best:
            continue
        if len(best) > 1:
            # The phonetic key only breaks ties at equal distance; it never admits a match. The
            # spec names Double Metaphone, but jellyfish ships only Metaphone, used here instead.
            key_of_text = jellyfish.metaphone(text)
            phonetic = [
                c
                for c in best
                if jellyfish.metaphone(canon.by_osis(c[1]).name.lower()) == key_of_text
            ]
            if phonetic:
                best = phonetic
        if len({osis for _, osis in best}) != 1:
            continue  # still ambiguous between books: do not guess
        distance, osis = best[0]
        return BookMatch(
            book=canon.by_osis(osis), tier="fuzzy", distance=distance, first=i, last=i + n - 1
        )
    return None


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
    return _fuzzy_match(tokens, i, canon, fuzzy_gate)
