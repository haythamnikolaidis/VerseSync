from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from transcript_fixtures import FIXTURES_DIR

from versesync.bible.local import LocalProvider
from versesync.config import Config, load_config
from versesync.cues import validate_document
from versesync.jobs import JobService
from versesync.server import SidecarServer
from versesync.transcribe import Backend, FakeBackend, get_backend
from versesync.types import load_words

TOKEN = "test-token"
ORIGIN = "cep://com.versesync.panel"
WORDS_FILE = FIXTURES_DIR / "numbers-and-ordinals.words.json"
TRANSLATION_ID = LocalProvider().list_translations()[0].id


def call(
    server: SidecarServer, path: str, *, method: str = "GET", body: Any = None
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}",
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def wait_for(server: SidecarServer, job_id: str, states: set[str]) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        _, snap = call(server, f"/jobs/{job_id}")
        if snap["status"] in states:
            return dict(snap)
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached {states}")


class Harness:
    def __init__(self, app_home: Path, tmp_path: Path) -> None:
        self.app_home = app_home
        self.tmp_path = tmp_path
        self.servers: list[tuple[SidecarServer, threading.Thread]] = []
        self.media = tmp_path / "media" / "sermon.mxf"
        self.media.parent.mkdir()
        self.media.write_bytes(b"pretend media" * 50)

    def start(
        self,
        *,
        roots: list[str] | None = None,
        backend_factory: Callable[[], Backend] | None = None,
    ) -> SidecarServer:
        base = load_config()
        config: Config = replace(
            base,
            transcription={**base.transcription, "backend": f"fixture:{WORDS_FILE}"},
            server={**base.server, "allowed_media_roots": roots or []},
        )
        server = SidecarServer(config, TOKEN)
        factory = backend_factory or (lambda: get_backend(config))
        server.attach_jobs(
            JobService(config=config, backend_factory=factory, provider=LocalProvider())
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server

    def request(self, **extra: Any) -> dict[str, Any]:
        return {"media_path": str(self.media), "translation_id": TRANSLATION_ID, **extra}


@pytest.fixture
def harness(app_home: Path, tmp_path: Path) -> Iterator[Harness]:
    h = Harness(app_home, tmp_path)
    yield h
    for server, thread in h.servers:
        server.shutdown()
        thread.join(timeout=5)


def test_full_lifecycle_gives_schema_valid_document(harness: Harness) -> None:
    server = harness.start()
    status, started = call(server, "/jobs", method="POST", body=harness.request())
    assert status == 202
    assert started["status"] == "queued"
    assert started["cache_hit"] is False
    assert started["job_id"].startswith("job_")
    assert isinstance(started["estimated_duration_s"], int)

    snap = wait_for(server, started["job_id"], {"done", "failed"})
    assert snap["status"] == "done"
    assert snap["progress"] == 1.0

    status, doc = call(server, f"/jobs/{started['job_id']}/result")
    assert status == 200
    validate_document(doc)
    assert doc["cues"]

    status, words = call(server, f"/jobs/{started['job_id']}/transcript")
    assert status == 200
    assert len(words) == len(load_words(WORDS_FILE))
    assert set(words[0]) == {"text", "start", "end", "probability"}


def test_second_run_reports_cache_hit(harness: Harness) -> None:
    server = harness.start()
    _, first = call(server, "/jobs", method="POST", body=harness.request())
    wait_for(server, first["job_id"], {"done"})
    status, second = call(server, "/jobs", method="POST", body=harness.request())
    assert status == 202
    assert second["cache_hit"] is True
    assert wait_for(server, second["job_id"], {"done"})["status"] == "done"
    _, uncached = call(
        server, "/jobs", method="POST", body=harness.request(options={"use_cache": False})
    )
    assert uncached["cache_hit"] is False


def test_result_and_transcript_are_409_before_done(harness: Harness) -> None:
    release = threading.Event()
    server = harness.start(
        backend_factory=lambda: FakeBackend(
            load_words(WORDS_FILE), on_tick=lambda tick: release.wait(10)
        )
    )
    _, started = call(server, "/jobs", method="POST", body=harness.request())
    job_id = started["job_id"]
    try:
        for suffix in ("/result", "/transcript"):
            status, body = call(server, f"/jobs/{job_id}{suffix}")
            assert status == 409
            assert body["error"]["code"] == "job_not_finished"
    finally:
        release.set()
    wait_for(server, job_id, {"done"})
    assert call(server, f"/jobs/{job_id}/result")[0] == 200


def test_delete_running_job_leads_to_cancelled(harness: Harness) -> None:
    release = threading.Event()
    server = harness.start(
        backend_factory=lambda: FakeBackend(
            load_words(WORDS_FILE), on_tick=lambda tick: release.wait(10)
        )
    )
    _, started = call(server, "/jobs", method="POST", body=harness.request())
    job_id = started["job_id"]
    status, body = call(server, f"/jobs/{job_id}", method="DELETE")
    assert (status, body["status"]) == (200, "cancelling")
    release.set()
    assert wait_for(server, job_id, {"cancelled", "failed", "done"})["status"] == "cancelled"
    assert call(server, f"/jobs/{job_id}/result")[0] == 409


def test_delete_finished_job_discards_it(harness: Harness) -> None:
    server = harness.start()
    _, started = call(server, "/jobs", method="POST", body=harness.request())
    job_id = started["job_id"]
    wait_for(server, job_id, {"done"})
    status, body = call(server, f"/jobs/{job_id}", method="DELETE")
    assert (status, body["status"]) == (200, "discarded")
    status, body = call(server, f"/jobs/{job_id}")
    assert (status, body["error"]["code"]) == (404, "job_not_found")
    assert not (harness.app_home / "jobs" / job_id).exists()


def test_unknown_job_is_404(harness: Harness) -> None:
    server = harness.start()
    for method, suffix in (("GET", ""), ("GET", "/result"), ("GET", "/transcript"), ("DELETE", "")):
        status, body = call(server, f"/jobs/job_nope{suffix}", method=method)
        assert (status, body["error"]["code"]) == (404, "job_not_found")


def test_missing_media_is_media_not_found(harness: Harness) -> None:
    server = harness.start()
    body = harness.request(media_path=str(harness.tmp_path / "gone.mxf"))
    status, err = call(server, "/jobs", method="POST", body=body)
    assert (status, err["error"]["code"]) == (404, "media_not_found")


def test_media_root_check(harness: Harness) -> None:
    inside = harness.start(roots=[str(harness.media.parent)])
    assert call(inside, "/jobs", method="POST", body=harness.request())[0] == 202

    elsewhere = harness.tmp_path / "other"
    elsewhere.mkdir()
    outside = harness.start(roots=[str(elsewhere)])
    status, err = call(outside, "/jobs", method="POST", body=harness.request())
    assert (status, err["error"]["code"]) == (400, "bad_request")

    # A path that climbs out of the allowed root with ".." is still outside it.
    sneaky = str(harness.media.parent / ".." / "media" / ".." / "media" / "sermon.mxf")
    narrow = harness.start(roots=[str(harness.media.parent / "nowhere")])
    status, err = call(narrow, "/jobs", method="POST", body=harness.request(media_path=sneaky))
    assert (status, err["error"]["code"]) == (400, "bad_request")


@pytest.mark.parametrize(
    "body",
    [
        {"translation_id": TRANSLATION_ID},
        {"media_path": 5, "translation_id": TRANSLATION_ID},
        {"media_path": "x"},
        {"media_path": "x", "translation_id": TRANSLATION_ID, "options": []},
        [],
    ],
)
def test_malformed_start_is_bad_request(harness: Harness, body: Any) -> None:
    server = harness.start()
    status, err = call(server, "/jobs", method="POST", body=body)
    assert (status, err["error"]["code"]) == (400, "bad_request")


def test_unavailable_backend_fails_the_job_not_the_start(harness: Harness) -> None:
    base = load_config()
    config = replace(base, transcription={**base.transcription, "backend": "faster_whisper"})
    server = harness.start(backend_factory=lambda: get_backend(config))
    status, started = call(server, "/jobs", method="POST", body=harness.request())
    assert status == 202
    snap = wait_for(server, started["job_id"], {"failed", "done"})
    assert snap["status"] == "failed"
    assert snap["error"]["code"] == "backend_unavailable"
