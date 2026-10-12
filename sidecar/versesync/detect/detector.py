"""Stages 3 and 4 of reference detection: canon validation, confidence, duplicate suppression
(docs/04-reference-detection.md sections 5 and 6).

Input is T-12's :class:`~versesync.detect.grammar.Detection` records, which are *not* validated
against the canon. This module:

1. **Validates** each reading (the primary and every alternative) against the canon and drops
   the impossible ones. A detection with no valid reading is discarded; "Jude 5:1" and
   "John 3:100" never reach the editor. When the primary reading is impossible but an
   alternative is valid, the alternative is promoted.
2. **Scores** every survivor in ``[0, 1]``. Confidence drives flagging only: nothing here ever
   discards a detection because its score is low (decision D4).
3. **Suppresses duplicates**: an identical reference inside the cooldown of the last kept
   mention is marked ``suppressed`` and retained, never deleted (FR-3.6).

Everything is pure arithmetic over the inputs, so the same transcript gives the same scores
every time (docs/05 section 10).

Confidence weights and structure scores
=======================================

The numbers below are **specified-initial** values: they come from docs/04 section 6 as written
and have not been tuned. Task T-34 owns the tuning pass against the fixture corpus and will
change them here, in this one place. The same applies to the amber threshold (open question
Q-E, specified at 0.55) and to the per-edit fuzzy penalty, which the spec describes only as
"scaled by distance".
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field, replace

from versesync.detect.canon import Canon, load_canon
from versesync.detect.fuzzy import BookMatcher
from versesync.detect.grammar import (
    Alternative,
    Detection,
    GrammarConfig,
    GrammarResult,
    Reference,
    match_grammar,
)
from versesync.detect.normalize import Normalized, WordLike

# -- specified-initial constants (docs/04 section 6; T-34 tunes them) ------------------------

#: confidence = clamp01(W_BOOK * book + W_ASR * asr + W_STRUCTURE * structure + W_VALIDATION *
#: validation). Specified-initial, docs/04 section 6; not yet tuned (T-34).
WEIGHT_BOOK = 0.40
WEIGHT_ASR = 0.25
WEIGHT_STRUCTURE = 0.25
WEIGHT_VALIDATION = 0.10

#: book_score per book_match tier. Specified-initial, docs/04 section 6.
BOOK_SCORE_EXACT = 1.0
BOOK_SCORE_ALIAS = 0.85
BOOK_SCORE_FUZZY = 0.65
#: A fuzzy match is "scaled by distance" (docs/04 section 6) without a formula. Initial form:
#: each edit beyond the first costs this much of the fuzzy score. Not tuned (T-34).
FUZZY_DISTANCE_STEP = 0.10

#: structure_score. Specified-initial, docs/04 section 6.
STRUCTURE_VERSE = 1.0  # book + chapter + verse
STRUCTURE_RANGE = 0.75  # book + chapter + verse range
STRUCTURE_CHAPTER_ONLY = 0.55
STRUCTURE_CONTEXT = 0.45  # book and chapter carried from an earlier mention (P11/P12)

#: validation_score. Specified-initial, docs/04 section 6.
VALIDATION_FULL = 1.0
VALIDATION_ALTERNATIVE = 0.5  # valid only after an alternative reading was promoted

#: Added by the timing stage (T-18) when a read span is found for the reference
#: (docs/04 section 6). Specified-initial.
CORROBORATION_BONUS = 0.10

#: Amber low-confidence flag (FR-6.5). Specified at 0.55; open question Q-E, resolved by T-34.
DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.55
#: A verse range longer than this is a mis-parse (docs/04 section 5). Specified.
DEFAULT_MAX_RANGE = 30
#: Identical references closer together than this collapse to the first (FR-3.6). Specified.
DEFAULT_DUPLICATE_COOLDOWN_S = 60.0

FLAG_LOW_CONFIDENCE = "low_confidence"
FLAG_CHAPTER_ONLY = "chapter_only"
FLAG_SUPPRESSED_DUPLICATE = "suppressed_duplicate"

_SCORE_DECIMALS = 4


@dataclass(frozen=True)
class DetectorConfig:
    max_range: int = DEFAULT_MAX_RANGE
    duplicate_cooldown_s: float = DEFAULT_DUPLICATE_COOLDOWN_S
    low_confidence_threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD


# -- output types ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConfidenceBreakdown:
    """The four terms of the section 6 formula, before weighting."""

    book: float
    asr: float
    structure: float
    validation: float

    @property
    def total(self) -> float:
        raw = (
            WEIGHT_BOOK * self.book
            + WEIGHT_ASR * self.asr
            + WEIGHT_STRUCTURE * self.structure
            + WEIGHT_VALIDATION * self.validation
        )
        return round(clamp01(raw), _SCORE_DECIMALS)


@dataclass(frozen=True)
class ScoredAlternative:
    reference: Reference
    reason: str
    confidence: float


@dataclass(frozen=True)
class ScoredDetection:
    """A validated, scored detection. ``detection`` carries the validated reference and
    alternatives (an impossible primary replaced by its first valid alternative)."""

    detection: Detection
    confidence: float
    breakdown: ConfidenceBreakdown
    alternatives: tuple[ScoredAlternative, ...]
    suppressed: bool = False
    corroborated: bool = False
    flags: tuple[str, ...] = field(default=())

    @property
    def reference(self) -> Reference:
        return self.detection.reference


@dataclass(frozen=True)
class DetectorResult:
    normalized: Normalized
    detections: tuple[ScoredDetection, ...]


# -- helpers --------------------------------------------------------------------------------


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


# -- stage 3: canon validation --------------------------------------------------------------


def validate_reference(ref: Reference, canon: Canon, max_range: int) -> Reference | None:
    """Return ``ref`` with its range repaired, or ``None`` when it is impossible.

    * book not in the canon, chapter past the book's last, or a verse past the chapter's last
      -> ``None``;
    * ``verse_end < verse`` -> swapped if the swap validates, otherwise the end is dropped;
    * a range with no length, past the chapter, or wider than ``max_range`` -> the end is
      dropped (a mis-parse), the start verse stands.
    """
    book = canon.by_osis(ref.osis)
    if book is None or not canon.is_valid(book, ref.chapter, ref.verse):
        return None
    if ref.verse is None:
        return replace(ref, verse_end=None)
    if ref.verse_end is None:
        return ref
    lo, hi = sorted((ref.verse, ref.verse_end))
    # A reversed range is swapped only when the swap validates; both ends are then in the chapter.
    swappable = ref.verse_end >= ref.verse or canon.is_valid(book, ref.chapter, ref.verse_end)
    if swappable and lo < hi and hi - lo <= max_range and canon.is_valid(book, ref.chapter, hi):
        return replace(ref, verse=lo, verse_end=hi)
    return replace(ref, verse_end=None)


def validate_detection(
    det: Detection, canon: Canon, max_range: int = DEFAULT_MAX_RANGE
) -> tuple[Detection, bool] | None:
    """Validate every reading of ``det``.

    Returns ``(detection, promoted)`` where ``detection`` holds only valid readings, in the
    grammar's order, and ``promoted`` is True when the primary reading was impossible and an
    alternative took its place. ``None`` when no reading is valid.
    """
    readings: list[tuple[Reference, str]] = [(det.reference, "")]
    readings.extend((a.reference, a.reason) for a in det.alternatives)
    kept: list[tuple[Reference, str]] = []
    first_survives = False
    for index, (ref, reason) in enumerate(readings):
        fixed = validate_reference(ref, canon, max_range)
        if fixed is None or any(fixed == k[0] for k in kept):
            continue
        first_survives = first_survives or index == 0
        kept.append((fixed, reason))
    if not kept:
        return None
    primary = kept[0][0]
    alternatives = tuple(Alternative(ref, reason) for ref, reason in kept[1:])
    return replace(det, reference=primary, alternatives=alternatives), not first_survives


# -- stage 4: confidence --------------------------------------------------------------------


def book_score(tier: str, distance: int) -> float:
    if tier == "exact":
        return BOOK_SCORE_EXACT
    if tier == "alias":
        return BOOK_SCORE_ALIAS
    extra_edits = max(distance - 1, 0)
    return max(0.0, BOOK_SCORE_FUZZY * (1.0 - FUZZY_DISTANCE_STEP * extra_edits))


def structure_score(ref: Reference, contextual: bool) -> float:
    if contextual:
        return STRUCTURE_CONTEXT
    if ref.verse is None:
        return STRUCTURE_CHAPTER_ONLY
    if ref.verse_end is not None:
        return STRUCTURE_RANGE
    return STRUCTURE_VERSE


def confidence_breakdown(
    det: Detection, ref: Reference, promoted: bool = False
) -> ConfidenceBreakdown:
    """The section 6 terms for reading ``ref`` of ``det``."""
    return ConfidenceBreakdown(
        book=book_score(det.book_match.tier, det.book_match.distance),
        asr=clamp01(det.mean_word_prob),
        structure=structure_score(ref, det.contextual),
        validation=VALIDATION_ALTERNATIVE if promoted else VALIDATION_FULL,
    )


def _flags(
    det: Detection, confidence: float, suppressed: bool, threshold: float
) -> tuple[str, ...]:
    flags: list[str] = []
    if confidence < threshold:
        flags.append(FLAG_LOW_CONFIDENCE)
    if det.chapter_only:
        flags.append(FLAG_CHAPTER_ONLY)
    if suppressed:
        flags.append(FLAG_SUPPRESSED_DUPLICATE)
    return tuple(flags)


def score_detection(
    det: Detection, promoted: bool = False, config: DetectorConfig | None = None
) -> ScoredDetection:
    """Score one validated detection. Never discards, whatever the score."""
    cfg = config or DetectorConfig()
    breakdown = confidence_breakdown(det, det.reference, promoted)
    confidence = breakdown.total
    alternatives: list[ScoredAlternative] = []
    ceiling = confidence
    for alt in det.alternatives:
        own = confidence_breakdown(det, alt.reference, promoted=True).total
        # An alternative never outranks the reading the grammar preferred.
        ceiling = min(ceiling, own)
        alternatives.append(ScoredAlternative(alt.reference, alt.reason, ceiling))
    return ScoredDetection(
        detection=det,
        confidence=confidence,
        breakdown=breakdown,
        alternatives=tuple(alternatives),
        flags=_flags(det, confidence, False, cfg.low_confidence_threshold),
    )


def apply_corroboration(
    scored: ScoredDetection, config: DetectorConfig | None = None
) -> ScoredDetection:
    """The hook for T-18: add the +0.10 bonus once a read span is found for the reference.

    Idempotent (a second call changes nothing) and re-evaluates the low-confidence flag, so a
    corroborated cue that crosses the threshold loses its amber flag.
    """
    if scored.corroborated:
        return scored
    cfg = config or DetectorConfig()
    confidence = round(clamp01(scored.confidence + CORROBORATION_BONUS), _SCORE_DECIMALS)
    return replace(
        scored,
        confidence=confidence,
        corroborated=True,
        flags=_flags(scored.detection, confidence, scored.suppressed, cfg.low_confidence_threshold),
    )


# -- duplicate suppression ------------------------------------------------------------------


def suppress_duplicates(
    scored: Sequence[ScoredDetection], config: DetectorConfig | None = None
) -> tuple[ScoredDetection, ...]:
    """Mark repeats of a reference inside the cooldown as suppressed.

    Nothing is removed; rows come back in transcript order (start time, then token span). A
    mention is a repeat when the *last kept* mention of the same reference started no more than
    the cooldown earlier (inclusive: exactly the cooldown is still a repeat); a suppressed
    mention does not extend the window, so a speaker who keeps circling back gets a fresh cue
    once the window has passed.
    """
    cfg = config or DetectorConfig()
    last_kept: dict[Reference, float] = {}
    out: list[ScoredDetection] = []
    for item in sorted(scored, key=lambda s: (s.detection.source_start, s.detection.token_span)):
        ref = item.reference
        start = item.detection.source_start
        previous = last_kept.get(ref)
        if previous is not None and start - previous <= cfg.duplicate_cooldown_s:
            flags = _flags(item.detection, item.confidence, True, cfg.low_confidence_threshold)
            out.append(replace(item, suppressed=True, flags=flags))
        else:
            last_kept[ref] = start
            out.append(item)
    return tuple(out)


# -- the whole stage ------------------------------------------------------------------------


def validate_and_score(
    detections: Sequence[Detection],
    *,
    config: DetectorConfig | None = None,
    canon: Canon | None = None,
) -> tuple[ScoredDetection, ...]:
    """Validate, score and de-duplicate grammar detections (stages 3 and 4)."""
    cfg = config or DetectorConfig()
    canon = canon or load_canon()
    scored: list[ScoredDetection] = []
    for det in detections:
        checked = validate_detection(det, canon, cfg.max_range)
        if checked is None:
            continue
        valid, promoted = checked
        scored.append(score_detection(valid, promoted, cfg))
    return suppress_duplicates(scored, cfg)


def detect_references(
    words: Sequence[WordLike],
    *,
    config: DetectorConfig | None = None,
    grammar_config: GrammarConfig | None = None,
    canon: Canon | None = None,
    matcher: BookMatcher | None = None,
) -> DetectorResult:
    """Words in, validated and scored detections out (stages 1 to 4)."""
    canon = canon or load_canon()
    grammar: GrammarResult = match_grammar(
        words, config=grammar_config, canon=canon, matcher=matcher
    )
    return DetectorResult(
        grammar.normalized, validate_and_score(grammar.detections, config=config, canon=canon)
    )
