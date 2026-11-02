"""Regenerate tests/golden/<name>.cues.json from the T-41 transcript fixtures.

Usage: python tools/regen_golden.py

Runs the pipeline from each stored word array against the local Bible provider (no
Whisper, no GPU, no network) with a fixed job id and timestamp, so the output is a
reviewable diff whenever detection, resolution or timing changes (11-testing.md section 4).

A transcript with a scripture file of the same name in tests/fixtures/scripture_files/ is run
with that file's entries (docs/14-scripture-file-import.md), so its golden file is a 1.1
document. The other transcripts run without one and give the same 1.0 documents as ever.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from versesync.bible.base import Translation
from versesync.bible.local import LocalProvider
from versesync.detect.canon import load_canon
from versesync.pipeline import run_pipeline
from versesync.scripture_file import parse_scripture_file
from versesync.types import load_words

ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ROOT / "tests" / "fixtures" / "transcripts"
SCRIPTURE_FILES_DIR = ROOT / "tests" / "fixtures" / "scripture_files"
GOLDEN_DIR = ROOT / "tests" / "golden"

# Fixed so that golden files never change because of the clock.
GENERATED_AT = "2026-09-14T10:00:00Z"


def fixture_names() -> list[str]:
    return sorted(p.name[: -len(".words.json")] for p in FIXTURES_DIR.glob("*.words.json"))


def golden_path(name: str) -> Path:
    return GOLDEN_DIR / f"{name}.cues.json"


def scripture_file_path(name: str) -> Path:
    return SCRIPTURE_FILES_DIR / f"{name}.txt"


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
    export: dict[str, Any] = {}
    export_file = scripture_file_path(name)
    if export_file.is_file():
        entries, warnings = parse_scripture_file(export_file, load_canon())
        # A fixed path, like media_path: the golden file must not depend on where it was made.
        path = f"D:/Sermons/{name}/{export_file.name}"
        job["options"] = {"scripture_file": path}
        export = {
            "scripture_file": entries,
            "scripture_warnings": warnings,
            "scripture_file_block": {
                "path": path,
                "sha256": hashlib.sha256(export_file.read_bytes()).hexdigest(),
                "entry_count": len(entries),
            },
        }
    return run_pipeline(
        words,
        translation=translation,
        provider=provider,
        job=job,
        generated_at=GENERATED_AT,
        **export,
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
