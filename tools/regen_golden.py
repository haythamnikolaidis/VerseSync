"""Regenerate tests/golden/<name>.cues.json from the T-41 transcript fixtures.

Usage: python tools/regen_golden.py

Runs the pipeline from each stored word array against the local Bible provider (no
Whisper, no GPU, no network) with a fixed job id and timestamp, so the output is a
reviewable diff whenever detection, resolution or timing changes (11-testing.md section 4).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from versesync.bible.base import Translation
from versesync.bible.local import LocalProvider
from versesync.pipeline import run_pipeline
from versesync.types import load_words

ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ROOT / "tests" / "fixtures" / "transcripts"
GOLDEN_DIR = ROOT / "tests" / "golden"

# Fixed so that golden files never change because of the clock.
GENERATED_AT = "2026-09-14T10:00:00Z"


def fixture_names() -> list[str]:
    return sorted(p.name[: -len(".words.json")] for p in FIXTURES_DIR.glob("*.words.json"))


def golden_path(name: str) -> Path:
    return GOLDEN_DIR / f"{name}.cues.json"


def build_document(name: str) -> dict[str, Any]:
    provider = LocalProvider()
    translation: Translation = provider.list_translations()[0]
    job: dict[str, Any] = {
        "id": f"job_golden_{name}",
        "media_path": f"D:/Sermons/{name}.MXF",
        "media_hash": "sha256:" + "ab" * 32,
        "media_duration_s": 600.0,
        "model": "distil-large-v3",
        "quantization": "float16",
        "device": "cpu",
        "language": "en",
        "options": {},
    }
    words = load_words(FIXTURES_DIR / f"{name}.words.json")
    return run_pipeline(
        words,
        translation=translation,
        provider=provider,
        job=job,
        generated_at=GENERATED_AT,
    )


def render(name: str) -> str:
    """The exact text written to the golden file (indented JSON, LF line endings)."""
    return json.dumps(build_document(name), indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    for name in fixture_names():
        # newline="" keeps LF on Windows so the files are byte-identical everywhere.
        with golden_path(name).open("w", encoding="utf-8", newline="") as f:
            f.write(render(name))
        print(f"wrote {golden_path(name).relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
