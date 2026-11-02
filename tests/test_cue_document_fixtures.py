import copy
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from validate_cue_document import validate, validate_file

from versesync.cues import DISABLED_BY_DEFAULT
from versesync.detect.canon import load_canon
from versesync.scripture_file import parse_scripture_file

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "cue-documents"
SERVICE_EXPORT = (
    Path(__file__).resolve().parent / "fixtures" / "scripture_files" / "service-export.txt"
)
FIXTURES = [
    "happy-18-cues.json",
    "flagged.json",
    "alternatives.json",
    "empty.json",
    "export.json",
]
V1_FIXTURES = [name for name in FIXTURES if name != "export.json"]


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


# ---- the export golden document ----------------------------------------------------------------


def _export() -> dict[str, Any]:
    with (FIXTURES_DIR / "export.json").open("r", encoding="utf-8") as f:
        document: dict[str, Any] = json.load(f)
    return document


def test_export_fixture_uses_every_1_1_field() -> None:
    document = _export()
    cues = document["cues"]
    assert document["schema_version"] == "1.1"
    assert set(document["scripture_file"]) == {"path", "sha256", "entry_count"}
    assert {c["text_source"]["kind"] for c in cues if "text_source" in c} == {"export", "provider"}
    assert any("entry_index" in c["text_source"] for c in cues)
    assert any("verse_offsets_s" in c for c in cues)
    assert {f for c in cues for f in c["flags"]} == set(NEW_FLAGS)
    assert {w["code"] for w in document["warnings"]} == {INVALID, UNREFERENCED}
    assert all(isinstance(w["line"], int) for w in document["warnings"])


def test_export_fixture_cues_start_enabled_or_disabled_by_their_flags() -> None:
    for cue in _export()["cues"]:
        assert cue["enabled"] is not any(f in DISABLED_BY_DEFAULT for f in cue["flags"]), cue["id"]


def test_export_fixture_matches_the_service_export_it_names() -> None:
    document = _export()
    entries, warnings = parse_scripture_file(SERVICE_EXPORT, load_canon())
    digest = hashlib.sha256(SERVICE_EXPORT.read_bytes()).hexdigest()
    assert document["scripture_file"]["sha256"] == digest
    assert document["scripture_file"]["entry_count"] == len(entries)
    assert document["warnings"] == [w.to_json() for w in warnings]
    exported = [c for c in document["cues"] if c["text_source"]["kind"] == "export"]
    for cue in exported:
        entry = entries[cue["text_source"]["entry_index"]]
        assert cue["reference_display"] == entry.reference_line, cue["id"]
        assert cue["text_source"]["translation"] == entry.translation, cue["id"]
        assert cue["body"] == entry.body, cue["id"]
        assert cue["body_word_count"] == entry.word_count, cue["id"]
        assert cue["reference"] == entry.reference.to_json(), cue["id"]
    # Every entry is placed at least once, whether or not the audio had it.
    assert {c["text_source"]["entry_index"] for c in exported} == {e.index for e in entries}


def test_export_fixture_verse_offsets_sit_inside_the_reading() -> None:
    for cue in _export()["cues"]:
        offsets = cue.get("verse_offsets_s", {})
        for verse, offset in offsets.items():
            start = cue["source_anchor_s"] + offset
            assert cue["read_start_s"] <= start <= cue["read_end_s"], (cue["id"], verse)
            assert cue["reference"]["verse"] < int(verse) <= cue["reference"]["verse_end"]


@pytest.mark.parametrize("name", V1_FIXTURES)
def test_1_0_fixtures_hold_no_1_1_field(name: str) -> None:
    with (FIXTURES_DIR / name).open("r", encoding="utf-8") as f:
        document = json.load(f)
    assert document["schema_version"] == "1.0"
    assert "scripture_file" not in document
    for cue in document["cues"]:
        assert not {"text_source", "verse_offsets_s"} & set(cue)
        assert not set(NEW_FLAGS) & set(cue["flags"])
    assert not any("line" in w for w in document["warnings"])
