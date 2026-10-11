"""Validate a Cue Document against schemas/cue-document.schema.json (T-37).

Usable as a library (``validate()`` / ``validate_file()``) or as a CLI:

    python tools/validate_cue_document.py tests/fixtures/cue-documents/*.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "cue-document.schema.json"


def load_schema() -> dict[str, Any]:
    with SCHEMA_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate(document: dict[str, Any]) -> list[str]:
    """Return a list of human-readable error messages; empty means valid."""
    validator = Draft202012Validator(load_schema())
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.path))
    return [f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors]


def validate_file(path: Path) -> list[str]:
    with Path(path).open("r", encoding="utf-8") as f:
        document = json.load(f)
    return validate(document)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args(argv)

    failed = False
    for path in args.files:
        errors = validate_file(path)
        if errors:
            failed = True
            print(f"FAIL {path}")
            for error in errors:
                print(f"  {error}")
        else:
            print(f"OK   {path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
