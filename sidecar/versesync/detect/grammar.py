"""Stage 2 of reference detection: the grammar (docs/04-reference-detection.md section 4).

Patterns P1-P12 run, in priority order, as regexes over T-10's search string. The first match
wins and *consumes* its tokens, so a later and looser pattern can never re-match the same words:
``1 corinthians 6 : 19 - 20`` is one P1 range, not a P9 chapter plus stray numbers.

Book names (``B``) come from T-11's gated matcher. Each book match is a token span; the tail of a
pattern (everything after ``B``) is a regex anchored at the character offset where that span ends.
P10 is the only pattern with text *before* the book, so its head (``the ORD chapter of``) is a
regex anchored at the character offset where the book starts.

Output shape
============

:func:`match_grammar` returns a :class:`GrammarResult`: the :class:`~versesync.detect.normalize.
Normalized` token array it ran over and a tuple of :class:`Detection` records ordered by position.
Everything downstream consumes these records:

* T-13 (validation, scoring, duplicate suppression) reads ``reference`` and ``alternatives``,
  ``book_match`` (book score), ``pattern`` and ``contextual`` (structure score),
  ``word_probs`` (ASR score) and ``source_start`` (cooldown windows). It must not assume
  anything in here has been validated against the canon, except the Psalms rule below.
* T-17 (read-span alignment) locates the mention through ``word_span`` (indices into the
  transcript word array, stable across normalisations) and ``source_start`` / ``source_end``.
  ``token_span`` indexes ``GrammarResult.normalized.tokens``.
* T-19 (Cue Document assembly) copies ``pattern``, ``contextual``, ``book_match``, ``token_span``
  and ``word_span`` into ``cue.detection`` via :meth:`Detection.detection_block`, and
  ``reference`` / ``alternatives`` into ``cue.reference`` / ``cue.alternatives``.

Conventions that are easy to get wrong:

* ``token_span`` and ``word_span`` are **inclusive** ``(first, last)`` index pairs.
* ``source_start`` is the start of the first token of the match (the "first" in "First
  Corinthians"); ``source_end`` is the end of its last token. For a context-carried fragment
  these cover only the fragment ("verse twelve"), never the reference it borrowed from.
* A chapter-only reading (P5, P9, P10 without a verse, a concatenated Psalm) has
  ``reference.verse is None``. It is never expanded to verse 1 (decision D12).
* ``alternatives`` are competing readings of the same words, in the order the grammar prefers
  them; ``reference`` is the first of those readings. The grammar ranks nothing: T-13 owns the
  final order (docs/04 section 6) and the editor makes the call (D4).

Documented tolerances beyond the section 4 table, each covered by tests:

* An optional comma between the chapter number and the verse keyword in P3/P4
  (``chapter 8 , verse 28``): Whisper punctuates the way people pause.
* A verse list written with commas, ``verses 16 , 17 and 18``, collapses to one range in P3,
  P6 and P11 when the numbers are consecutive (docs/04 section 8). Non-consecutive lists do not
  collapse; the shorter pattern matches the first verse only.
* P10's verse part accepts a range (``, verses 16 through 18``) and an optional comma.
* P10's ordinal covers every ordinal chapter number, not only first to third
  (``the fourth chapter of ephesians``, ``the twenty third chapter of luke``).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from versesync.detect.canon import Book, Canon, load_canon
from versesync.detect.fuzzy import BookMatch, BookMatcher, load_matcher
from versesync.detect.normalize import Normalized, WordLike, normalize_words

#: Context window defaults (docs/04 section 4, "Context carry"). Specified, not tuned.
DEFAULT_CONTEXT_WINDOW_S = 120.0
DEFAULT_CONTEXT_WINDOW_TOKENS = 400

PATTERN_IDS = tuple(f"P{i}" for i in range(1, 13))
#: Patterns that name their own book and chapter. These are what P11/P12 can borrow from.
FULL_PATTERN_IDS = PATTERN_IDS[:10]
#: Verse-only fragments that need a preceding full reference to mean anything.
FRAGMENT_PATTERN_IDS = PATTERN_IDS[10:]

#: ``Alternative.reason`` for the Psalms concatenation ambiguity (docs/04 section 3.1).
REASON_PSALMS_SPLIT = (
    "Split chapter:verse reading of two bare numbers after Psalms; the concatenated chapter "
    "is the default (docs/04 section 3.1)."
)
#: ``Alternative.reason`` for a carried verse that follows an ambiguous reference.
REASON_CARRIED_ALTERNATIVE = (
    "Verse carried onto the alternative reading of the preceding reference."
)

_PSALMS_OSIS = "Ps"


# -- output types ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Reference:
    """A scripture reference exactly as the grammar read it (not canon-validated).

    ``verse`` is ``None`` for a chapter-only reference. ``verse_end`` is set only for a range.
    """

    book: str  # canonical name, e.g. "1 Corinthians"
    osis: str  # e.g. "1Cor"
    chapter: int
    verse: int | None = None
    verse_end: int | None = None

    @property
    def display(self) -> str:
        """``Psalm 122``, ``1 Corinthians 6:19-20``. Psalms is singular, as it is spoken."""
        name = "Psalm" if self.osis == _PSALMS_OSIS else self.book
        out = f"{name} {self.chapter}"
        if self.verse is not None:
            out += f":{self.verse}"
            if self.verse_end is not None:
                out += f"-{self.verse_end}"
        return out

    def to_dict(self) -> dict[str, object]:
        """The Cue Document ``reference`` object (absent keys for absent verses)."""
        out: dict[str, object] = {"book": self.book, "osis": self.osis, "chapter": self.chapter}
        if self.verse is not None:
            out["verse"] = self.verse
        if self.verse_end is not None:
            out["verse_end"] = self.verse_end
        return out


@dataclass(frozen=True)
class BookMatchInfo:
    """How the book was resolved (T-11): ``tier`` is exact | alias | fuzzy."""

    tier: str
    distance: int

    def to_dict(self) -> dict[str, object]:
        return {"tier": self.tier, "distance": self.distance}


@dataclass(frozen=True)
class Alternative:
    """A competing reading of the same words, with a human-readable note on why it competes."""

    reference: Reference
    reason: str


@dataclass(frozen=True)
class Detection:
    """One grammar match: the unit T-13, T-17 and T-19 build on."""

    pattern: str  # "P1" .. "P12"
    reference: Reference  # the first reading in the grammar's preference order
    alternatives: tuple[Alternative, ...]  # other readings of the same words; usually empty
    contextual: bool  # True for P11/P12: book and chapter were carried from an earlier mention
    book_match: BookMatchInfo  # for a carried verse, the source reference's book evidence
    token_span: tuple[int, int]  # inclusive indices into GrammarResult.normalized.tokens
    word_span: tuple[int, int]  # inclusive indices into the transcript word array
    source_start: float  # seconds, start of the first token of the match
    source_end: float  # seconds, end of the last token of the match
    word_probs: tuple[float, ...]  # probability of each distinct source word in the match
    carried_from: tuple[int, int] | None = None  # token_span of the reference a verse borrowed

    @property
    def mean_word_prob(self) -> float:
        """Mean word probability across the matched span (docs/04 section 6 ``asr_score``)."""
        return sum(self.word_probs) / len(self.word_probs)

    @property
    def min_word_prob(self) -> float:
        return min(self.word_probs)

    @property
    def chapter_only(self) -> bool:
        return self.reference.verse is None

    def detection_block(self) -> dict[str, object]:
        """The Cue Document ``cue.detection`` object (schemas/cue-document.schema.json)."""
        return {
            "pattern": self.pattern,
            "contextual": self.contextual,
            "book_match": self.book_match.to_dict(),
            "token_span": list(self.token_span),
            "word_span": list(self.word_span),
        }


@dataclass(frozen=True)
class GrammarResult:
    """Detections in transcript order, with the tokens their spans index into."""

    normalized: Normalized
    detections: tuple[Detection, ...]


@dataclass(frozen=True)
class GrammarConfig:
    """Context window for P11/P12. Both bounds apply; the shorter one wins."""

    context_window_s: float = DEFAULT_CONTEXT_WINDOW_S
    context_window_tokens: int = DEFAULT_CONTEXT_WINDOW_TOKENS


# -- regexes --------------------------------------------------------------------------------

_END = r"(?= |$)"  # a number must be a whole token
_RANGE_CONN = r"(?:through|to|-|and)"  # P3, P11 (and P10's range)
_LIST_CONN = r"(?:and|through|to)"  # P6


def _n(name: str) -> str:
    return rf"(?P<{name}>\d+){_END}"


def _verse_run(conn: str) -> str:
    """``v [, n]* [,] CONN e``: a range, or a comma list that collapses to one range."""
    return rf"{_n('v')}(?P<mid>(?: , \d+{_END})*)(?: ,)? {conn} {_n('e')}"


def _tail(text: str) -> re.Pattern[str]:
    return re.compile(text)


_CHAPTER_KW = rf" chapter {_n('c')}(?: ,)? verses? "

# Tails of P1-P9, matched with ``.match(search, pos)`` at the end of the book span.
_TAILS: dict[str, tuple[re.Pattern[str], ...]] = {
    "P1": (_tail(rf" {_n('c')} : {_n('v')} - {_n('e')}"),),
    "P2": (_tail(rf" {_n('c')} : {_n('v')}"),),
    "P3": (_tail(_CHAPTER_KW + _verse_run(_RANGE_CONN)),),
    "P4": (_tail(_CHAPTER_KW + _n("v")),),
    "P5": (_tail(rf" chapter {_n('c')}"),),
    "P6": (_tail(rf" {_n('c')} , " + _verse_run(_LIST_CONN)),),
    "P7": (_tail(rf" {_n('c')} , {_n('v')}"),),
    "P8": (_tail(rf" {_n('c')} {_n('v')}"),),
    "P9": (_tail(rf" {_n('c')}"),),
    # Tried in order: a verse range, a single verse, no verse at all.
    "P10": (
        _tail(rf"(?: ,)? verses? {_verse_run(_RANGE_CONN)}"),
        _tail(rf"(?: ,)? verses? {_n('v')}"),
        _tail(""),
    ),
}

# P10's head, ``the ORD chapter of``, ending where the book begins. ORD is one to four tokens
# ("fourth", "20 third", "100 and 19th"); one regex per length keeps the match unambiguous.
_P10_HEADS = tuple(
    re.compile(rf"(?<![^ ])the (?P<ord>(?:\S+ ){{{k - 1}}}\S+) chapter of $") for k in range(1, 5)
)

# How far back from the book the head regexes look: "the" + four ordinal tokens of at most ten
# characters + "chapter of " is under 70 characters.
_P10_HEAD_LOOKBACK = 120

# P11 and P12 scan the whole search string.
_P11 = _tail(rf"(?<![^ ])verses? {_verse_run(_RANGE_CONN)}")
_P12 = _tail(rf"(?<![^ ])verse {_n('v')}")


# -- ordinal chapter numbers (P10) ----------------------------------------------------------

_ORDINAL_UNITS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
    "eighth": 8, "ninth": 9,
}  # fmt: skip
_ORDINAL_OTHER = {
    "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14,
    "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
    "twentieth": 20, "thirtieth": 30, "fortieth": 40, "fourtieth": 40, "fiftieth": 50,
    "sixtieth": 60, "seventieth": 70, "eightieth": 80, "ninetieth": 90, "hundredth": 100,
}  # fmt: skip
_DIGIT_ORDINAL = re.compile(r"(\d+)(?:st|nd|rd|th)")


def _ordinal_single(text: str) -> int | None:
    """One token: ``3`` (normalised from "third"), ``4th``, ``fourth``, ``twentieth``."""
    if text.isascii() and text.isdigit():
        return int(text)
    m = _DIGIT_ORDINAL.fullmatch(text)
    if m:
        return int(m.group(1))
    return _ORDINAL_UNITS.get(text) or _ORDINAL_OTHER.get(text)


def _ordinal_value(texts: Sequence[str]) -> int | None:
    """Chapter number from the tokens between ``the`` and ``chapter of``.

    T-10 normalises first/second/third to ``1``/``2``/``3`` and "twenty" to ``20``, so
    "twenty third" arrives as ``20 3``, "one hundred and twenty third" as ``120 3`` and "one
    hundred and nineteenth" as ``100 and nineteenth``.
    """
    if len(texts) == 1:
        return _ordinal_single(texts[0])
    if texts[0] == "100":
        rest = list(texts[1:])
        if rest and rest[0] == "and":
            rest = rest[1:]
        tail = _ordinal_value(rest) if rest else None
        return 100 + tail if tail is not None and tail < 100 else None
    if len(texts) == 2 and texts[0].isascii() and texts[0].isdigit():
        tens = int(texts[0])
        unit = _ordinal_single(texts[1])
        if tens >= 20 and tens % 10 == 0 and unit is not None and 1 <= unit <= 9:
            return tens + unit
    return None


# -- the matcher ----------------------------------------------------------------------------


@dataclass
class _Hit:
    pattern: str
    first: int  # first token index
    last: int  # last token index
    book: BookMatch | None
    readings: list[Reference]
    reasons: list[str]  # one per reading after the first
    verse: int | None = None  # fragments only
    verse_end: int | None = None


class _Run:
    """One pass of the grammar over a normalised transcript."""

    def __init__(self, norm: Normalized, matcher: BookMatcher, canon: Canon) -> None:
        self.norm = norm
        self.canon = canon
        self.texts = [t.text for t in norm.tokens]
        self.books = matcher.find_books(self.texts)
        self.consumed = [False] * len(norm.tokens)

    # -- helpers ------------------------------------------------------------------------

    def _free(self, first: int, last: int) -> bool:
        return not any(self.consumed[first : last + 1])

    def _consume(self, first: int, last: int) -> None:
        for i in range(first, last + 1):
            self.consumed[i] = True

    def _char_end(self, token: int) -> int:
        return self.norm.token_starts[token] + len(self.norm.tokens[token].text)

    def _numbers_only(self, first: int, last: int) -> bool:
        """Digit tokens in a pattern tail must be real numbers, not a book's ordinal prefix."""
        return all(
            t.kind == "number" for t in self.norm.tokens[first : last + 1] if t.text.isdigit()
        )

    # -- full references: P1-P10 --------------------------------------------------------

    def _run_values(self, m: re.Match[str]) -> tuple[int, int | None] | None:
        """(verse, verse_end) from a range match; ``None`` for a list that is not consecutive."""
        v = int(m.group("v"))
        e = int(m.group("e"))
        mids = [int(x) for x in re.findall(r"\d+", m.groupdict().get("mid") or "")]
        if mids:
            run = [v, *mids, e]
            if any(b != a + 1 for a, b in zip(run, run[1:], strict=False)):
                return None
        return v, e

    def _try(self, pid: str, bm: BookMatch) -> _Hit | None:
        book_first, book_last = bm.start, bm.end - 1
        head_first = book_first
        if pid == "P10":
            head = self._p10_head(bm)
            if head is None:
                return None
            head_first, p10_chapter = head
        for pat in _TAILS[pid]:
            m = pat.match(self.norm.search, self._char_end(book_last))
            if m is None:
                continue
            last = book_last
            if m.end() > self._char_end(book_last):
                last = self.norm.token_span(self._char_end(book_last), m.end())[1]
            if not self._numbers_only(book_last + 1, last):
                continue
            groups = m.groupdict()
            chapter = p10_chapter if pid == "P10" else int(groups["c"])
            verse: int | None = None
            verse_end: int | None = None
            if "e" in groups:
                values = self._run_values(m)
                if values is None:
                    continue
                verse, verse_end = values
            elif "v" in groups:
                verse = int(groups["v"])
            return self._hit(pid, bm, head_first, last, chapter, verse, verse_end)
        return None

    def _hit(
        self,
        pid: str,
        bm: BookMatch,
        first: int,
        last: int,
        chapter: int,
        verse: int | None,
        verse_end: int | None,
    ) -> _Hit:
        book = bm.book
        readings = [Reference(book.name, book.osis, chapter, verse, verse_end)]
        reasons: list[str] = []
        if pid == "P8":
            # P8 stores the two bare numbers as chapter and verse.
            assert verse is not None
            readings, reasons = self._psalms_readings(book, chapter, verse)
        return _Hit(pid, first, last, bm, readings, reasons)

    def _psalms_readings(self, book: Book, n1: int, n2: int) -> tuple[list[Reference], list[str]]:
        """``B N N``: chapter and verse, except Psalms where "one nineteen" is chapter 119.

        When both the concatenated chapter and the split chapter:verse are canon-valid, both are
        emitted, concatenated first (docs/04 section 3.1). When only one is valid that is the
        only reading; when neither is, the plain split reading is emitted for T-13 to reject.
        """
        split = Reference(book.name, book.osis, n1, n2)
        if book.osis != _PSALMS_OSIS:
            return [split], []
        joined = int(f"{n1}{n2}")
        concat = Reference(book.name, book.osis, joined)
        concat_ok = self.canon.is_valid(book, joined)
        split_ok = self.canon.is_valid(book, n1, n2)
        if concat_ok and split_ok:
            return [concat, split], [REASON_PSALMS_SPLIT]
        if concat_ok:
            return [concat], []
        return [split], []

    def _p10_head(self, bm: BookMatch) -> tuple[int, int] | None:
        """``the ORD chapter of`` immediately before the book: (index of "the", chapter)."""
        if self.texts[max(bm.start - 2, 0) : bm.start] != ["chapter", "of"]:
            return None
        start_char = self.norm.token_starts[bm.start]
        near = max(0, start_char - _P10_HEAD_LOOKBACK)
        for pat in _P10_HEADS:
            m = pat.search(self.norm.search, near, start_char)
            if m is None:
                continue
            first, last = self.norm.token_span(m.start("ord"), m.end("ord"))
            chapter = _ordinal_value(self.texts[first : last + 1])
            if chapter is None:
                continue
            return self.norm.token_span(m.start(), m.start() + 3)[0], chapter
        return None

    def full_hits(self) -> list[_Hit]:
        hits: list[_Hit] = []
        for pid in FULL_PATTERN_IDS:
            for bm in self.books:
                hit = self._try(pid, bm)
                if hit is not None and self._free(hit.first, hit.last):
                    self._consume(hit.first, hit.last)
                    hits.append(hit)
        return hits

    # -- fragments: P11, P12 ------------------------------------------------------------

    def fragment_hits(self) -> list[_Hit]:
        hits: list[_Hit] = []
        search = self.norm.search
        for pid, pat in (("P11", _P11), ("P12", _P12)):
            pos = 0
            while (m := pat.search(search, pos)) is not None:
                pos = m.start() + 1
                first, last = self.norm.token_span(m.start(), m.end())
                if not self._free(first, last) or not self._numbers_only(first, last):
                    continue
                verse = int(m.group("v"))
                verse_end: int | None = None
                if pid == "P11":
                    values = self._run_values(m)
                    if values is None:
                        continue
                    verse, verse_end = values
                self._consume(first, last)
                hits.append(_Hit(pid, first, last, None, [], [], verse, verse_end))
                pos = m.end()
        return hits


