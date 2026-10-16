from __future__ import annotations

import http.client
import json
import threading
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from test_job_endpoints import ORIGIN, TOKEN, WORDS_FILE, Harness, call, wait_for

from versesync.config import load_config
from versesync.server import SidecarServer
from versesync.transcribe import FakeBackend, get_backend
from versesync.types import load_words

Event = tuple[str, dict[str, Any]]


@pytest.fixture
def harness(app_home: Path, tmp_path: Path) -> Iterator[Harness]:
    h = Harness(app_home, tmp_path)
    yield h
    for server, thread in h.servers:
        server.shutdown()
        thread.join(timeout=5)


def open_stream(server: SidecarServer, job_id: str) -> http.client.HTTPResponse:
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    conn.request(
        "GET",
        f"/jobs/{job_id}/events",
        headers={"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN},
    )
    return conn.getresponse()


def read_event(resp: http.client.HTTPResponse) -> Event | None:
    """The next event of the stream, skipping comments; ``None`` once the stream has closed."""
    name: str | None = None
    data: str | None = None
    while True:
        line = resp.readline()
        if not line:
            return None
        text = line.decode("utf-8").rstrip("\r\n")
        if text.startswith(":"):
            continue
        if text.startswith("event: "):
            name = text[len("event: ") :]
        elif text.startswith("data: "):
            data = text[len("data: ") :]
        elif text == "" and name is not None and data is not None:
            return name, json.loads(data)


def read_all(resp: http.client.HTTPResponse) -> list[Event]:
    events: list[Event] = []
    while (event := read_event(resp)) is not None:
        events.append(event)
    return events


def gated_server(harness: Harness) -> tuple[SidecarServer, threading.Event]:
    release = threading.Event()
    words = load_words(WORDS_FILE)
    server = harness.start(
        backend_factory=lambda: FakeBackend(words, on_tick=lambda tick: release.wait(10))
    )
    return server, release


def start_job(server: SidecarServer, harness: Harness) -> str:
    status, started = call(server, "/jobs", method="POST", body=harness.request())
    assert status == 202
    return str(started["job_id"])


def test_sequence_is_progress_then_exactly_one_done(harness: Harness) -> None:
    server, release = gated_server(harness)
    job_id = start_job(server, harness)
    resp = open_stream(server, job_id)
    assert resp.status == 200
    assert resp.getheader("Content-Type") == "text/event-stream"
    first = read_event(resp)
    assert first is not None and first[0] == "progress"
    release.set()
    events = [first, *read_all(resp)]

    names = [name for name, _ in events]
    assert names[-1] == "done"
    assert names.count("done") == 1
    assert set(names[:-1]) == {"progress"}
    assert len(names) > 2
    assert "transcribing" in {data["phase"] for name, data in events if name == "progress"}
    _, doc = call(server, f"/jobs/{job_id}/result")
    assert events[-1][1] == {"job_id": job_id, "cue_count": len(doc["cues"])}


def test_progress_never_goes_down(harness: Harness) -> None:
    server, release = gated_server(harness)
    job_id = start_job(server, harness)
    resp = open_stream(server, job_id)
    release.set()
    values = [data["progress"] for name, data in read_all(resp) if name == "progress"]
    assert len(values) > 1
    assert values == sorted(values)
    assert all(0.0 <= v <= 1.0 for v in values)


def test_closing_the_client_halfway_leaves_the_job_running(harness: Harness) -> None:
    server, release = gated_server(harness)
    job_id = start_job(server, harness)
    resp = open_stream(server, job_id)
    assert read_event(resp) is not None
    resp.close()
    release.set()

    assert wait_for(server, job_id, {"done", "failed", "cancelled"})["status"] == "done"
    assert call(server, f"/jobs/{job_id}/result")[0] == 200
    # The state survived the dropped stream: a fresh subscriber still learns the outcome.
    assert read_all(open_stream(server, job_id))[-1][0] == "done"


def test_late_subscriber_gets_snapshot_then_terminal_event(harness: Harness) -> None:
    server = harness.start()
    job_id = start_job(server, harness)
    wait_for(server, job_id, {"done"})
    _, doc = call(server, f"/jobs/{job_id}/result")

    events = read_all(open_stream(server, job_id))
    assert [name for name, _ in events] == ["progress", "done"]
    assert events[0][1]["progress"] == 1.0
    assert events[1][1] == {"job_id": job_id, "cue_count": len(doc["cues"])}


def test_failed_job_ends_with_failed_event(harness: Harness) -> None:
    base = load_config()
    config = replace(base, transcription={**base.transcription, "backend": "faster_whisper"})
    server = harness.start(backend_factory=lambda: get_backend(config))
    job_id = start_job(server, harness)
    wait_for(server, job_id, {"failed"})

    events = read_all(open_stream(server, job_id))
    assert [name for name, _ in events] == ["progress", "failed"]
    assert events[1][1]["error"]["code"] == "backend_unavailable"


def test_cancelled_job_ends_with_failed_cancelled_event(harness: Harness) -> None:
    server, release = gated_server(harness)
    job_id = start_job(server, harness)
    resp = open_stream(server, job_id)
    assert read_event(resp) is not None
    call(server, f"/jobs/{job_id}", method="DELETE")
    release.set()

    events = read_all(resp)
    assert [name for name, _ in events if name != "progress"] == ["failed"]
    assert events[-1][1]["error"]["code"] == "cancelled"
    wait_for(server, job_id, {"cancelled"})
    late = read_all(open_stream(server, job_id))
    assert [name for name, _ in late] == ["progress", "failed"]
    assert late[1][1]["error"]["code"] == "cancelled"


def test_unknown_job_is_a_plain_404(harness: Harness) -> None:
    server = harness.start()
    status, body = call(server, "/jobs/job_missing/events")
    assert (status, body["error"]["code"]) == (404, "job_not_found")


def test_events_require_authentication(harness: Harness) -> None:
    server = harness.start()
    job_id = start_job(server, harness)
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    conn.request("GET", f"/jobs/{job_id}/events", headers={"Origin": ORIGIN})
    assert conn.getresponse().status == 401
