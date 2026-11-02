from __future__ import annotations

import hashlib
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
SCRIPTURE_FILE = Path(__file__).parent / "fixtures" / "scripture_files" / "service-export.txt"


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


def _scripture_options(path: Path) -> dict[str, Any]:
    return {"scripture_file": str(path)}


def _failed_scripture_job(harness: Harness, path: Path) -> dict[str, Any]:
    server = harness.start()
    body = harness.request(options=_scripture_options(path))
    status, started = call(server, "/jobs", method="POST", body=body)
    assert status == 202
    snap = wait_for(server, started["job_id"], {"done", "failed"})
    assert snap["status"] == "failed"
    error: dict[str, Any] = snap["error"]
    assert str(path) in error["message"]
    assert "Traceback" not in error["message"]
    return error


def test_scripture_file_job_gives_a_1_1_document_with_the_file_block(harness: Harness) -> None:
    server = harness.start()
    body = harness.request(options=_scripture_options(SCRIPTURE_FILE))
    status, started = call(server, "/jobs", method="POST", body=body)
    assert status == 202
    assert wait_for(server, started["job_id"], {"done", "failed"})["status"] == "done"
    _, doc = call(server, f"/jobs/{started['job_id']}/result")
    validate_document(doc)
    assert doc["schema_version"] == "1.1"
    assert doc["scripture_file"] == {
        "path": str(SCRIPTURE_FILE),
        "sha256": hashlib.sha256(SCRIPTURE_FILE.read_bytes()).hexdigest(),
        "entry_count": 8,
    }


def test_without_a_scripture_file_the_document_is_1_0(harness: Harness) -> None:
    server = harness.start()
    _, started = call(server, "/jobs", method="POST", body=harness.request())
    wait_for(server, started["job_id"], {"done"})
    _, doc = call(server, f"/jobs/{started['job_id']}/result")
    assert doc["schema_version"] == "1.0"
    assert "scripture_file" not in doc


def test_missing_scripture_file_is_scripture_file_not_found(harness: Harness) -> None:
    server = harness.start()
    gone = harness.tmp_path / "gone.txt"
    body = harness.request(options=_scripture_options(gone))
    status, err = call(server, "/jobs", method="POST", body=body)
    assert (status, err["error"]["code"]) == (404, "scripture_file_not_found")
    assert str(gone) in err["error"]["message"]


def test_scripture_file_outside_the_allowed_roots_is_refused(harness: Harness) -> None:
    elsewhere = harness.tmp_path / "other"
    elsewhere.mkdir()
    export = harness.tmp_path / "media" / "scriptures.txt"
    export.write_bytes(SCRIPTURE_FILE.read_bytes())
    # The media is inside the root; the export is not.
    server = harness.start(roots=[str(harness.media.parent)])
    inside = harness.request(options=_scripture_options(export))
    assert call(server, "/jobs", method="POST", body=inside)[0] == 202

    outside_export = elsewhere / "scriptures.txt"
    outside_export.write_bytes(SCRIPTURE_FILE.read_bytes())
    body = harness.request(options=_scripture_options(outside_export))
    status, err = call(server, "/jobs", method="POST", body=body)
    assert (status, err["error"]["code"]) == (404, "scripture_file_not_found")

    # Climbing out of the root with ".." is still outside it.
    sneaky = harness.media.parent / ".." / "other" / "scriptures.txt"
    status, err = call(
        server, "/jobs", method="POST", body=harness.request(options=_scripture_options(sneaky))
    )
    assert (status, err["error"]["code"]) == (404, "scripture_file_not_found")


def test_scripture_file_option_must_be_a_path(harness: Harness) -> None:
    server = harness.start()
    body = harness.request(options={"scripture_file": 5})
    status, err = call(server, "/jobs", method="POST", body=body)
    assert (status, err["error"]["code"]) == (400, "bad_request")


def test_unreadable_scripture_file_fails_the_job(harness: Harness) -> None:
    path = harness.tmp_path / "binary.txt"
    path.write_bytes(b"\xff\xfe not utf-8 \x80")
    assert _failed_scripture_job(harness, path)["code"] == "scripture_file_unreadable"


def test_scripture_file_with_no_entries_fails_the_job(harness: Harness) -> None:
    path = harness.tmp_path / "empty.txt"
    path.write_text("Notes with no scripture in them\n", encoding="utf-8")
    assert _failed_scripture_job(harness, path)["code"] == "scripture_file_empty"


class _CountingBackend:
    def __init__(self, inner: Backend) -> None:
        self.inner = inner
        self.calls = 0

    def transcribe(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        return self.inner.transcribe(*args, **kwargs)


def test_changing_only_the_scripture_file_reuses_the_cached_transcript(
    harness: Harness,
) -> None:
    counting = _CountingBackend(FakeBackend(load_words(WORDS_FILE)))
    server = harness.start(backend_factory=lambda: counting)  # type: ignore[arg-type,return-value]
    other = harness.tmp_path / "other-export.txt"
    other.write_text("John 3:16 (KJV)\n16 For God so loved the world.\n", encoding="utf-8")

    blocks = []
    for path in (SCRIPTURE_FILE, other):
        body = harness.request(options=_scripture_options(path))
        status, started = call(server, "/jobs", method="POST", body=body)
        assert status == 202
        assert wait_for(server, started["job_id"], {"done", "failed"})["status"] == "done"
        _, doc = call(server, f"/jobs/{started['job_id']}/result")
        blocks.append(doc["scripture_file"])
    assert counting.calls == 1
    assert started["cache_hit"] is True
    assert blocks[0]["sha256"] != blocks[1]["sha256"]
    assert blocks[1]["entry_count"] == 1

    # A bad file on a cached transcript fails without transcribing.
    bad = harness.tmp_path / "bad.txt"
    bad.write_text("nothing here\n", encoding="utf-8")
    body = harness.request(options=_scripture_options(bad))
    _, started = call(server, "/jobs", method="POST", body=body)
    snap = wait_for(server, started["job_id"], {"done", "failed"})
    assert snap["error"]["code"] == "scripture_file_empty"
    assert counting.calls == 1
