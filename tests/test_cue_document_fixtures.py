import copy
import json
from pathlib import Path

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


def test_p13_pattern_is_accepted() -> None:
    with (FIXTURES_DIR / "happy-18-cues.json").open("r", encoding="utf-8") as f:
        document = json.load(f)

    document["cues"][0]["detection"]["pattern"] = "P13"
    assert validate(document) == []

    document["cues"][0]["detection"]["pattern"] = "P14"
    assert any("pattern" in e for e in validate(document))


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
