"""Locate scripture-file entries in the transcript (docs/14 sections 4.1 to 4.7).

Each entry gets candidate placements from two sources, its text read aloud (``text_candidates``)
and the references spoken near it (``mention_candidates``). ``merge`` joins the two for one entry,
and ``assign`` picks at most one placement per entry across the whole file, in file order.
``locate`` runs ``assign`` and then the passes over what it left over: a strong reading out of
order (section 4.5), and scriptures the pastor went back to with no new slide (section 4.6). It
also finds when each verse of a multi-verse reading starts (section 4.7).

Everything here is in source seconds and deterministic (05 section 10): no clock, no randomness,
and no result depends on dict or set iteration order.
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, fields, replace
from itertools import accumulate
from typing import Literal

from versesync.config import Config
from versesync.detect.detector import FLAG_SUPPRESSED, Detection
from versesync.scripture_file import ExportEntry
from versesync.timing.align import AlignConfig, AToken, align_from, normalise_verse, tokens_equal
from versesync.types import Reference

# Start positions of a reading are the transcript tokens equal to one of the first three
# verse tokens (14 section 4.1).
_OPENERS = 3


@dataclass(frozen=True)
class LocateConfig:
    """The ``scripture_file`` config section (14 section 10) plus the alignment settings."""

    text_min_coverage: float = 0.30
    candidates_per_entry: int = 5
    merge_before_s: float = 120.0
    merge_after_s: float = 20.0
    merge_bonus: float = 0.25
    mention_weight: float = 0.5
    repeat_min_matched_tokens: int = 5
    align: AlignConfig = AlignConfig()

    @classmethod
    def from_config(cls, config: Config, align: AlignConfig = AlignConfig()) -> LocateConfig:
        """Build from ``config.scripture_file``; unset keys keep the dataclass default."""
        names = {f.name for f in fields(cls)} - {"align"}
        overrides = {k: v for k, v in config.scripture_file.items() if k in names}
        return cls(align=align, **overrides)


@dataclass(frozen=True)
class TextCandidate:
    """One reading of an entry's text found in the transcript (14 section 4.1)."""

    entry_index: int
    coverage: float  # matched / number of verse tokens
    matched: int  # verse tokens matched
    read_start_s: float
    read_end_s: float
    word_span: tuple[int, int]  # inclusive indices into the Word array
    start_token: int  # index into the alignment tokens where the run started


@dataclass(frozen=True)
class MentionCandidate:
    """A spoken reference that matches an entry (14 section 4.2)."""

    entry_index: int
    detection: Detection
    score: float  # mention_weight x detection.confidence
    mention_start_s: float


@dataclass(frozen=True)
class Placement:
    """A place in the transcript an entry may be put, or, from ``assign``, is put.

    ``text`` and ``mention`` say where it came from: both for a merged candidate, one for the
    others. ``time_s`` is the read start of a text placement and the mention start of the other
    two, and it is the time ``assign`` orders by.
    """

    entry_index: int
    score: float
    time_s: float
    text: TextCandidate | None = None
    mention: MentionCandidate | None = None

    @property
    def word_span(self) -> tuple[int, int] | None:
        """The reading's inclusive word span, if the placement has a text candidate."""
        return None if self.text is None else self.text.word_span


