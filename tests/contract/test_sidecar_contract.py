"""The sidecar contract (docs/07-sidecar-api.md §1-4), asserted by shape, status and order.

The same tests run against ``tools/mock_sidecar.py`` and, from T-42.2, the real sidecar. They
never assert on cue content: the mock serves fixtures and the real sidecar serves detections.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import pytest
from conftest import MEDIA_FILE, Response, Sidecar
from validate_cue_document import validate

ERROR_CODES = {
    "bad_request",
    "unauthorized",
    "media_not_found",
    "media_unreadable",
    "model_load_failed",
    "transcription_failed",
    "provider_unavailable",
    "translation_not_licensed",
    "job_not_found",
    "job_not_finished",
    "cancelled",
    "internal",
}
PHASES = ["hashing", "transcribing", "detecting", "resolving", "timing"]
JOB_STATUSES = {"queued", "running", "done", "failed", "cancelled"}
HEALTH_STATUSES = {"starting", "ready", "busy", "degraded"}

# (method, path, body) for every authenticated route that can be probed without side effects.
PROTECTED_ROUTES: list[tuple[str, str, Any]] = [
    ("GET", "/models", None),
    ("GET", "/translations", None),
    ("POST", "/jobs", {"media_path": "x", "translation_id": "kjv"}),
    ("GET", "/jobs/job_unknown", None),
    ("GET", "/jobs/job_unknown/events", None),
    ("GET", "/jobs/job_unknown/result", None),
    ("GET", "/jobs/job_unknown/transcript", None),
    ("DELETE", "/jobs/job_unknown", None),
    ("POST", "/resolve", {"reference": "Romans 8:28"}),
]


def require_keys(body: Any, keys: list[str], where: str) -> None:
    assert isinstance(body, dict), f"{where}: expected an object, got {type(body).__name__}"
    missing = [k for k in keys if k not in body]
    assert not missing, f"{where}: missing required keys {missing}"


def check_error(resp: Response, status: int, code: str | None = None) -> None:
    assert resp.status == status, (resp.status, resp.body)
    require_keys(resp.body, ["error"], "error envelope")
    require_keys(resp.body["error"], ["code", "message", "retryable"], "error")
    assert resp.body["error"]["code"] in ERROR_CODES, resp.body["error"]["code"]
    assert isinstance(resp.body["error"]["message"], str)
    assert isinstance(resp.body["error"]["retryable"], bool)
    if code is not None:
        assert resp.body["error"]["code"] == code


def check_health(resp: Response) -> None:
    assert resp.status == 200
    require_keys(
        resp.body,
        ["status", "api_version", "sidecar_version", "device", "provider", "active_jobs"],
        "/health",
    )
    assert resp.body["status"] in HEALTH_STATUSES
    require_keys(resp.body["provider"], ["id", "reachable"], "/health provider")


def check_models(resp: Response) -> None:
    assert resp.status == 200
    require_keys(resp.body, ["models"], "/models")
    assert resp.body["models"], "/models: empty list"
    for model in resp.body["models"]:
        require_keys(
            model, ["name", "word_timestamp_quality", "downloaded", "recommended"], "model"
        )


def check_translations(resp: Response) -> None:
    assert resp.status == 200
    require_keys(resp.body, ["provider", "translations"], "/translations")
    assert resp.body["translations"], "/translations: empty list"
    for t in resp.body["translations"]:
        require_keys(
            t, ["id", "abbreviation", "name", "attribution", "cache_allowed"], "translation"
        )


def check_job_accepted(resp: Response) -> None:
    assert resp.status == 202
    require_keys(resp.body, ["job_id", "status", "cache_hit", "estimated_duration_s"], "POST /jobs")
    assert resp.body["status"] == "queued"


def check_job_snapshot(resp: Response) -> None:
    assert resp.status == 200
    require_keys(
        resp.body,
        ["job_id", "status", "phase", "progress", "elapsed_s", "eta_s", "message", "error"],
        "GET /jobs/{id}",
    )
    assert resp.body["status"] in JOB_STATUSES
    assert resp.body["phase"] is None or resp.body["phase"] in PHASES
    assert 0.0 <= resp.body["progress"] <= 1.0


# Each check paired with the request that produces its response, so one parametrised test
# can both pass them against a healthy server and fail them against a drifted one.
EndpointCheck = tuple[str, str, Any, Callable[[Response], None], list[str]]
ENDPOINT_CHECKS: list[EndpointCheck] = [
    ("GET", "/health", None, check_health, ["status", "api_version", "provider"]),
    ("GET", "/models", None, check_models, ["models"]),
    ("GET", "/translations", None, check_translations, ["provider", "translations"]),
    (
        "POST",
        "/jobs",
        {"media_path": str(MEDIA_FILE), "translation_id": "kjv"},
        check_job_accepted,
        ["job_id", "status", "cache_hit"],
    ),
]


def _ids(checks: list[EndpointCheck]) -> list[str]:
    return [f"{c[0]} {c[1]}" for c in checks]


# ---- headers and authentication -----------------------------------------------------------


@pytest.mark.parametrize("method,path,body,check,keys", ENDPOINT_CHECKS, ids=_ids(ENDPOINT_CHECKS))
def test_endpoint_shape_and_api_header(
    sidecar: Sidecar,
    method: str,
    path: str,
    body: Any,
    check: Callable[[Response], None],
    keys: list[str],
) -> None:
    resp = sidecar.request(method, path, body=body)
    check(resp)
    assert re.fullmatch(r"\d+\.\d+", resp.headers.get("x-versesync-api", "")), resp.headers


@pytest.mark.parametrize("method,path,body,check,keys", ENDPOINT_CHECKS, ids=_ids(ENDPOINT_CHECKS))
def test_deleting_a_required_key_fails_the_suite(
    sidecar: Sidecar,
    method: str,
    path: str,
    body: Any,
    check: Callable[[Response], None],
    keys: list[str],
) -> None:
    for key in keys:

        def drop(_m: str, _p: str, parsed: Any, key: str = key) -> Any:
            return {k: v for k, v in parsed.items() if k != key}

        sidecar.response_hook = drop
        with pytest.raises(AssertionError):
            check(sidecar.request(method, path, body=body))


def test_error_check_fails_when_envelope_key_is_deleted(sidecar: Sidecar) -> None:
    def drop_code(_m: str, _p: str, parsed: Any) -> Any:
        parsed["error"].pop("code")
        return parsed

    sidecar.response_hook = drop_code
    with pytest.raises(AssertionError):
        check_error(sidecar.request("GET", "/jobs/job_unknown"), 404)


def test_health_needs_no_token(sidecar: Sidecar) -> None:
    check_health(sidecar.request("GET", "/health", token=None))


@pytest.mark.parametrize("method,path,body", PROTECTED_ROUTES)
def test_requires_valid_token_and_origin(
    sidecar: Sidecar, method: str, path: str, body: Any
) -> None:
    for kwargs in ({"token": None}, {"token": "wrong-token"}, {"origin": None}):
        resp = sidecar.request(method, path, body=body, **kwargs)
        assert resp.status == 401, (kwargs, resp.status)
        assert resp.raw == b"", f"401 must carry no body, got {resp.raw!r}"


# ---- reference data and error envelope -----------------------------------------------------


def test_models(sidecar: Sidecar) -> None:
    check_models(sidecar.request("GET", "/models"))


def test_translations(sidecar: Sidecar) -> None:
    check_translations(sidecar.request("GET", "/translations"))


def test_post_jobs_without_required_fields_is_bad_request(sidecar: Sidecar) -> None:
    check_error(sidecar.request("POST", "/jobs", body={}), 400, "bad_request")


def test_unknown_job_is_job_not_found(sidecar: Sidecar) -> None:
    for suffix in ("", "/result", "/transcript"):
        check_error(sidecar.request("GET", f"/jobs/job_unknown{suffix}"), 404, "job_not_found")
    check_error(sidecar.request("DELETE", "/jobs/job_unknown"), 404, "job_not_found")


def test_resolve_unparseable_reference_is_a_typed_error(sidecar: Sidecar) -> None:
    resp = sidecar.request("POST", "/resolve", body={"reference": "not a reference at all"})
    assert 400 <= resp.status < 500, resp.status
    check_error(resp, resp.status)


def test_resolve_known_reference_returns_a_passage(sidecar: Sidecar) -> None:
    resp = sidecar.request("POST", "/resolve", body={"reference": "Romans 8:28"})
    assert resp.status == 200, resp.body
    require_keys(
        resp.body,
        ["reference_display", "body", "verses", "word_count", "translation", "truncated"],
        "/resolve",
    )
    assert isinstance(resp.body["verses"], list)


# ---- the job lifecycle ---------------------------------------------------------------------


def test_job_snapshot(sidecar: Sidecar, finished_job: str) -> None:
    resp = sidecar.request("GET", f"/jobs/{finished_job}")
    check_job_snapshot(resp)
    assert resp.body["job_id"] == finished_job
    assert resp.body["status"] == "done"
    assert resp.body["progress"] == 1.0


def test_sse_is_progress_then_done(sidecar: Sidecar) -> None:
    job_id = sidecar.start_job()
    events = sidecar.sse(f"/jobs/{job_id}/events")
    names = [name for name, _ in events]
    assert names, "no events"
    assert names[-1] == "done", names
    assert names[:-1] and set(names[:-1]) == {"progress"}, names
    require_keys(events[-1][1], ["job_id", "cue_count"], "done event")
    assert events[-1][1]["job_id"] == job_id

    progress = [data for name, data in events if name == "progress"]
    for data in progress:
        require_keys(data, ["phase", "progress"], "progress event")
    # Phases are a subsequence of the canonical order (a phase may be skipped, never reordered).
    indexes = [PHASES.index(d["phase"]) for d in progress]
    assert indexes == sorted(indexes), [d["phase"] for d in progress]
    values = [d["progress"] for d in progress]
    assert all(b >= a for a, b in zip(values, values[1:])), values
    assert values[-1] == 1.0, values


def test_result_is_409_until_done_then_a_valid_document(sidecar: Sidecar) -> None:
    job_id = sidecar.start_job()
    check_error(sidecar.request("GET", f"/jobs/{job_id}/result"), 409, "job_not_finished")
    sidecar.wait_for_status(job_id, "done")
    resp = sidecar.request("GET", f"/jobs/{job_id}/result")
    assert resp.status == 200
    assert validate(resp.body) == []


def test_transcript_is_409_until_done_then_an_array(sidecar: Sidecar) -> None:
    job_id = sidecar.start_job()
    check_error(sidecar.request("GET", f"/jobs/{job_id}/transcript"), 409, "job_not_finished")
    sidecar.wait_for_status(job_id, "done")
    resp = sidecar.request("GET", f"/jobs/{job_id}/transcript")
    assert resp.status == 200
    assert isinstance(resp.body, list)
    for word in resp.body:
        require_keys(word, ["text", "start", "end", "probability"], "transcript word")


def test_delete_leads_to_cancelled(sidecar: Sidecar) -> None:
    job_id = sidecar.start_job()
    resp = sidecar.request("DELETE", f"/jobs/{job_id}")
    assert resp.status == 200, resp.status
    snapshot = sidecar.wait_for_status(job_id, "cancelled")
    assert snapshot["job_id"] == job_id
    check_error(sidecar.request("GET", f"/jobs/{job_id}/result"), 409, "job_not_finished")
