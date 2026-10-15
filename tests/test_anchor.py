"""Tests for versesync.timing.anchor."""

from __future__ import annotations

import pytest

from versesync.timing.anchor import TimingConfig, paraphrase_duration

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