class TokenIndex:
    """Where each distinct transcript token occurs, to find a verse's start positions fast.

    Testing every transcript token against a verse's first words costs a full pass per entry.
    Here the transcript is grouped once by token text, and a word is compared with each distinct
    text, which for an hour of speech is a few thousand tokens against a few hundred texts.
    """

    def __init__(self, tokens: Sequence[AToken], align_cfg: AlignConfig = AlignConfig()) -> None:
        self.tokens = tokens
        self._cfg = align_cfg
        self._positions: dict[str, list[int]] = {}
        for position, token in enumerate(tokens):
            self._positions.setdefault(token.text, []).append(position)
        # Levenshtein distance 1 changes the length by at most one, so a fuzzy match is only
        # looked for among texts of length n - 1, n and n + 1.
        self._by_length: dict[int, list[str]] = {}
        for text in self._positions:
            self._by_length.setdefault(len(text), []).append(text)

    def positions_equal_to(self, word: str) -> list[int]:
        """Ascending positions of every token that ``tokens_equal`` the verse token ``word``."""
        found = list(self._positions.get(word, ()))
        if len(word) >= self._cfg.fuzzy_min_len:
            for length in (len(word) - 1, len(word), len(word) + 1):
                for text in self._by_length.get(length, ()):
                    if text != word and tokens_equal(text, word, self._cfg):
                        found.extend(self._positions[text])
        found.sort()
        return found


def _spans_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def _run_span(verse_tokens: int) -> int:
    """How many transcript tokens a run over a verse of ``verse_tokens`` tokens may use (14 4.1)."""
    return 3 * verse_tokens + 30


def text_candidates(
    entry: ExportEntry,
    tokens: Sequence[AToken],
    cfg: LocateConfig = LocateConfig(),
    index: TokenIndex | None = None,
) -> list[TextCandidate]:
    """Readings of ``entry`` in the transcript, best coverage first (14 section 4.1).

    Every transcript token that ``tokens_equal`` one of the first three verse tokens starts a run
    of ``align_from`` over ``tokens[j : j + 3|V| + 30]``. That span cap stops a greedy run from
    collecting stray matches across the whole sermon. Runs are sorted by coverage, highest first
    (ties: earliest), and a run is kept when its coverage is at least ``text_min_coverage`` and
    its word span overlaps none already kept, up to ``candidates_per_entry``. Overlap, not a time
    window, separates two readings of the same text.

    An entry whose text normalises to nothing has no candidates. Pass one ``TokenIndex`` built
    from ``tokens`` to share it between entries.
    """
    verse = normalise_verse(entry.lines)
    if not verse or not tokens or cfg.candidates_per_entry <= 0:
        return []
    if index is None:
        index = TokenIndex(tokens, cfg.align)
    elif index.tokens is not tokens:
        raise ValueError("index was not built from these tokens")

    cap = _run_span(len(verse))
    starts = sorted({pos for word in verse[:_OPENERS] for pos in index.positions_equal_to(word)})
    # (-matched, first token, last token, start): sorting these is coverage descending, then
    # earliest, because every run is scored against the same verse length.
    runs: list[tuple[int, int, int, int]] = []
    for j in starts:
        run = align_from(verse, tokens[j : j + cap], 0, cfg.align)
        if run.first_match is None or run.last_match is None:
            continue
        if run.matched / len(verse) < cfg.text_min_coverage:
            continue
        runs.append((-run.matched, j + run.first_match, j + run.last_match, j))
    runs.sort()

    kept: list[TextCandidate] = []
    for neg_matched, first, last, j in runs:
        span = (tokens[first].word_index, tokens[last].word_index)
        if any(_spans_overlap(span, c.word_span) for c in kept):
            continue
        kept.append(
            TextCandidate(
                entry_index=entry.index,
                coverage=-neg_matched / len(verse),
                matched=-neg_matched,
                read_start_s=tokens[first].start,
                read_end_s=tokens[last].end,
                word_span=span,
                start_token=j,
            )
        )
        if len(kept) == cfg.candidates_per_entry:
            break
    return kept


def _reference_matches(entry: Reference, spoken: Reference) -> bool:
    """Same book and chapter, and a chapter-only mention or a verse range that intersects."""
    if entry.osis != spoken.osis or entry.chapter != spoken.chapter:
        return False
    if spoken.verse is None or entry.verse is None:
        return True
    entry_last = entry.verse if entry.verse_end is None else entry.verse_end
    spoken_last = spoken.verse if spoken.verse_end is None else spoken.verse_end
    return spoken.verse <= entry_last and entry.verse <= spoken_last


