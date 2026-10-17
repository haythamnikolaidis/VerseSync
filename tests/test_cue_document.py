import copy
import json
from pathlib import Path

import pytest

from versesync.bible.base import Translation
from versesync.cues import (
    SCHEMA_VERSION,
    InvalidCueDocument,
    build_document,
    read_document,
    validate_document,
    write_document,
)
from versesync.types import Word

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "cue-documents" / "happy-18-cues.json"
KJV = Translation(
    id="de4e12af7f28f599-02",
    abbreviation="KJV",
    name="King James Version",
    attribution="Public domain.",
)
WORDS = [Word("Turn", 0.0, 0.4, 0.99), Word("to", 0.4, 0.6, 0.97), Word("Romans", 0.6, 1.2, 0.95)]


def _build() -> dict:
    src = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return build_document(
        job=src["job"],
        translation=KJV,
        cues=src["cues"],
        warnings=src["warnings"],
        word_count=len(WORDS),
        words_ref=src["transcript"]["words_ref"],
        generated_at=src["generated_at"],
    )


def test_document_validates() -> None:
    doc = _build()
    assert doc["schema_version"] == SCHEMA_VERSION
    validate_document(doc)


def test_missing_required_key_raises() -> None:
    doc = _build()
    bad = copy.deepcopy(doc)
    del bad["transcript"]
    with pytest.raises(InvalidCueDocument):
        validate_document(bad)
    with pytest.raises(InvalidCueDocument):
        build_document(
            job={},
            translation=KJV,
            cues=[],
            warnings=[],
            word_count=0,
            words_ref="t.json",
            generated_at="2026-01-01T00:00:00Z",
        )


def test_write_read_round_trip(tmp_path: Path) -> None:
    doc = _build()
    out = tmp_path / "doc.json"
    write_document(doc, WORDS, out)
    assert read_document(out) == doc
    assert list(read_document(out)) == list(doc)


def test_transcript_is_sibling_not_inlined(tmp_path: Path) -> None:
    doc = _build()
    out = tmp_path / "sub" / "doc.json"
    write_document(doc, WORDS, out)
    sibling = out.parent / doc["transcript"]["words_ref"]
    assert sibling.is_file()
    words = json.loads(sibling.read_text(encoding="utf-8"))
    assert [w["text"] for w in words] == ["Turn", "to", "Romans"]
    assert '"probability"' not in out.read_text(encoding="utf-8")
    assert "words" not in doc["transcript"]


def test_schema_copies_identical() -> None:
    packaged = ROOT / "sidecar" / "versesync" / "data" / "cue-document.schema.json"
    repo = ROOT / "schemas" / "cue-document.schema.json"
    assert packaged.read_bytes() == repo.read_bytes()
