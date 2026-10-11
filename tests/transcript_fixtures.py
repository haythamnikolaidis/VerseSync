"""Shared loader for T-41's transcript fixtures (tests/fixtures/transcripts/)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "transcripts"

FIXTURE_NAMES = [
    "numbers-and-ordinals",
    "context-and-ambiguity",
    "read-vs-paraphrase",
    "long-sermon-filler",
]


def load_words(name: str) -> list[dict[str, Any]]:
    with (FIXTURES_DIR / f"{name}.words.json").open("r", encoding="utf-8") as f:
        return json.load(f)


def load_labels(name: str) -> list[dict[str, Any]]:
    with (FIXTURES_DIR / f"{name}.labels.json").open("r", encoding="utf-8") as f:
        return json.load(f)