def _mention(entry_index: int, detection: Detection, cfg: LocateConfig) -> MentionCandidate:
    return MentionCandidate(
        entry_index=entry_index,
        detection=detection,
        score=cfg.mention_weight * detection.confidence,
        mention_start_s=detection.candidate.source_start,
    )


def mention_candidates(
    entry: ExportEntry,
    detections: Sequence[Detection],
    cfg: LocateConfig = LocateConfig(),
) -> list[MentionCandidate]:
    """The detections whose reference matches ``entry``, in time order (14 section 4.2).

    Chapter-only detections count: a scripture is often only named as "James 1". Every
    detection is a candidate here, including a ``suppressed_duplicate`` one.
    """
    found = [
        _mention(entry.index, d, cfg)
        for d in detections
        if _reference_matches(entry.reference, d.reference)
    ]
    found.sort(key=lambda m: (m.mention_start_s, m.detection.id))
    return found


def _in_merge_window(start_s: float, text: TextCandidate, cfg: LocateConfig) -> bool:
    """Whether a mention starting at ``start_s`` merges with the reading ``text`` (14 4.3)."""
    return (
        text.read_start_s - cfg.merge_before_s <= start_s <= text.read_start_s + cfg.merge_after_s
    )


def merge(
    text: Sequence[TextCandidate],
    mentions: Sequence[MentionCandidate],
    cfg: LocateConfig = LocateConfig(),
) -> list[Placement]:
    """Candidate placements of one entry, in time order (14 section 4.3).

    A text candidate and a mention merge when the mention starts no more than ``merge_before_s``
    before, or ``merge_after_s`` after, the read start. The merged score is ``coverage +
    merge_bonus``, with the text candidate's span and the mention's start as the time.

    The spec doesn't say which mention a text candidate takes when several fall in the window,
    so the most conservative reading is used: each mention joins at most one text candidate, and
    text candidates choose in the order given (best coverage first), each taking the nearest
    free mention to its read start, the earlier on a tie. Text candidates left without a mention
    stay text placements, and mentions left over stay mention placements.
    """
    free = list(mentions)
    placements: list[Placement] = []
    for candidate in text:
        window = [m for m in free if _in_merge_window(m.mention_start_s, candidate, cfg)]
        if not window:
            placements.append(
                Placement(
                    candidate.entry_index,
                    candidate.coverage,
                    candidate.read_start_s,
                    text=candidate,
                )
            )
            continue
        nearest = min(
            window,
            key=lambda m: (abs(m.mention_start_s - candidate.read_start_s), m.mention_start_s),
        )
        free.remove(nearest)
        placements.append(
            Placement(
                candidate.entry_index,
                candidate.coverage + cfg.merge_bonus,
                nearest.mention_start_s,
                text=candidate,
                mention=nearest,
            )
        )
    placements.extend(Placement(m.entry_index, m.score, m.mention_start_s, mention=m) for m in free)
    placements.sort(key=lambda p: p.time_s)
    return placements


def build_candidates(
    entries: Sequence[ExportEntry],
    tokens: Sequence[AToken],
    detections: Sequence[Detection],
    cfg: LocateConfig = LocateConfig(),
) -> list[list[Placement]]:
    """The candidate placements of every entry, in file order: the input of ``assign``.

    One ``TokenIndex`` serves all the entries, so the transcript is grouped once, not per entry.
    """
    index = TokenIndex(tokens, cfg.align)
    return [
        merge(
            text_candidates(entry, tokens, cfg, index),
            mention_candidates(entry, detections, cfg),
            cfg,
        )
        for entry in entries
    ]


# Scores are added as whole numbers of these, so equal totals compare equal whatever order their
# parts were added in. Float sums of the same scores can differ in the last bit.
_TICKS_PER_POINT = 10**9


