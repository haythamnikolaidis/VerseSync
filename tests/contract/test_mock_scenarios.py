"""Every scenario of the mock sidecar (tools/mock_sidecar.py SCENARIOS), over HTTP.

The shared suite in test_sidecar_contract.py runs the mock on its default scenario. This one runs
each scenario once and asserts what a client relies on: the job's result is that scenario's
fixture, it validates against the schema, and the transcript endpoint covers every word span the
cues name. Mock only, because the real sidecar serves detections and a scenario means nothing
there.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import mock_sidecar
from conftest import Sidecar
from validate_cue_document import validate

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "cue-documents"


def _result(sidecar: Sidecar) -> dict[str, Any]:
    job_id = sidecar.start_job()
    sidecar.wait_for_status(job_id, "done")
    resp = sidecar.request("GET", f"/jobs/{job_id}/result")
    assert resp.status == 200, resp.body
    assert isinstance(resp.body, dict)
    return resp.body


def test_result_is_the_scenarios_fixture_and_validates(
    mock_scenario: tuple[str, Sidecar],
) -> None:
    scenario, sidecar = mock_scenario
    fixture = json.loads((FIXTURES / mock_sidecar.SCENARIOS[scenario]).read_text("utf-8"))
    result = _result(sidecar)
    assert validate(result) == []
    assert result["schema_version"] == fixture["schema_version"]
    assert result["cues"] == fixture["cues"]
    assert result.get("scripture_file") == fixture.get("scripture_file")
    assert result["warnings"] == fixture["warnings"]


def test_transcript_covers_every_word_span(mock_scenario: tuple[str, Sidecar]) -> None:
    _, sidecar = mock_scenario
    job_id = sidecar.start_job()
    sidecar.wait_for_status(job_id, "done")
    resp = sidecar.request("GET", f"/jobs/{job_id}/transcript")
    assert resp.status == 200
    spans = [
        c["detection"]["word_span"][1]
        for c in _result(sidecar)["cues"]
        if "detection" in c
    ]
    assert len(resp.body) > max(spans, default=-1)


def test_only_the_export_scenario_is_a_1_1_document(mock_scenario: tuple[str, Sidecar]) -> None:
    scenario, sidecar = mock_scenario
    result = _result(sidecar)
    if scenario == "export":
        assert result["schema_version"] == "1.1"
        assert result["scripture_file"]["entry_count"] == 8
        assert all("text_source" in c for c in result["cues"])
    else:
        assert result["schema_version"] == "1.0"
        assert "scripture_file" not in result
        assert not any("text_source" in c or "verse_offsets_s" in c for c in result["cues"])


def test_resolve_never_answers_with_a_scripture_files_text() -> None:
    index = mock_sidecar.build_resolve_index()
    # Ezekiel 36:26 and James 1:2-4 occur only in the export scenario, as export text.
    assert ("Ezek", 36, 26) not in index
    assert ("Jas", 1, 2) not in index
    # John 1:1 is the export scenario's provider cue, so it is a real answer.
    assert index[("John", 1, 1)]["body"].startswith("In the beginning was the Word")
    # Romans 8:28 is KJV in the happy scenario and WEB in the export one: the KJV wins.
    assert index[("Rom", 8, 28)]["body"].startswith("And we know")
