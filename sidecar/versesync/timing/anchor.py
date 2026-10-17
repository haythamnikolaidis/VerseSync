"""Cue anchors, durations and final confidence (05 sections 2, 3 and 9).

Everything here is in source seconds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from versesync.timing.align import Alignment

# Reading-speed model ported from reference/verseflow/js/duration.js (resolveDurationSeconds).
_READING_WPM = 160
_ANIMATION_PAD_S = 1.5
_PARAPHRASE_MIN_S = 3.0
_PARAPHRASE_MAX_S = 20.0

CORROBORATION_BONUS = 0.10


@dataclass(frozen=True)
class TimingConfig:
    lead_in_s: float = 0.5
    tail_pad_s: float = 1.0
    duration_mode: str = "auto"  # 'auto' | 'fixed'
    fixed_duration_s: float = 8.0
    min_duration_s: float = 3.0
    max_duration_s: float = 20.0
    max_read_duration_s: float = 45.0
    read_lookbehind_s: float = 20.0


def paraphrase_duration(word_count: int, cfg: TimingConfig) -> float:
    """Reading-speed duration for a paraphrased verse body.

    Same formula as VerseFlow's duration.js: words at 160 wpm plus 1.5 s, rounded to 0.1 s
    (JS ``Math.round``, so halves round up), then clamped to the config's min/max.
    """
    raw = (word_count / _READING_WPM) * 60 + _ANIMATION_PAD_S
    rounded = math.floor(raw * 10 + 0.5) / 10
    return min(cfg.max_duration_s, max(cfg.min_duration_s, rounded))


@dataclass(frozen=True)
class Timing:
    source_anchor_s: float
    source_duration_s: float
    confidence: float


def _round_ms(seconds: float) -> float:
    return round(seconds, 3)


def compute_timing(
    mention_start_s: float,
    alignment: Alignment | None,
    body_word_count: int | None,
    confidence: float,
    cfg: TimingConfig = TimingConfig(),
) -> Timing:
    """Anchor, duration and final confidence for one cue (05 section 3)."""
    is_read = alignment is not None and alignment.classification == "read"

    earliest = mention_start_s
    if (
        alignment is not None
        and is_read
        and alignment.read_start_s is not None
        and mention_start_s - alignment.read_start_s <= cfg.read_lookbehind_s
    ):
        earliest = min(mention_start_s, alignment.read_start_s)
    anchor = max(earliest - cfg.lead_in_s, 0.0)

    if cfg.duration_mode == "fixed":
        duration = cfg.fixed_duration_s
    elif alignment is not None and is_read and alignment.read_end_s is not None:
        # Measured from the anchor, not from read_start.
        raw = (alignment.read_end_s - anchor) + cfg.tail_pad_s
        duration = min(cfg.max_read_duration_s, max(cfg.min_duration_s, raw))
    elif body_word_count is not None:
        duration = paraphrase_duration(body_word_count, cfg)
    else:
        duration = cfg.fixed_duration_s

    final_confidence = min(1.0, confidence + CORROBORATION_BONUS) if is_read else confidence
    return Timing(_round_ms(anchor), _round_ms(duration), final_confidence)
