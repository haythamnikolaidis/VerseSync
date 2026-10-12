"""Stage 1 of reference detection: word array -> normalised token array + search string.

Every :class:`Token` keeps ``word_ids`` back into the original word array, so a regex match over
the search string converts back to a token span, then a word span, then source seconds.
See docs/04-reference-detection.md section 3.

Structural punctuation kept as its own ``punct`` token: ``:`` (chapter/verse), ``-`` (range) and
``,`` (the comma form of chapter/verse, grammar patterns P6/P7/P10). All other punctuation is
stripped.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from versesync.detect.canon import Canon, load_canon


class WordLike(Protocol):
    """The transcriber's word shape: ``Word(text, start, end, probability)``."""

    text: str
    start: float
    end: float
    probability: float


@dataclass
class Token:
    text: str  # normalised surface form
    kind: str  # 'word' | 'number' | 'ordinal' | 'punct'
    value: int | None  # numeric value when kind is number/ordinal
    word_ids: list[int]  # indices into the original Word array
    start: float  # seconds, from the first source word
    end: float  # seconds, from the last source word
    prob: float  # min probability across source words


@dataclass
class Normalized:
    """Tokens plus the search string and the maps that connect them."""

    tokens: list[Token]
    search: str
    #: ``token_starts[i]`` is the character offset of token ``i`` inside ``search``.
    token_starts: list[int]
    #: One entry per character of ``search``: the owning token index, or -1 for the single
    #: space separating two tokens.
    char_to_token: list[int] = field(repr=False)

    def token_span(self, char_start: int, char_end: int) -> tuple[int, int]:
        """Convert a regex match span (``[char_start, char_end)``) to inclusive token indices."""
        owners = [t for t in self.char_to_token[char_start:char_end] if t >= 0]
        if not owners:
            raise ValueError(f"span {char_start}:{char_end} covers no token")
        return owners[0], owners[-1]

    def word_span(self, first: int, last: int) -> tuple[int, int]:
        """Inclusive range of source word indices covered by tokens ``first..last``."""
        ids = [w for t in self.tokens[first : last + 1] for w in t.word_ids]
        return min(ids), max(ids)

    def seconds(self, first: int, last: int) -> tuple[float, float]:
        """Source ``(start, end)`` seconds of tokens ``first..last`` (inclusive)."""
        return self.tokens[first].start, self.tokens[last].end

    def min_prob(self, first: int, last: int) -> float:
        return min(t.prob for t in self.tokens[first : last + 1])


_UNITS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}  # fmt: skip
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}  # fmt: skip
_ORDINAL_WORDS = {"first": 1, "second": 2, "third": 3}
_ORDINAL_DIGITS = {"1st": 1, "2nd": 2, "3rd": 3}
_ROMAN = {"i": 1, "ii": 2, "iii": 3}

_ATOM = re.compile(
    r"(?P<digits>\d+)(?P<suffix>[^\W\d_]+)?"  # 3, 19, 1st, 16th
    r"|(?P<alpha>[^\W\d_]+(?:['’][^\W\d_]+)*)"  # words, keeping inner apostrophes
    r"|(?P<punct>[:,\-‐-―])"
)


@dataclass
class _Piece:
    text: str  # lower-cased atom
    kind: str  # 'alpha' | 'digits' | 'ordinal_digits' | 'punct'
    word_id: int
    raw: str  # original casing, used to tell the numeral "I" from the pronoun
    intra: bool = False  # a hyphen joining two letter runs inside one source word


def _pieces(words: Sequence[WordLike]) -> list[_Piece]:
    out: list[_Piece] = []
    for wid, word in enumerate(words):
        first = len(out)
        for m in _ATOM.finditer(word.text):
            digits = m.group("digits")
            if digits is not None:
                whole = m.group(0).lower()
                if m.group("suffix") is None:
                    out.append(_Piece(digits, "digits", wid, digits))
                elif whole in _ORDINAL_DIGITS:
                    out.append(_Piece(whole, "ordinal_digits", wid, whole))
                else:  # "16th", "20s": not a reference form, keep as an ordinary word
                    out.append(_Piece(whole, "alpha", wid, whole))
            elif m.group("alpha") is not None:
                raw = m.group("alpha").replace("’", "'")
                out.append(_Piece(raw.lower(), "alpha", wid, raw))
            else:
                ch = m.group("punct")
                text = ch if ch in ",:" else "-"
                out.append(_Piece(text, "punct", wid, ch))
        for k in range(first + 1, len(out) - 1):
            p = out[k]
            if p.text == "-" and out[k - 1].kind == "alpha" and out[k + 1].kind == "alpha":
                p.intra = True
    return out