@dataclass(frozen=True)
class _State:
    """The best chain of placements that ends in ``placement`` (an entry's candidate)."""

    total: int  # ticks
    placement: Placement
    position: int  # the entry's place in file order
    option: int  # the candidate's place in the entry's list
    previous: _State | None

    @property
    def rank(self) -> tuple[int, float, int, int]:
        """Larger is better: the larger total, then the earlier time, entry and candidate."""
        return (self.total, -self.placement.time_s, -self.position, -self.option)


def assign(
    entries: Sequence[ExportEntry], candidates: Sequence[Sequence[Placement]]
) -> list[Placement | None]:
    """At most one placement per entry, in file order, with the largest total score (14 4.4).

    ``candidates[k]`` holds the placements of ``entries[k]``, for example from ``merge``. The
    placements chosen have times strictly increasing in file order, which is what separates the
    second of two identical entries from the first: it can't reuse a reading that sits before the
    entry placed in between, so it takes a later mention. An entry may be left unplaced (``None``)
    at a score of 0.

    Dynamic programming over the entries in file order: the best chain ending in a candidate is
    its score plus the best chain of an earlier entry that ends before it. Ties go to the earlier
    placement, then the earlier entry, then the earlier candidate in the list, so the result
    doesn't depend on anything but the input.
    """
    if len(entries) != len(candidates):
        raise ValueError("candidates must hold one list of placements per entry")

    # Chains kept for the lookup "the best chain that ends before time t". A chain is useless
    # when another ends no later and ranks higher, so what is left is in time order with rank
    # rising, and the answer to the lookup is the last chain that ends before t.
    frontier: list[_State] = []
    ends: list[float] = []  # frontier[k].placement.time_s, for bisect
    for position, options in enumerate(candidates):
        reached: list[_State] = []
        for option, placement in sorted(
            enumerate(options), key=lambda item: (item[1].time_s, item[0])
        ):
            gain = round(placement.score * _TICKS_PER_POINT)
            if gain <= 0:
                continue
            behind = bisect_left(ends, placement.time_s)  # chains ending strictly before
            previous = frontier[behind - 1] if behind else None
            total = gain + (0 if previous is None else previous.total)
            reached.append(_State(total, placement, position, option, previous))
        # Added only now, so an entry never chains to one of its own candidates.
        for state in reached:
            end = state.placement.time_s
            tied_or_before = bisect_right(ends, end)
            if tied_or_before and frontier[tied_or_before - 1].rank > state.rank:
                continue
            first = bisect_left(ends, end)
            last = first
            while last < len(frontier) and frontier[last].rank < state.rank:
                last += 1
            frontier[first:last] = [state]
            ends[first:last] = [end]

    chosen: list[Placement | None] = [None] * len(entries)
    link = frontier[-1] if frontier else None
    while link is not None:
        chosen[link.position] = link.placement
        link = link.previous
    return chosen


CueKind = Literal["assigned", "out_of_order", "repeat_read", "repeat_mention", "unplaced"]

# The order the cues of one entry sort in when their times are equal.
_KIND_RANK: dict[CueKind, int] = {
    "assigned": 0,
    "out_of_order": 1,
    "repeat_read": 2,
    "repeat_mention": 3,
    "unplaced": 4,
}


@dataclass(frozen=True)
class LocatedCue:
    """One cue ``locate`` found for an entry: where it goes, or ``None`` when it wasn't found.

    ``kind`` says how the placement was reached: ``assigned`` by the in-order assignment,
    ``out_of_order`` by the pass of section 4.5, ``repeat_read`` and ``repeat_mention`` by the
    pass of section 4.6, and ``unplaced`` when nothing was found. An entry can have several cues,
    but only one of them is ``assigned``, ``out_of_order`` or ``unplaced``.

    ``verse_starts`` holds ``(verse number, source seconds)`` for each verse of a multi-verse
    entry that the reading matched, in verse order, when the placement has a text candidate. It is
    empty for a single-verse entry and for a mention-only placement (section 4.7).
    """

    entry_index: int
    placement: Placement | None
    kind: CueKind
    verse_starts: tuple[tuple[int, float], ...] = ()


