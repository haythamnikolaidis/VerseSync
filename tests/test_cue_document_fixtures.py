import copy
import json
from pathlib import Path
from typing import Any

import pytest
from validate_cue_document import validate, validate_file

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "cue-documents"
FIXTURES = [
    "happy-18-cues.json",
    "flagged.json",
    "alternatives.json",
    "empty.json",
]


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_validates(name: str) -> None:
    errors = validate_file(FIXTURES_DIR / name)
    assert errors == []


def test_corrupted_copy_fails_with_a_useful_message() -> None:
    with (FIXTURES_DIR / "happy-18-cues.json").open("r", encoding="utf-8") as f:
        document = json.load(f)

    corrupted = copy.deepcopy(document)
    corrupted["cues"][0]["classification"] = "not_a_real_classification"
    del corrupted["cues"][1]["reference"]["chapter"]
    corrupted["schema_version"] = "2.0"

    errors = validate(corrupted)
    assert len(errors) >= 3
    assert any("classification" in e for e in errors)
    assert any("chapter" in e for e in errors)
    assert any("schema_version" in e for e in errors)


# ---- Cue Document 1.1 (docs/14-scripture-file-import.md section 6) ----------------------------

SHA256 = "446e9cba88e70ae980365ca2f69ad8a9bc07a8830bb8899f9e344867e923ebd7"
DOCUMENT_KEYS = ("schema_version", "scripture_file", "warnings")
NEW_FLAGS = ["not_in_export", "not_found_in_audio", "repeat_mention", "repeat_read", "out_of_order"]

EXPORT_SOURCE = {"kind": "export", "translation": "NKJV", "entry_index": 3}
PROVIDER_SOURCE = {"kind": "provider", "translation": "KJV"}
FILE = {"path": "D:/Sermons/Scriptures.txt", "sha256": SHA256, "entry_count": 12}
PREFIXED = "sha256:" + SHA256[:57]  # 64 characters long, but not all hex digits
INVALID = "export_reference_invalid"
UNREFERENCED = "export_block_unreferenced"


def _warning(code: str, **extra: Any) -> list[dict[str, Any]]:
    return [{"code": code, "message": "m", **extra}]


def _document(changes: dict[str, Any]) -> dict[str, Any]:
    """The happy document made 1.1, with `changes` applied to the document or to its first cue."""
    with (FIXTURES_DIR / "happy-18-cues.json").open("r", encoding="utf-8") as f:
        document: dict[str, Any] = json.load(f)
    document["schema_version"] = "1.1"
    for key, value in changes.items():
        target = document if key in DOCUMENT_KEYS else document["cues"][0]
        target[key] = value
    return document


# (name, changes, valid). Mirrored in tests/cue-document-schema.test.js so that jsonschema and
# Ajv agree on every rule.
SCHEMA_1_1_CASES: list[tuple[str, dict[str, Any], bool]] = [
    ("version 1.0", {"schema_version": "1.0"}, True),
    ("version 1.1", {}, True),
    ("version 1.2", {"schema_version": "1.2"}, False),
    ("version 2.0", {"schema_version": "2.0"}, False),
    ("export text_source", {"text_source": EXPORT_SOURCE}, True),
    ("provider text_source", {"text_source": PROVIDER_SOURCE}, True),
    ("export without entry_index", {"text_source": {"kind": "export", "translation": "N"}}, False),
    ("provider with entry_index", {"text_source": {**PROVIDER_SOURCE, "entry_index": 0}}, False),
    ("text_source of another kind", {"text_source": {**EXPORT_SOURCE, "kind": "api"}}, False),
    ("text_source without translation", {"text_source": {"kind": "provider"}}, False),
    ("negative entry_index", {"text_source": {**EXPORT_SOURCE, "entry_index": -1}}, False),
    ("text_source with an extra key", {"text_source": {**EXPORT_SOURCE, "x": 1}}, False),
    ("verse_offsets_s", {"verse_offsets_s": {"7": 27.2, "8": 33.6}}, True),
    ("empty verse_offsets_s", {"verse_offsets_s": {}}, True),
    ("verse_offsets_s key 0", {"verse_offsets_s": {"0": 1.0}}, False),
    ("verse_offsets_s key not a number", {"verse_offsets_s": {"seven": 1.0}}, False),
    ("verse_offsets_s key with a leading zero", {"verse_offsets_s": {"07": 1.0}}, False),
    ("negative verse offset", {"verse_offsets_s": {"7": -0.1}}, False),
    ("verse offset not a number", {"verse_offsets_s": {"7": "27.2"}}, False),
    ("scripture_file", {"scripture_file": FILE}, True),
    ("scripture_file without sha256", {"scripture_file": {"path": "p", "entry_count": 1}}, False),
    ("scripture_file sha256 prefixed", {"scripture_file": {**FILE, "sha256": PREFIXED}}, False),
    ("scripture_file sha256 short", {"scripture_file": {**FILE, "sha256": SHA256[:40]}}, False),
    ("scripture_file with no entries", {"scripture_file": {**FILE, "entry_count": 0}}, False),
    ("scripture_file with an extra key", {"scripture_file": {**FILE, "x": 1}}, False),
    ("invalid-reference warning", {"warnings": _warning(INVALID, line=17)}, True),
    ("unreferenced warning", {"warnings": _warning(UNREFERENCED, line=1)}, True),
    ("invalid-reference warning, no line", {"warnings": _warning(INVALID)}, False),
    ("unreferenced warning, no line", {"warnings": _warning(UNREFERENCED)}, False),
    ("warning line 0", {"warnings": _warning(INVALID, line=0)}, False),
    ("other warning without a line", {"warnings": _warning("provider_partial")}, True),
    ("other warning with a line", {"warnings": _warning("provider_partial", line=4)}, True),
] + [(f"flag {flag}", {"flags": [flag]}, True) for flag in NEW_FLAGS] + [
    ("unknown flag", {"flags": ["not_a_flag"]}, False),
]


@pytest.mark.parametrize(
    ("changes", "valid"), [pytest.param(c, v, id=name) for name, c, v in SCHEMA_1_1_CASES]
)
def test_schema_1_1_rules(changes: dict[str, Any], valid: bool) -> None:
    assert (validate(_document(changes)) == []) is valid
