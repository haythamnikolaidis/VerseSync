import hashlib
import json
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from versesync.bible import factory
from versesync.cli import main
from versesync.cues import validate_document

FIXTURE = Path(__file__).parent / "fixtures" / "transcripts" / "numbers-and-ordinals.words.json"
EXPORT_TRANSCRIPT = Path(__file__).parent / "fixtures" / "transcripts" / "service-export.words.json"
EXPORT_FILE = Path(__file__).parent / "fixtures" / "scripture_files" / "service-export.txt"
API_FIXTURES = Path(__file__).parent / "fixtures" / "api_bible"


def test_detect_prints_json_list(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["detect", str(FIXTURE)]) == 0
    detections = json.loads(capsys.readouterr().out)
    assert detections and detections[0]["id"] == "det_001"
    assert {"reference", "token_span", "confidence"} <= detections[0].keys()


def test_detect_writes_out_file(tmp_path: Path) -> None:
    out = tmp_path / "detections.json"
    assert main(["detect", str(FIXTURE), "--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))[0]["id"] == "det_001"


def test_detect_missing_file_is_bad_input(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["detect", str(tmp_path / "nope.json")]) == 2
    assert "nope.json" in capsys.readouterr().err


def test_resolve_prints_passage(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["resolve", "Romans 8:28", "--translation", "kjv"]) == 0
    passage = json.loads(capsys.readouterr().out)
    assert passage["reference"]["osis"] == "Rom"
    assert passage["reference"]["verse"] == 28
    assert passage["source"] == "local"


def test_resolve_with_the_api_provider_marks_the_text_as_from_a_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("VERSESYNC_API_BIBLE_KEY", "sk-test-not-a-real-key")
    routes = {"/bibles": "bibles.json", "/passages/JHN.3.16": "passage_single.json"}

    def fake_fetch(
        url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, dict[str, Any]]:
        name = next(name for suffix, name in routes.items() if url.split("?")[0].endswith(suffix))
        return 200, json.loads((API_FIXTURES / name).read_text(encoding="utf-8"))

    monkeypatch.setattr(factory, "urllib_fetch_json", fake_fetch)
    config = tmp_path / "api.yaml"
    config.write_text("bible:\n  provider: api_bible\n", encoding="utf-8")
    args = ["resolve", "John 3:16", "--translation", "kjv", "--config", str(config)]
    assert main(args) == 0
    passage = json.loads(capsys.readouterr().out)
    assert passage["source"] == "provider"
    assert passage["reference"]["verse"] == 16


def _api_bible_config_without_a_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("VERSESYNC_API_BIBLE_KEY", raising=False)

    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    config = tmp_path / "api.yaml"
    text = "bible:\n  provider: api_bible\n  default_translation: nkjv\n"
    config.write_text(text, encoding="utf-8")
    return config


def test_resolve_with_the_api_provider_and_no_key_is_an_input_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    config = _api_bible_config_without_a_key(tmp_path, monkeypatch)
    assert main(["resolve", "John 3:16", "--config", str(config)]) == 2
    captured = capsys.readouterr()
    assert "No API.Bible key" in captured.err
    assert captured.out == ""


def test_analyse_with_the_api_provider_and_no_key_flags_every_cue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _api_bible_config_without_a_key(tmp_path, monkeypatch)
    out = tmp_path / "cues.json"
    assert main(["analyse", str(FIXTURE), "--out", str(out), "--config", str(config)]) == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    validate_document(doc)
    verse_cues = [c for c in doc["cues"] if "chapter_only" not in c["flags"]]
    assert verse_cues
    for cue in verse_cues:
        assert "text_unavailable" in cue["flags"]
    assert all(c["body"] == "" for c in doc["cues"])
    assert all(c["reference_display"].endswith("(NKJV)") for c in verse_cues)


def test_resolve_invalid_reference_exits_2(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["resolve", "Jude 5:1"]) == 2
    captured = capsys.readouterr()
    assert "Jude has only 1 chapter." in captured.err
    assert captured.out == ""


def test_resolve_unknown_translation_exits_2(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["resolve", "John 3:16", "--translation", "nope"]) == 2
    assert capsys.readouterr().err


def test_analyse_words_json_is_schema_valid_and_deterministic(
    app_home: Path, tmp_path: Path
) -> None:
    args = ["--job-id", "job_CLI", "--generated-at", "2026-01-01T00:00:00Z"]
    first = tmp_path / "a" / "cues.json"
    second = tmp_path / "b" / "cues.json"
    assert main(["analyse", str(FIXTURE), "--out", str(first), *args]) == 0
    assert main(["analyse", str(FIXTURE), "--out", str(second), *args]) == 0
    doc = json.loads(first.read_text(encoding="utf-8"))
    validate_document(doc)
    assert doc["job"]["id"] == "job_CLI"
    assert doc["generated_at"] == "2026-01-01T00:00:00Z"
    assert doc["cues"]
    assert first.read_bytes() == second.read_bytes()
    assert (first.parent / doc["transcript"]["words_ref"]).is_file()
    assert not (app_home / "jobs" / "job_CLI").exists()


def test_analyse_missing_media_exits_2(
    app_home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = tmp_path / "cfg.yaml"
    config.write_text("transcription:\n  backend: fake\n", encoding="utf-8")
    out = tmp_path / "cues.json"
    args = ["analyse", str(tmp_path / "gone.mxf"), "--out", str(out), "--config", str(config)]
    assert main(args) == 2
    assert "could not be found" in capsys.readouterr().err
    assert not out.exists()


def test_analyse_media_without_a_backend_exits_2(
    app_home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    media = tmp_path / "sermon.mxf"
    media.write_bytes(b"media")
    assert main(["analyse", str(media), "--out", str(tmp_path / "cues.json")]) == 2
    assert "faster-whisper" in capsys.readouterr().err


def _analyse_with(
    tmp_path: Path, scripture_file: Path, capsys: pytest.CaptureFixture[str]
) -> tuple[int, str, Path]:
    out = tmp_path / "cues.json"
    args = ["analyse", str(EXPORT_TRANSCRIPT), "--out", str(out)]
    code = main([*args, "--scripture-file", str(scripture_file)])
    return code, capsys.readouterr().err, out


def test_analyse_with_a_scripture_file_gives_a_1_1_document(
    app_home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, _, out = _analyse_with(tmp_path, EXPORT_FILE, capsys)
    assert code == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    validate_document(doc)
    assert doc["schema_version"] == "1.1"
    assert doc["scripture_file"] == {
        "path": str(EXPORT_FILE.resolve()),
        "sha256": hashlib.sha256(EXPORT_FILE.read_bytes()).hexdigest(),
        "entry_count": 8,
    }


def test_analyse_scripture_file_not_found_exits_2(
    app_home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, err, out = _analyse_with(tmp_path, tmp_path / "gone.txt", capsys)
    assert code == 2
    assert "gone.txt" in err and "could not be found" in err
    assert not out.exists()


def test_analyse_scripture_file_unreadable_exits_2(
    app_home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    binary = tmp_path / "binary.txt"
    binary.write_bytes(b"\xff\xfe not utf-8 \x80")
    code, err, out = _analyse_with(tmp_path, binary, capsys)
    assert code == 2
    assert "binary.txt" in err and "could not be read" in err
    assert "Traceback" not in err
    assert not out.exists()


def test_analyse_scripture_file_empty_exits_2(
    app_home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    empty = tmp_path / "empty.txt"
    empty.write_text("Notes with no scripture in them\n", encoding="utf-8")
    code, err, out = _analyse_with(tmp_path, empty, capsys)
    assert code == 2
    assert "empty.txt" in err and "no scripture entries" in err
    assert not out.exists()
