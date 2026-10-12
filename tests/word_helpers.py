"""Small builders for synthetic transcripts shared by the detection tests."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class W:
    text: str
    start: float = 0.0
    end: float = 0.0
    probability: float = 0.9


def words(*parts: str | float, step: float = 0.4, prob: float = 0.9) -> list[W]:
    """Words from strings (split on spaces); a float part advances the clock by that many s."""
    out: list[W] = []
    t = 0.0
    for part in parts:
        if isinstance(part, float):
            t += part
            continue
        for text in part.split():
            out.append(W(text, round(t, 4), round(t + step * 0.75, 4), prob))
            t += step
    return out
