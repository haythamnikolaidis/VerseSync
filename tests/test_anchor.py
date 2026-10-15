"""Tests for versesync.timing.anchor."""

from __future__ import annotations

import pytest

from versesync.timing.align import Alignment
from versesync.timing.anchor import TimingConfig, compute_timing, paraphrase_duration

# Expected values worked by hand from reference/verseflow/js/duration.js:
#   raw = words / 160 * 60 + 1.5, rounded half-up to 0.1, clamped to [3, 20].


@pytest.mark.parametrize(
    ("words", "expected"),
    [
        (2, 3.0),  # 2.25 -> clamped up to the 3 s floor
        (5, 3.4),  # 1.875 + 1.5 = 3.375 -> 3.4
        (10, 5.3),  # 3.75 + 1.5 = 5.25 -> half rounds up to 5.3
        (20, 9.0),  # 7.5 + 1.5
        (31, 13.1),  # 11.625 + 1.5 = 13.125 -> 13.1
        (40, 16.5),  # 15 + 1.5
        (60, 20.0),  # 24 -> clamped down to the 20 s ceiling
    ],
)
def test_paraphrase_duration_matches_verseflow(words: int, expected: float) -> None:
    assert paraphrase_duration(words, TimingConfig()) == expected


def _read(start: float, end: float) -> Alignment:
    return Alignment("read", 0.95, start, end, (0, 9))


_PARAPHRASE = Alignment("paraphrase", 0.3, None, None, None)


def test_mention_first_anchors_on_mention() -> None:
    timing = compute_timing(100.0, _read(103.0, 115.0), 20, 0.8)
    assert timing.source_anchor_s == 99.5
    assert timing.source_duration_s == 16.5  # (115 - 99.5) + 1.0
    assert timing.confidence == pytest.approx(0.9)


def test_reading_first_anchors_on_reading() -> None:
    timing = compute_timing(110.0, _read(104.0, 118.0), 20, 0.8)
    assert timing.source_anchor_s == 103.5
    assert timing.source_duration_s == 15.5  # (118 - 103.5) + 1.0


def test_reading_beyond_lookbehind_is_ignored_for_anchor() -> None:
    timing = compute_timing(130.0, _read(105.0, 140.0), 20, 0.8)
    assert timing.source_anchor_s == 129.5
    assert timing.source_duration_s == 11.5  # (140 - 129.5) + 1.0


def test_reading_exactly_at_lookbehind_counts() -> None:
    timing = compute_timing(130.0, _read(110.0, 140.0), 20, 0.8)
    assert timing.source_anchor_s == 109.5


def test_anchor_never_negative() -> None:
    timing = compute_timing(0.2, _read(0.5, 10.0), 20, 0.5)
    assert timing.source_anchor_s == 0.0
    assert timing.source_duration_s == 11.0


def test_read_duration_capped_at_45_seconds() -> None:
    timing = compute_timing(100.0, _read(101.0, 400.0), 20, 0.5)
    assert timing.source_duration_s == 45.0


def test_read_duration_floored_at_minimum() -> None:
    timing = compute_timing(100.0, _read(100.5, 101.0), 20, 0.5)
    assert timing.source_duration_s == 3.0


def test_paraphrase_with_body_uses_reading_speed() -> None:
    timing = compute_timing(50.0, _PARAPHRASE, 20, 0.7)
    assert timing.source_anchor_s == 49.5
    assert timing.source_duration_s == 9.0
    assert timing.confidence == 0.7


def test_no_body_uses_fixed_duration() -> None:
    assert compute_timing(50.0, None, None, 0.7).source_duration_s == 8.0
    assert compute_timing(50.0, _PARAPHRASE, None, 0.7).source_duration_s == 8.0


def test_fixed_mode_ignores_alignment() -> None:
    cfg = TimingConfig(duration_mode="fixed", fixed_duration_s=6.0)
    assert compute_timing(50.0, _read(51.0, 70.0), 20, 0.7, cfg).source_duration_s == 6.0
    assert compute_timing(50.0, _PARAPHRASE, 20, 0.7, cfg).source_duration_s == 6.0


def test_confidence_bonus_capped_at_one() -> None:
    assert compute_timing(50.0, _read(51.0, 60.0), 20, 0.97).confidence == 1.0
