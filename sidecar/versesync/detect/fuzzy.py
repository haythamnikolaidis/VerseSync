"""Book-name matching: exact, curated ASR confusions, and gated fuzzy (docs/04 section 4.1).

Input is a sequence of normalised surface tokens (lower-case words; numbers as digit strings).
Every match must pass the number-follows gate: the candidate is immediately followed by a number
pattern (``N`` or ``chapter N``, the openings of P1-P9) or is preceded by ``chapter of`` (P10).
That gate is what keeps "he lost his job" from becoming the book of Job. The gate is applied to
every tier, not only tiers 2 and 3: a book name with no number attached is never a reference.

One further opening exists, for the five single-chapter books only (Obadiah, Philemon, 2 John,
3 John, Jude): ``,? verse[s] N`` (P13), because a verse in those books is spoken with no chapter
number ("Jude verse three"). Any other book followed by ``verse N`` ("John verse three") is
still gated out.

Tiers (named as in the Cue Document schema's ``book_match.tier``):

1. ``exact``: canonical name or curated alias from the canon table (distance 0)
2. ``alias``: the curated confusion table in ``data/confusions.json`` (distance 0)
3. ``fuzzy``: Levenshtein distance against canonical names and long aliases, with Double
   Metaphone as a secondary signal
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

from metaphone import doublemetaphone

from versesync.detect.canon import Book, Canon, load_canon, normalize_name

TIER_EXACT = "exact"
TIER_ALIAS = "alias"
TIER_FUZZY = "fuzzy"

_TIER_RANK = {TIER_EXACT: 0, TIER_ALIAS: 1, TIER_FUZZY: 2}

# Short high-frequency names that match at tier 1 only (docs/04 section 4.1).
EXACT_ONLY_OSIS = frozenset({"Job", "Mark", "Acts", "Num", "Judg", "Ruth", "Jas", "Amos"})

# Longest candidate considered, in tokens (ordinal prefix included).
_MAX_SPAN = 6
# Longest run of ordinary tokens joined into one fuzzy candidate ("have a cook" is three).
_MAX_FUZZY_TOKENS = 3

# Design limits beyond the spec's eight names. One edit from a short word reaches too many
# everyday words ("like" -> Luke, "palm" -> Psalm), so fuzzy skips candidates and aliases shorter
# than these, and canonical names of this length or less (Luke, John, Jude, Joel, Ezra) are
# exact-only like the eight above.
_MIN_FUZZY_LEN = 4
_MIN_FUZZY_ALIAS_LEN = 6
_MAX_EXACT_ONLY_NAME_LEN = 4

# Spec: distance <= 2 for candidates of length >= 6, <= 1 for shorter.
_LONG_CANDIDATE_LEN = 6
# A matching Double Metaphone key widens the allowance by one edit, for long candidates only.
_PHONETIC_MIN_LEN = 8

_ORDINALS: dict[str, int] = {
    "1": 1, "first": 1, "1st": 1, "one": 1,
    "2": 2, "second": 2, "2nd": 2, "two": 2,
    "3": 3, "third": 3, "3rd": 3, "three": 3,
}  # fmt: skip

_NUMBERED_RE = re.compile(r"^(\d) (.+)$")


@dataclass(frozen=True)
class BookMatch:
    """A matched book and the token span ``[start, end)`` that produced it."""

    book: Book
    tier: str
    distance: int
    start: int
    end: int


@dataclass(frozen=True)
class _Cand:
    book: Book
    tier: str
    distance: int
    start: int
    end: int
    text_tokens: int
    phonetic: bool = False


def levenshtein(a: str, b: str, limit: int | None = None) -> int:
    """Edit distance; with ``limit``, may return ``limit + 1`` early once it is exceeded."""
    if a == b:
        return 0
    if limit is not None and abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if limit is not None and min(cur) > limit:
            return limit + 1
        prev = cur
    return prev[-1]


def _primary_key(text: str) -> str:
    return str(doublemetaphone(text)[0])


def _is_number(token: str) -> bool:
    return token.isascii() and token.isdigit()


def number_follows(tokens: Sequence[str], end: int) -> bool:
    """True when a number pattern (``N`` or ``chapter N``) starts at ``tokens[end]``."""
    if end >= len(tokens):
        return False
    if _is_number(tokens[end]):
        return True
    return tokens[end] == "chapter" and end + 1 < len(tokens) and _is_number(tokens[end + 1])


def verse_follows(tokens: Sequence[str], end: int) -> bool:
    """True when ``,? verse[s] N`` starts at ``tokens[end]``: the opening of P13."""
    i = end + 1 if end < len(tokens) and tokens[end] == "," else end
    return i + 1 < len(tokens) and tokens[i] in ("verse", "verses") and _is_number(tokens[i + 1])


def _chapter_of_precedes(tokens: Sequence[str], start: int) -> bool:
    return start >= 2 and tokens[start - 2] == "chapter" and tokens[start - 1] == "of"


def _bare_name(book: Book) -> str:
    """Canonical name without a leading ordinal digit, space-stripped."""
    return re.sub(r"^\d ", "", normalize_name(book.name)).replace(" ", "")


class BookMatcher:
    """Resolves book names in token sequences. Build once; it is immutable."""

    def __init__(self, canon: Canon, confusions: Sequence[tuple[str, str]]) -> None:
        self._canon = canon
        # family name ("corinthians") -> {ordinal: book}; plain name -> book.
        self._families: dict[str, dict[int, Book]] = {}
        self._plain: dict[str, Book] = {}
        for book in canon.books:
            m = _NUMBERED_RE.match(normalize_name(book.name))
            if m:
                self._families.setdefault(m.group(2), {})[int(m.group(1))] = book
            else:
                self._plain[normalize_name(book.name)] = book

        self._confusions_plain: dict[str, Book] = {}
        self._confusions_family: dict[str, str] = {}
        for heard, target in confusions:
            key = normalize_name(heard)
            name = normalize_name(target)
            if name in self._plain:
                self._confusions_plain[key] = self._plain[name]
            elif name in self._families:
                self._confusions_family[key] = name
            else:
                raise ValueError(f"confusion target is not a book or book family: {target!r}")

        numbered = {b.osis for members in self._families.values() for b in members.values()}
        # Fuzzy pools keyed by space-stripped text.
        self._fuzzy_plain: dict[str, set[Book]] = {}
        for book in canon.books:
            if book.osis in numbered or not self._fuzzy_allowed(book):
                continue
            names = [normalize_name(book.name)]
            for alias in book.aliases:
                norm = normalize_name(alias)
                if len(norm.replace(" ", "")) >= _MIN_FUZZY_ALIAS_LEN and not any(
                    c.isdigit() for c in norm
                ):
                    names.append(norm)
            for name in names:
                self._fuzzy_plain.setdefault(name.replace(" ", ""), set()).add(book)
        self._fuzzy_family: dict[str, dict[int, Book]] = {
            fam: members
            for fam, members in self._families.items()
            if all(self._fuzzy_allowed(b) for b in members.values())
        }
        self._keys: dict[str, str] = {
            text: _primary_key(text) for text in (*self._fuzzy_plain, *self._fuzzy_family)
        }

    @staticmethod
    def _fuzzy_allowed(book: Book) -> bool:
        return book.osis not in EXACT_ONLY_OSIS and len(_bare_name(book)) > _MAX_EXACT_ONLY_NAME_LEN

    # -- candidate generation -------------------------------------------------------------

    def _exact(self, tokens: Sequence[str], s: int, e: int) -> Book | None:
        book = self._canon.resolve(" ".join(tokens[s:e]))
        if book is not None:
            return book
        # "one Corinthians": a spoken ordinal that the canon aliases spell as a digit.
        first = tokens[s]
        if first in _ORDINALS and e - s > 1:
            digit = str(_ORDINALS[first])
            numbered = self._canon.resolve(" ".join([digit, *tokens[s + 1 : e]]))
            if numbered is not None and _NUMBERED_RE.match(normalize_name(numbered.name)):
                return numbered
        return None

    def _alias(self, tokens: Sequence[str], s: int, e: int) -> Book | None:
        book = self._confusions_plain.get(normalize_name(" ".join(tokens[s:e])))
        if book is not None:
            return book
        if e - s > 1 and tokens[s] in _ORDINALS:
            rest = normalize_name(" ".join(tokens[s + 1 : e]))
            family = self._confusions_family.get(rest)
            if family is not None:
                return self._families[family].get(_ORDINALS[tokens[s]])
        return None

    def _fuzzy(self, tokens: Sequence[str], s: int, e: int) -> _Cand | None:
        ordinal = None
        offset = 0
        if e - s > 1 and tokens[s] in _ORDINALS:
            ordinal = _ORDINALS[tokens[s]]
            offset = 1
        words = tokens[s + offset : e]
        if not words or len(words) > _MAX_FUZZY_TOKENS:
            return None
        if any(w in _ORDINALS or w in ("chapter", "verse", "of") or not w.isalpha() for w in words):
            return None
        text = "".join(words)
        if len(text) < _MIN_FUZZY_LEN:
            return None
        limit = 2 if len(text) >= _LONG_CANDIDATE_LEN else 1
        key = _primary_key(text) if len(text) >= _PHONETIC_MIN_LEN else None

        pool: dict[str, set[Book]]
        if ordinal is None:
            pool = self._fuzzy_plain
        else:
            pool = {
                fam: {members[ordinal]}
                for fam, members in self._fuzzy_family.items()
                if ordinal in members
            }
        best: tuple[int, bool] | None = None  # (distance, phonetic); lower distance wins
        winners: list[Book] = []
        for name, books in pool.items():
            phonetic = key is not None and self._keys[name] == key
            dist = levenshtein(text, name, limit + 1)
            if dist > (limit + 1 if phonetic else limit):
                continue
            rank = (dist, not phonetic)
            if best is None or rank < (best[0], not best[1]):
                best, winners = (dist, phonetic), list(books)
            elif rank == (best[0], not best[1]):
                winners.extend(books)
        # A tie between different books is ambiguous: better no match than a wrong one.
        if best is None or len({b.osis for b in winners}) != 1:
            return None
        return _Cand(winners[0], TIER_FUZZY, best[0], s, e, len(words), best[1])

    def _candidate(self, tokens: Sequence[str], s: int, e: int) -> _Cand | None:
        book = self._exact(tokens, s, e)
        if book is not None:
            return _Cand(book, TIER_EXACT, 0, s, e, e - s)
        book = self._alias(tokens, s, e)
        if book is not None:
            return _Cand(book, TIER_ALIAS, 0, s, e, e - s)
        return self._fuzzy(tokens, s, e)

    # -- public API -----------------------------------------------------------------------

    def find_books(self, tokens: Sequence[str]) -> list[BookMatch]:
        """All gated book matches in ``tokens``, left to right and non-overlapping."""
        out: list[BookMatch] = []
        last_end = 0
        for e in range(1, len(tokens) + 1):
            follows = number_follows(tokens, e)
            verse_gate = verse_follows(tokens, e)
            best: _Cand | None = None
            for s in range(max(last_end, e - _MAX_SPAN), e):
                open_to_any_book = follows or _chapter_of_precedes(tokens, s)
                if not (open_to_any_book or verse_gate):
                    continue
                cand = self._candidate(tokens, s, e)
                if cand is None:
                    continue
                # `verse N` alone opens the gate for single-chapter books only.
                if not open_to_any_book and cand.book.chapter_count != 1:
                    continue
                if best is None or _better(cand, best):
                    best = cand
            if best is not None:
                out.append(BookMatch(best.book, best.tier, best.distance, best.start, best.end))
                last_end = best.end
        return out


def _better(a: _Cand, b: _Cand) -> bool:
    """Order candidates ending at the same token: tier, distance, then the more specific span."""
    ka = (_TIER_RANK[a.tier], a.distance, not a.phonetic)
    kb = (_TIER_RANK[b.tier], b.distance, not b.phonetic)
    if ka != kb:
        return ka < kb
    if a.tier == TIER_FUZZY:
        return a.text_tokens < b.text_tokens
    return a.start < b.start  # longest exact/alias span, so "1 john" beats "john"


def _load_confusions() -> list[tuple[str, str]]:
    raw = (resources.files("versesync.detect") / "data" / "confusions.json").read_text("utf-8")
    return [(e["heard"], e["book"]) for e in json.loads(raw)["entries"]]


@lru_cache(maxsize=1)
def load_matcher() -> BookMatcher:
    return BookMatcher(load_canon(), _load_confusions())


def find_books(tokens: Sequence[str]) -> list[BookMatch]:
    """Gated book matches in ``tokens`` using the shared matcher."""
    return load_matcher().find_books(tokens)
