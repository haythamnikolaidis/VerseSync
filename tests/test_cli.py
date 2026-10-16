import json
from pathlib import Path

import pytest

from versesync.cli import main
from versesync.cues import validate_document

FIXTURE = Path(__file__).parent / "fixtures" / "transcripts" / "numbers-and-ordinals.words.json"


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