# -- assembling detections --------------------------------------------------------------------


def _span_facts(
    norm: Normalized, words: Sequence[WordLike], first: int, last: int
) -> tuple[tuple[int, int], float, float, tuple[float, ...]]:
    word_ids = sorted({w for t in norm.tokens[first : last + 1] for w in t.word_ids})
    seconds = norm.seconds(first, last)
    return (
        norm.word_span(first, last),
        seconds[0],
        seconds[1],
        tuple(words[w].probability for w in word_ids),
    )


def _within_window(norm: Normalized, source: Detection, first: int, cfg: GrammarConfig) -> bool:
    """Both bounds apply, inclusively: the fragment's first token must start no more than the
    window's seconds after the reference's last token ends, and be no more than the window's
    tokens after the reference's last token."""
    last = source.token_span[1]
    gap_tokens = first - last
    gap_s = norm.tokens[first].start - norm.tokens[last].end
    return gap_tokens <= cfg.context_window_tokens and gap_s <= cfg.context_window_s


def _carry(hit: _Hit, source: Detection) -> tuple[Reference, tuple[Alternative, ...]]:
    def onto(ref: Reference) -> Reference:
        return Reference(ref.book, ref.osis, ref.chapter, hit.verse, hit.verse_end)

    primary = onto(source.reference)
    alternatives: list[Alternative] = []
    for alt in source.alternatives:
        carried = onto(alt.reference)
        if carried != primary and all(carried != a.reference for a in alternatives):
            alternatives.append(Alternative(carried, REASON_CARRIED_ALTERNATIVE))
    return primary, tuple(alternatives)


