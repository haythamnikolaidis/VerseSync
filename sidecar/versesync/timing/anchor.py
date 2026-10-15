"""Cue anchors, durations and final confidence (05 sections 2, 3 and 9).

Everything here is in source seconds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

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
