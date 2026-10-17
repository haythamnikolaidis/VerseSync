"""Every 07 §3 error code, triggered through the real server (T-32.1).

Each catalogue key is provoked by a request or a failing backend, and the message that comes back
is checked for editor-facing wording: no traceback text, a hint wherever the table defines one.
"""

from __future__ import annotations

import http.client
import json
import re
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from transcript_fixtures import FIXTURES_DIR

from versesync import jobs as jobs_module
from versesync.bible.base import ProviderUnavailable
from versesync.bible.local import LocalProvider
from versesync.config import load_config
from versesync.errors import CATALOGUE, CODES, code_of, render
from versesync.jobs import JobService
from versesync.server import SidecarServer
from versesync.transcribe import Backend, FakeBackend, TranscriptionError, get_backend
from versesync.types import load_words

TOKEN = "test-token"
ORIGIN = "cep://com.versesync.panel"
WORDS_FILE = FIXTURES_DIR / "numbers-and-ordinals.words.json"
TRANSLATION_ID = LocalProvider().list_translations()[0].id

# What an editor must never be shown: a Python traceback or an exception-class prefix.
LEAKS = re.compile(r"Traceback|File \"|\b[A-Za-z]*(?:Error|Exception):")

Reply = tuple[int, bytes]


class DownProvider(LocalProvider):
    """A provider whose service cannot be reached."""

    def list_translations(self) -> Any:
        raise ProviderUnavailable()