def match_grammar(
    words: Sequence[WordLike],
    *,
    config: GrammarConfig | None = None,
    canon: Canon | None = None,
    matcher: BookMatcher | None = None,
) -> GrammarResult:
    """Run P1-P12 over a transcript word array.

    Normalises with T-10, resolves books with T-11 (gated), matches the grammar with span
    consumption and priority, then carries book and chapter onto P11/P12 fragments that sit
    inside the context window. Fragments with no reference inside the window are discarded.
    """
    cfg = config or GrammarConfig()
    canon = canon or load_canon()
    norm = normalize_words(words, canon)
    run = _Run(norm, matcher or load_matcher(), canon)

    fulls: list[Detection] = []
    for hit in sorted(run.full_hits(), key=lambda h: h.first):
        assert hit.book is not None
        span, start, end, probs = _span_facts(norm, words, hit.first, hit.last)
        fulls.append(
            Detection(
                pattern=hit.pattern,
                reference=hit.readings[0],
                alternatives=tuple(
                    Alternative(ref, reason)
                    for ref, reason in zip(hit.readings[1:], hit.reasons, strict=True)
                ),
                contextual=False,
                book_match=BookMatchInfo(hit.book.tier, hit.book.distance),
                token_span=(hit.first, hit.last),
                word_span=span,
                source_start=start,
                source_end=end,
                word_probs=probs,
            )
        )

    carried: list[Detection] = []
    for hit in run.fragment_hits():
        source = next((d for d in reversed(fulls) if d.token_span[1] < hit.first), None)
        if source is None or not _within_window(norm, source, hit.first, cfg):
            continue
        reference, alternatives = _carry(hit, source)
        span, start, end, probs = _span_facts(norm, words, hit.first, hit.last)
        carried.append(
            Detection(
                pattern=hit.pattern,
                reference=reference,
                alternatives=alternatives,
                contextual=True,
                book_match=source.book_match,
                token_span=(hit.first, hit.last),
                word_span=span,
                source_start=start,
                source_end=end,
                word_probs=probs,
                carried_from=source.token_span,
            )
        )

    detections = sorted([*fulls, *carried], key=lambda d: d.token_span)
    return GrammarResult(norm, tuple(detections))