@dataclass(frozen=True)
class LocateResult:
    """The cues, sorted by time with unplaced ones last, and the detections they used.

    ``consumed_detection_ids`` are the ids of the detections that a cue's placement holds, in the
    order of the ``detections`` given to ``locate``. A detection that no cue holds is not in it,
    so the pipeline can build the ``not_in_export`` cues from the others.
    """

    cues: list[LocatedCue]
    consumed_detection_ids: tuple[str, ...]


def _detection_ids(placements: Iterable[Placement | None]) -> set[str]:
    """The ids of the detections that ``placements`` hold as their mention."""
    return {p.mention.detection.id for p in placements if p is not None and p.mention is not None}


def _without_used_mention(placement: Placement, used: set[str]) -> Placement:
    """``placement`` with its mention dropped when another placement already holds it.

    A mention can be a candidate of several entries, for example "James 1" for two entries of that
    chapter, but a detection joins one cue at most. The text stays: it is a reading of its own.
    """
    text = placement.text
    if text is None or placement.mention is None or placement.mention.detection.id not in used:
        return placement
    return Placement(placement.entry_index, text.coverage, text.read_start_s, text=text)


def _coverage(placement: Placement | None) -> float:
    return 0.0 if placement is None or placement.text is None else placement.text.coverage


def _release_shared_readings(chosen: list[Placement | None]) -> None:
    """Take a reading away from the weaker of two entries whose placements share words.

    ``assign`` only orders placements by time, so two entries with overlapping text, such as
    John 3:16-17 and John 3:17, can both be placed on the same words. Of two such placements the
    higher coverage keeps the words, and the lower entry index on a tie; the other falls back to
    its mention, or is left unplaced. Its time doesn't change, so the order of ``assign`` holds.
    """
    kept: list[tuple[int, int]] = []
    for k in sorted(range(len(chosen)), key=lambda k: (-_coverage(chosen[k]), k)):
        placement = chosen[k]
        if placement is None or placement.text is None:
            continue
        span = placement.text.word_span
        if not any(_spans_overlap(span, other) for other in kept):
            kept.append(span)
        elif placement.mention is None:
            chosen[k] = None
        else:
            mention = placement.mention
            chosen[k] = Placement(
                placement.entry_index, mention.score, mention.mention_start_s, mention=mention
            )


def _move_out_of_order(
    candidates: Sequence[Sequence[Placement]],
    chosen: list[Placement | None],
    kinds: list[CueKind],
    threshold: float,
) -> None:
    """Section 4.5: in file order, move each entry without a strong reading to one it has.

    An entry qualifies when it is unplaced or has no text placement with coverage of at least
    ``threshold``. It moves to its best text candidate of that coverage (ties: the earliest) whose
    words no other placement holds. A mention never moves an entry, and the mention an entry
    leaves behind is free again for the later passes.
    """
    for k, pool in enumerate(candidates):
        current = chosen[k]
        if current is not None and current.text is not None and current.text.coverage >= threshold:
            continue
        others = [p for j, p in enumerate(chosen) if j != k]
        taken = [p.word_span for p in others if p is not None and p.word_span is not None]
        readings = [
            (c.text, c)
            for c in pool
            if c.text is not None
            and c.text.coverage >= threshold
            and not any(_spans_overlap(c.text.word_span, span) for span in taken)
        ]
        if not readings:
            continue
        _, best = min(readings, key=lambda r: (-r[0].coverage, r[0].read_start_s, r[0].word_span))
        chosen[k] = _without_used_mention(best, _detection_ids(others))
        kinds[k] = "out_of_order"


