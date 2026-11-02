"""Locate scripture-file entries in the transcript (docs/14 sections 4.1 to 4.4).

Each entry gets candidate placements from two sources, its text read aloud (``text_candidates``)
and the references spoken near it (``mention_candidates``). ``merge`` joins the two for one entry,
and ``assign`` picks at most one placement per entry across the whole file, in file order.

Everything here is in source seconds and deterministic (05 section 10): no clock, no randomness,
and no result depends on dict or set iteration order.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, fields

from versesync.config import Config
from versesync.detect.detector import Detection
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

    cap = 3 * len(verse) + 30
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
        MentionCandidate(
            entry_index=entry.index,
            detection=d,
            score=cfg.mention_weight * d.confidence,
            mention_start_s=d.candidate.source_start,
        )
        for d in detections
        if _reference_matches(entry.reference, d.reference)
    ]
    found.sort(key=lambda m: (m.mention_start_s, m.detection.id))
    return found


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
        window = [
            m
            for m in free
            if candidate.read_start_s - cfg.merge_before_s
            <= m.mention_start_s
            <= candidate.read_start_s + cfg.merge_after_s
        ]
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