class Env:
    def __init__(self, app_home: Path, tmp_path: Path) -> None:
        self.app_home = app_home
        self.tmp_path = tmp_path
        self.media = tmp_path / "media" / "sermon.mxf"
        self.media.parent.mkdir()
        self.media.write_bytes(b"pretend media" * 50)
        self._servers: list[tuple[SidecarServer, threading.Thread]] = []

    def start(
        self,
        *,
        backend: Callable[[], Backend] | None = None,
        provider: bool = True,
        down: bool = False,
        roots: list[str] | None = None,
    ) -> SidecarServer:
        base = load_config()
        config = replace(
            base,
            transcription={**base.transcription, "backend": f"fixture:{WORDS_FILE}"},
            server={**base.server, "allowed_media_roots": roots or []},
        )
        server = SidecarServer(config, TOKEN)
        if provider:
            server.attach_provider(DownProvider() if down else LocalProvider())
        server.attach_jobs(
            JobService(
                config=config,
                backend_factory=backend or (lambda: get_backend(config)),
                provider=(DownProvider() if down else LocalProvider()) if provider else None,
            )
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self._servers.append((server, thread))
        return server

    def stop(self) -> None:
        for server, thread in self._servers:
            server.shutdown()
            thread.join(timeout=5)

    def job_body(self, **extra: Any) -> dict[str, Any]:
        return {"media_path": str(self.media), "translation_id": TRANSLATION_ID, **extra}


@pytest.fixture
def env(app_home: Path, tmp_path: Path) -> Iterator[Env]:
    e = Env(app_home, tmp_path)
    yield e
    e.stop()


def send(
    server: SidecarServer,
    method: str,
    path: str,
    body: Any = None,
    *,
    raw: bytes | None = None,
    headers: dict[str, str] | None = None,
    auth: bool = True,
) -> Reply:
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    sent = {"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN} if auth else {}
    sent.update(headers or {})
    payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    try:
        conn.request(method, path, body=payload, headers=sent)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def error_of(reply: Reply) -> tuple[int, dict[str, Any]]:
    status, data = reply
    return status, json.loads(data)["error"]


def wait_for(server: SidecarServer, job_id: str, states: set[str]) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        _, data = send(server, "GET", f"/jobs/{job_id}")
        snap: dict[str, Any] = json.loads(data)
        if snap["status"] in states:
            return snap
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached {states}")


def start_job(env: Env, server: SidecarServer, **extra: Any) -> str:
    status, data = send(server, "POST", "/jobs", env.job_body(**extra))
    assert status == 202
    return str(json.loads(data)["job_id"])


def failed_job_error(env: Env, server: SidecarServer) -> tuple[int | None, dict[str, Any]]:
    """A failed job's error; it travels inside a 200 snapshot, so it has no HTTP status."""
    snap = wait_for(server, start_job(env, server), {"failed", "done"})
    assert snap["status"] == "failed"
    return None, snap["error"]


def backend_raising(error: Exception) -> Callable[[], Backend]:
    def factory() -> Backend:
        class Failing:
            def transcribe(self, *args: Any, **kwargs: Any) -> Any:
                raise error

        return Failing()  # type: ignore[return-value]

    return factory


def cancelled_error(env: Env) -> tuple[int | None, dict[str, Any]]:
    release = threading.Event()
    server = env.start(
        backend=lambda: FakeBackend(load_words(WORDS_FILE), on_tick=lambda t: release.wait(10))
    )
    job_id = start_job(env, server)
    send(server, "DELETE", f"/jobs/{job_id}")
    release.set()
    wait_for(server, job_id, {"cancelled"})
    # A cancelled job's terminal event is the only place its error is reported (07 §2, §3).
    _, stream = send(server, "GET", f"/jobs/{job_id}/events")
    for block in stream.decode().split("\n\n"):
        if block.startswith("event: failed"):
            data = next(ln for ln in block.splitlines() if ln.startswith("data: "))
            return None, json.loads(data[len("data: ") :])["error"]
    raise AssertionError("no failed event")


def unreadable_media_error(env: Env, monkeypatch: pytest.MonkeyPatch) -> tuple[int, dict[str, Any]]:
    def refuse(path: Path) -> str:
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr(jobs_module, "hash_media", refuse)
    return error_of(send(env.start(), "POST", "/jobs", env.job_body()))


def result_gone_error(env: Env) -> tuple[int, dict[str, Any]]:
    server = env.start()
    job_id = start_job(env, server)
    wait_for(server, job_id, {"done"})
    for result in (env.app_home / "jobs" / job_id).glob("*.json"):
        result.unlink()
    return error_of(send(server, "GET", f"/jobs/{job_id}/result"))


def not_finished_error(env: Env) -> tuple[int, dict[str, Any]]:
    release = threading.Event()
    server = env.start(
        backend=lambda: FakeBackend(load_words(WORDS_FILE), on_tick=lambda t: release.wait(10))
    )
    try:
        job_id = start_job(env, server)
        return error_of(send(server, "GET", f"/jobs/{job_id}/result"))
    finally:
        release.set()


def internal_error(env: Env) -> tuple[int, dict[str, Any]]:
    server = env.start()

    def boom(request: Any) -> Any:
        raise RuntimeError("secret internals")

    server.route("GET", "/boom", boom)
    return error_of(send(server, "GET", "/boom"))


# One trigger per catalogue key: each returns the (status, error object) the editor would see.
Trigger = Callable[[Env, pytest.MonkeyPatch], tuple[int | None, dict[str, Any]]]
TRIGGERS: dict[str, Trigger] = {
    "bad_request": lambda e, m: error_of(
        send(e.start(), "POST", "/resolve", {"reference": "Romans 8"})
    ),
    "bad_request.invalid_json": lambda e, m: error_of(
        send(e.start(), "POST", "/resolve", raw=b"{not json")
    ),
    "bad_request.invalid_length": lambda e, m: error_of(
        send(e.start(), "POST", "/resolve", raw=b"{}", headers={"Content-Length": "-1"})
    ),
    "bad_request.body_too_large": lambda e, m: error_of(
        send(e.start(), "POST", "/resolve", raw=b"", headers={"Content-Length": str(1 << 30)})
    ),
    "bad_request.method_not_allowed": lambda e, m: error_of(send(e.start(), "DELETE", "/models")),
    "bad_request.no_endpoint": lambda e, m: error_of(send(e.start(), "GET", "/nowhere")),
    "bad_request.body_not_object": lambda e, m: error_of(send(e.start(), "POST", "/resolve", [])),
    "bad_request.reference_missing": lambda e, m: error_of(send(e.start(), "POST", "/resolve", {})),
    "bad_request.media_path_missing": lambda e, m: error_of(
        send(e.start(), "POST", "/jobs", {"translation_id": TRANSLATION_ID})
    ),
    "bad_request.media_outside_roots": lambda e, m: error_of(
        send(e.start(roots=[str(e.tmp_path / "elsewhere")]), "POST", "/jobs", e.job_body())
    ),
    "bad_request.translation_missing": lambda e, m: error_of(
        send(e.start(), "POST", "/jobs", {"media_path": str(e.media)})
    ),
    "bad_request.options_not_object": lambda e, m: error_of(
        send(e.start(), "POST", "/jobs", e.job_body(options=[]))
    ),
    "unauthorized": lambda e, m: (send(e.start(), "GET", "/models", auth=False)[0], {}),
    "media_not_found": lambda e, m: error_of(
        send(e.start(), "POST", "/jobs", e.job_body(media_path=str(e.tmp_path / "gone.mxf")))
    ),
    "media_unreadable": unreadable_media_error,
    "model_load_failed": lambda e, m: failed_job_error(
        e,
        e.start(
            backend=lambda: FakeBackend(
                error=TranscriptionError("model_load_failed", "Out of memory (9.1 GB free).")
            )
        ),
    ),
    "transcription_failed": lambda e, m: failed_job_error(
        e,
        e.start(
            backend=lambda: FakeBackend(
                error=TranscriptionError("transcription_failed", "The audio ended early.")
            )
        ),
    ),
    "provider_unavailable": lambda e, m: error_of(send(e.start(down=True), "GET", "/translations")),
    "provider_unavailable.not_configured": lambda e, m: error_of(
        send(e.start(provider=False), "GET", "/translations")
    ),
    "translation_not_licensed": lambda e, m: error_of(
        send(e.start(), "POST", "/resolve", {"reference": "John 3:16", "translation_id": "nope"})
    ),
    "job_not_found": lambda e, m: error_of(send(e.start(), "GET", "/jobs/job_nope")),
    "job_not_found.result_gone": lambda e, m: result_gone_error(e),
    "job_not_finished": lambda e, m: not_finished_error(e),
    "cancelled": lambda e, m: cancelled_error(e),
    "internal": lambda e, m: internal_error(e),
    "internal.job": lambda e, m: failed_job_error(
        e, e.start(backend=backend_raising(RuntimeError("secret internals")))
    ),
}


def test_every_07_section_3_code_has_a_catalogue_entry_and_a_trigger() -> None:
    assert {code_of(key) for key in CATALOGUE} == set(CODES)
    assert set(TRIGGERS) == set(CATALOGUE)


@pytest.mark.parametrize("key", sorted(CATALOGUE))
def test_code_is_triggered_with_editor_wording(
    key: str, env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    status, error = TRIGGERS[key](env, monkeypatch)
    spec = CATALOGUE[key]
    if key == "unauthorized":
        # The 401 is deliberately bodyless (test_server_auth); the table keeps its wording.
        assert status == spec.status
        return
    assert error["code"] == code_of(key)
    assert error["message"]
    assert not LEAKS.search(error["message"]), error["message"]
    assert not LEAKS.search(error["hint"] or ""), error["hint"]
    if spec.hint is not None:
        assert error["hint"], f"{key} defines a hint but none was sent"
    if status is not None:
        assert status == spec.status
    assert error["retryable"] is spec.retryable


def test_internal_errors_keep_the_cause_out_of_the_message(
    env: Env,
) -> None:
    _, error = failed_job_error(
        env, env.start(backend=backend_raising(RuntimeError("secret internals")))
    )
    assert "secret internals" not in error["message"]
    assert "secret internals" not in (error["hint"] or "")
    _, wire = internal_error(env)
    assert "secret internals" not in json.dumps(wire)


def test_catalogue_text_has_no_traceback_wording() -> None:
    params = {
        "problem": "Add a verse.",
        "method": "PUT",
        "path": "/media/a.mxf",
        "reason": "Out of memory.",
        "job_id": "job_1",
        "state": "running",
    }
    for key in CATALOGUE:
        rendered = render(key, **params)
        assert not LEAKS.search(rendered["message"]), key
        assert not LEAKS.search(rendered["hint"] or ""), key