def _find_repeats(
    entries: Sequence[ExportEntry],
    candidates: Sequence[Sequence[Placement]],
    chosen: Sequence[Placement | None],
    detections: Sequence[Detection],
    cfg: LocateConfig,
) -> tuple[list[LocatedCue], set[str]]:
    """Section 4.6: the cues for a scripture the pastor went back to with no new slide.

    Only an entry with a placement has repeats. Returns the new cues and the ids of every
    detection that is now held: by ``chosen``, by a repeat, or absorbed because it introduces a
    reading. All entries are served in file order, so when two entries match the same words or
    the same detection (two slides of one scripture), the lower entry index gets the cue.

    A re-read is an unused text candidate with coverage of at least ``read_coverage_threshold``
    and ``repeat_min_matched_tokens`` matched tokens, on words no cue holds yet. A repeat mention
    is an unused detection with a verse that matches the entry. The spec leaves some cases open:

    - A detection in the merge window of any reading of an entry that matches it (the entry's
      first reading, or a re-read) introduces that reading, so it is absorbed: no cue, and it
      counts as consumed. This comes before the other tests, so the entry whose reading it
      introduces gets it, not a lower entry that also matches. A ``suppressed_duplicate`` one in
      a window is absorbed too, since it is the same mention heard again.
    - Outside a window, a ``suppressed_duplicate`` or chapter-only detection is not a repeat and
      is not consumed. A mention is never a repeat for an entry with no placement.
    - Which of an entry's readings is the re-read follows ``assign`` (the better score), not the
      clock.
    """
    threshold = cfg.align.read_coverage_threshold
    placed = [k for k, p in enumerate(chosen) if p is not None]
    taken = [p.word_span for p in chosen if p is not None and p.word_span is not None]
    used = _detection_ids(chosen)
    readings: dict[int, list[TextCandidate]] = {
        k: [p.text] for k, p in enumerate(chosen) if p is not None and p.text is not None
    }
    repeats: list[LocatedCue] = []

    for k in placed:
        pool = [(c.text, c) for c in candidates[k] if c.text is not None]
        for text, reading in sorted(pool, key=lambda r: (r[0].read_start_s, r[0].word_span)):
            if text.coverage < threshold or text.matched < cfg.repeat_min_matched_tokens:
                continue
            if any(_spans_overlap(text.word_span, span) for span in taken):
                continue
            placement = _without_used_mention(reading, used)
            taken.append(text.word_span)
            used |= _detection_ids([placement])
            readings.setdefault(k, []).append(text)
            repeats.append(LocatedCue(entries[k].index, placement, "repeat_read"))

    for detection in sorted(detections, key=lambda d: (d.candidate.source_start, d.id)):
        if detection.id in used or detection.reference.verse is None:
            continue
        matching = [
            k for k in placed if _reference_matches(entries[k].reference, detection.reference)
        ]
        if not matching:
            continue
        start = detection.candidate.source_start
        if any(
            _in_merge_window(start, text, cfg) for k in matching for text in readings.get(k, ())
        ):
            used.add(detection.id)
            continue
        if FLAG_SUPPRESSED in detection.flags:
            continue
        entry = entries[matching[0]]
        mention = _mention(entry.index, detection, cfg)
        placement = Placement(entry.index, mention.score, mention.mention_start_s, mention=mention)
        repeats.append(LocatedCue(entry.index, placement, "repeat_mention"))
        used.add(detection.id)
    return repeats, used


_VERSE_NUMBER = re.compile(r"\s*([0-9]+)")


def _verses(entry: ExportEntry) -> list[tuple[int, int]]:
    """The verses of ``entry`` as ``(number, content tokens)``, in order.

    A verse line starts with its number. A line that doesn't, or whose number isn't above the one
    before, continues the verse before it, as a wrapped line does.
    """
    verses: list[list[int]] = []
    for line in entry.lines:
        count = len(normalise_verse([line]))
        head = _VERSE_NUMBER.match(line)
        number = int(head.group(1)) if head else None
        if verses and (number is None or number <= verses[-1][0]):
            verses[-1][1] += count
        else:
            first = entry.reference.verse
            verses.append([number if number is not None else first or 1, count])
    return [(number, count) for number, count in verses]