def _parse_number(pieces: list[_Piece], i: int) -> tuple[int, int] | None:
    """Parse a spoken or digit number starting at ``pieces[i]``.

    Returns ``(value, next_index)``. Covers units, teens, tens, tens+unit compounds and
    ``unit hundred [and] remainder`` up to 999. An intra-word hyphen may sit between parts
    (``twenty-eight``).
    """

    def at(k: int) -> str | None:
        return pieces[k].text if k < len(pieces) and pieces[k].kind == "alpha" else None

    def skip_hyphen(k: int) -> int:
        return k + 1 if k < len(pieces) and pieces[k].intra else k

    def under_hundred(k: int) -> tuple[int, int] | None:
        w = at(k)
        if w is None:
            return None
        if w in _TENS:
            nxt = skip_hyphen(k + 1)
            u = at(nxt)
            if u is not None and u in _UNITS and _UNITS[u] < 10:
                return _TENS[w] + _UNITS[u], nxt + 1
            return _TENS[w], k + 1
        if w in _UNITS:
            return _UNITS[w], k + 1
        return None

    if i >= len(pieces):
        return None
    if pieces[i].kind == "digits":
        return int(pieces[i].text), i + 1

    if at(i) == "a" and at(i + 1) == "hundred":
        hundreds, hundred_at = 1, i + 1
    else:
        small = under_hundred(i)
        if small is None:
            return None
        hundred_at = skip_hyphen(small[1])
        if not (small[0] < 10 and at(hundred_at) == "hundred"):
            return small
        hundreds = small[0]

    value = hundreds * 100
    k = skip_hyphen(hundred_at + 1)
    if at(k) == "and":
        rest = under_hundred(skip_hyphen(k + 1))
        if rest is not None:
            return value + rest[0], rest[1]
    rest = under_hundred(k)
    if rest is not None:
        return value + rest[0], rest[1]
    return value, hundred_at + 1


def _numbered_book_follows(pieces: list[_Piece], k: int, ordinal: int, canon: Canon) -> bool:
    if k >= len(pieces) or pieces[k].kind != "alpha":
        return False
    return canon.resolve(f"{ordinal} {pieces[k].text}") is not None


def normalize_words(words: Sequence[WordLike], canon: Canon | None = None) -> Normalized:
    """Normalise a transcript word array into tokens and a searchable string."""
    canon = canon or load_canon()
    pieces = _pieces(words)
    tokens: list[Token] = []

    def emit(text: str, kind: str, value: int | None, used: list[_Piece]) -> None:
        ids = sorted({p.word_id for p in used})
        tokens.append(
            Token(
                text=text,
                kind=kind,
                value=value,
                word_ids=ids,
                start=words[ids[0]].start,
                end=words[ids[-1]].end,
                prob=min(words[w].probability for w in ids),
            )
        )

    i = 0
    n = len(pieces)
    while i < n:
        p = pieces[i]
        if p.kind == "punct":
            if not p.intra:
                emit(p.text, "punct", None, [p])
            elif tokens and tokens[-1].kind == "number" and _parse_number(pieces, i + 1):
                # "nineteen-twenty": two numbers that do not combine, so the hyphen is a range.
                emit("-", "punct", None, [p])
            i += 1
            continue
        if p.kind == "ordinal_digits":
            value = _ORDINAL_DIGITS[p.text]
            emit(str(value), "ordinal", value, [p])
            i += 1
            continue

        parsed = _parse_number(pieces, i)
        if parsed is not None:
            value, nxt = parsed
            single = nxt - i == 1
            if single and 1 <= value <= 3 and _numbered_book_follows(pieces, nxt, value, canon):
                emit(str(value), "ordinal", value, pieces[i:nxt])
            else:
                emit(str(value), "number", value, pieces[i:nxt])
            i = nxt
            continue

        if p.text in _ORDINAL_WORDS:
            value = _ORDINAL_WORDS[p.text]
            emit(str(value), "ordinal", value, [p])
        elif (
            p.text in _ROMAN
            and p.raw.isupper()
            and _numbered_book_follows(pieces, i + 1, _ROMAN[p.text], canon)
        ):
            value = _ROMAN[p.text]
            emit(str(value), "ordinal", value, [p])
        else:
            emit(p.text, "word", None, [p])
        i += 1

    starts: list[int] = []
    char_to_token: list[int] = []
    offset = 0
    for idx, tok in enumerate(tokens):
        if idx:
            char_to_token.append(-1)
            offset += 1
        starts.append(offset)
        char_to_token.extend([idx] * len(tok.text))
        offset += len(tok.text)
    return Normalized(tokens, " ".join(t.text for t in tokens), starts, char_to_token)
