import json
from pathlib import Path

import pytest
from validate_cue_document import validate

from versesync.detect.canon import load_canon
from versesync.scripture_file import ScriptureFileEmpty, parse_scripture_file

FIXTURES = Path(__file__).parent / "fixtures" / "scripture_files"
SAMPLE = FIXTURES / "sample-scriptures.txt"
SERVICE = FIXTURES / "service-export.txt"


def test_sample_matches_verseflow_parser_output() -> None:
    entries, warnings = parse_scripture_file(SAMPLE, load_canon())
    expected = json.loads((FIXTURES / "sample-scriptures.expected.json").read_text("utf-8"))
    actual = [
        {
            "reference_line": e.reference_line,
            "translation": e.translation,
            "body": e.body,
            "word_count": e.word_count,
        }
        for e in entries
    ]
    assert actual == expected
    assert len(entries) == 7
    assert warnings == []
    assert [e.index for e in entries] == list(range(7))


def test_reference_is_canon_validated() -> None:
    entries, _ = parse_scripture_file(SAMPLE, load_canon())
    ref = entries[2].reference
    assert (ref.osis, ref.chapter, ref.verse, ref.verse_end) == ("1Cor", 13, 4, 7)
    assert entries[0].lines[0].startswith("2 My brethren")


def test_bom_and_crlf_make_no_difference(tmp_path: Path) -> None:
    text = SAMPLE.read_text(encoding="utf-8")
    variant = tmp_path / "bom-crlf.txt"
    variant.write_bytes(b"\xef\xbb\xbf" + text.replace("\n", "\r\n").encode("utf-8"))
    canon = load_canon()
    assert parse_scripture_file(variant, canon) == parse_scripture_file(SAMPLE, canon)


def test_service_export_keeps_repeats_and_warns_with_line_numbers() -> None:
    entries, warnings = parse_scripture_file(SERVICE, load_canon())
    assert [e.reference_line for e in entries] == [
        "James 1:2-4 (KJV)",
        "Ezekiel 36:26 (KJV)",
        "John 3:16 (WEB)",
        "James 1:4 (KJV)",
        "Psalm 91:15 (KJV)",
        "Psalm 23:1 (WEB)",
        "Psalm 91:15 (KJV)",
        "Romans 8:28 (WEB)",
    ]
    assert [e.index for e in entries] == list(range(8))
    assert entries[4].body == entries[6].body
    assert {e.translation for e in entries} == {"KJV", "WEB"}
    lines = SERVICE.read_text("utf-8").split("\n")
    assert [(w.code, w.line) for w in warnings] == [
        ("export_block_unreferenced", 1),
        ("export_reference_invalid", lines.index("Hezekiah 3:4 (KJV)") + 1),
    ]
    assert all(f"Line {w.line}:" in w.message for w in warnings)


def test_invalid_book_block_is_skipped(tmp_path: Path) -> None:
    path = tmp_path / "one.txt"
    path.write_text("Hezekiah 3:4 (KJV)\n4 Nope.\n\nJohn 3:16 (KJV)\n16 Text here.\n", "utf-8")
    entries, warnings = parse_scripture_file(path, load_canon())
    assert [e.reference_line for e in entries] == ["John 3:16 (KJV)"]
    assert [(w.code, w.line) for w in warnings] == [("export_reference_invalid", 1)]


def test_stray_lines_after_a_blank_are_unreferenced(tmp_path: Path) -> None:
    path = tmp_path / "stray.txt"
    path.write_text("John 3:16 (KJV)\n16 Text.\n\nOrphan one\nOrphan two\n", "utf-8")
    entries, warnings = parse_scripture_file(path, load_canon())
    assert len(entries) == 1
    assert [(w.code, w.line) for w in warnings] == [
        ("export_block_unreferenced", 4),
        ("export_block_unreferenced", 5),
    ]


@pytest.mark.parametrize(
    "content", ["", "\n\n", "﻿", "just a stray line\n", "Hezekiah 3:4 (KJV)\n4 Nope.\n"]
)
def test_file_without_a_valid_entry_is_empty(tmp_path: Path, content: str) -> None:
    path = tmp_path / "empty.txt"
    path.write_text(content, "utf-8")
    with pytest.raises(ScriptureFileEmpty) as exc:
        parse_scripture_file(path, load_canon())
    assert exc.value.code == "scripture_file_empty"


def test_warnings_serialise_into_a_valid_1_1_cue_document() -> None:
    _, warnings = parse_scripture_file(SERVICE, load_canon())
    document = json.loads(
        (Path(__file__).parent / "fixtures" / "cue-documents" / "empty.json").read_text("utf-8")
    )
    document["schema_version"] = "1.1"
    document["warnings"] = [w.to_json() for w in warnings]
    assert [w["line"] for w in document["warnings"]] == [w.line for w in warnings]
    assert validate(document) == []