def _verse_starts(
    entry: ExportEntry, text: TextCandidate, tokens: Sequence[AToken], cfg: LocateConfig
) -> tuple[tuple[int, float], ...]:
    """When each verse of a reading starts: its first matched token (14 section 4.7).

    The reading is found again with ``align_from`` from ``text.start_token``, which gives the run
    that ``text_candidates`` scored, and ``matched_at`` says which transcript token matched each
    verse token. A verse with no matched token gets no time.
    """
    verses = _verses(entry)
    if len(verses) < 2:
        return ()
    verse = normalise_verse(entry.lines)
    window = tokens[text.start_token : text.start_token + _run_span(len(verse))]
    run = align_from(verse, window, 0, cfg.align)
    if run.matched != text.matched:
        raise ValueError("tokens are not the ones the candidates were found in")
    # first[v] is the index of verse v's first token among the verse tokens.
    first = [0, *accumulate(count for _, count in verses)]
    starts: dict[int, float] = {}
    for verse_token, window_token in run.matched_at:
        number = verses[bisect_right(first, verse_token) - 1][0]
        starts.setdefault(number, window[window_token].start)
    return tuple(sorted(starts.items()))


def _with_verse_starts(
    cue: LocatedCue, entry: ExportEntry, tokens: Sequence[AToken], cfg: LocateConfig
) -> LocatedCue:
    placement = cue.placement
    if placement is None or placement.text is None:
        return cue
    return replace(cue, verse_starts=_verse_starts(entry, placement.text, tokens, cfg))


def _order_key(cue: LocatedCue) -> tuple[int, float, int, int, tuple[int, int]]:
    """Placed cues by time, then entry, kind and words; unplaced cues after them, by entry."""
    placement = cue.placement
    if placement is None:
        return (1, 0.0, cue.entry_index, _KIND_RANK[cue.kind], (0, 0))
    span = placement.word_span or (-1, -1)
    return (0, placement.time_s, cue.entry_index, _KIND_RANK[cue.kind], span)


def locate(
    entries: Sequence[ExportEntry],
    candidates: Sequence[Sequence[Placement]],
    tokens: Sequence[AToken],
    detections: Sequence[Detection],
    cfg: LocateConfig = LocateConfig(),
) -> LocateResult:
    """Every cue the scripture file gives, found in the transcript (14 sections 4.4 to 4.7).

    ``candidates`` are the placements of each entry in file order, from ``build_candidates``, and
    ``tokens`` are the alignment tokens they were found in.
    ``assign`` runs first and isn't changed: the passes after it only use what it left over. Then
    each entry that is unplaced or has no strong reading moves to one it has (section 4.5, with
    ``read_coverage_threshold`` from ``cfg.align``), and the readings and verse mentions still
    unused become repeats (section 4.6). No two cues hold the same words, and no detection joins
    more than one cue.

    The cues are sorted by time, unplaced last, so the result is the same for the same input.
    """
    chosen = assign(entries, candidates)
    _release_shared_readings(chosen)
    kinds: list[CueKind] = ["unplaced" if p is None else "assigned" for p in chosen]
    _move_out_of_order(candidates, chosen, kinds, cfg.align.read_coverage_threshold)
    repeats, consumed = _find_repeats(entries, candidates, chosen, detections, cfg)

    cues = [
        LocatedCue(entry.index, placement, kind)
        for entry, placement, kind in zip(entries, chosen, kinds, strict=True)
    ]
    cues.extend(repeats)
    cues.sort(key=_order_key)
    by_index = {entry.index: entry for entry in entries}
    cues = [_with_verse_starts(cue, by_index[cue.entry_index], tokens, cfg) for cue in cues]
    return LocateResult(cues, tuple(d.id for d in detections if d.id in consumed))
