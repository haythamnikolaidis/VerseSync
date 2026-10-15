"""GET /jobs/{id}/transcript on the mock sidecar (T-50, D22)."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from typing import Any

import mock_sidecar
import pytest

TOKEN = "test-token"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Origin": "http://localhost"}


@pytest.fixture()
def base_url() -> Iterator[str]:
    args = mock_sidecar.build_arg_parser().parse_args(
        ["--duration", "0.6", "--no-lock-file", "--scenario", "happy"]
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), mock_sidecar.Handler)
    server.state = mock_sidecar.State(args, TOKEN)  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def request(
    url: str, method: str = "GET", body: dict[str, Any] | None = None
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = dict(HEADERS)
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def wait_until_done(base_url: str, job_id: str) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        _, snapshot = request(f"{base_url}/jobs/{job_id}")
        if snapshot["status"] == "done":
            return
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def test_transcript_is_409_before_done_then_covers_every_word_span(base_url: str) -> None:
    status, started = request(
        f"{base_url}/jobs",
        "POST",
        {"media_path": "D:/x.mxf", "translation_id": "de4e12af7f28f599-02"},
    )
    assert status == 202
    job_id = started["job_id"]

    status, body = request(f"{base_url}/jobs/{job_id}/transcript")
    assert status == 409
    assert body["error"]["code"] == "job_not_finished"

    wait_until_done(base_url, job_id)

    status, words = request(f"{base_url}/jobs/{job_id}/transcript")
    assert status == 200
    _, document = request(f"{base_url}/jobs/{job_id}/result")
    max_span_end = max(
        cue["detection"]["word_span"][1] for cue in document["cues"] if "detection" in cue
    )
    assert isinstance(words, list)
    assert len(words) > max_span_end
    assert words[0] == {"text": "word0", "start": 0.0, "end": 0.4, "probability": 0.95}
    assert words[5]["text"] == "word5"
    assert words[5]["start"] == pytest.approx(2.0)


def test_transcript_for_unknown_job_is_404(base_url: str) -> None:
    status, body = request(f"{base_url}/jobs/job_missing/transcript")
    assert status == 404
    assert body["error"]["code"] == "job_not_found"
