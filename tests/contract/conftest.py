"""Fixtures for the sidecar contract suite (T-42).

One suite, parameterised over the server under test. ``mock`` launches
``tools/mock_sidecar.py``; ``real`` launches ``python -m versesync.sidecar`` and 
both run in CI. Tests assert shape, status and ordering only, never cue content.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MOCK_SCRIPT = REPO_ROOT / "tools" / "mock_sidecar.py"

# D21: the panel's CEP origin, sent on every valid request.
ORIGIN = "cep://com.versesync.panel"

# Any existing file will do as media: the real sidecar only hashes it (the fixture backend
# supplies the words) and the mock ignores it.
MEDIA_FILE = REPO_ROOT / "pyproject.toml"

# Seconds a mock job runs. Keeps the whole suite well under 30 s (T-42.1).
MOCK_JOB_DURATION_S = 2

STARTUP_TIMEOUT_S = 15.0

# Transcript the real sidecar replays through its fixture backend (T-07).
REAL_TRANSCRIPT = "numbers-and-ordinals.words.json"

ResponseHook = Callable[[str, str, Any], Any]


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    raw: bytes
    body: Any = None


@dataclass
class Sidecar:
    kind: str
    port: int
    token: str
    process: subprocess.Popen[str]
    # Test-only hook: called as hook(method, path, parsed_json) for every JSON response and
    # whatever it returns replaces the body. It lets a test simulate a drifted server, for
    # example by deleting a required key, without touching the server under test.
    response_hook: ResponseHook | None = field(default=None)

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        token: str | None = "",
        origin: str | None = ORIGIN,
        timeout: float = 10.0,
    ) -> Response:
        """Send one request. ``token=""`` means the valid token, ``None`` means no header."""
        headers: dict[str, str] = {}
        if token == "":
            token = self.token
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if origin is not None:
            headers["Origin"] = origin
        payload: bytes | None = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=payload, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            out = Response(resp.status, {k.lower(): v for k, v in resp.getheaders()}, raw)
        finally:
            conn.close()
        if raw and out.headers.get("content-type", "").startswith("application/json"):
            out.body = json.loads(raw)
            if self.response_hook is not None:
                out.body = self.response_hook(method, path, out.body)
        return out

    def sse(self, path: str, *, timeout: float = 30.0) -> list[tuple[str, Any]]:
        """Read a Server-Sent Events stream to its end and return (event, data) pairs."""
        headers = {"Authorization": f"Bearer {self.token}", "Origin": ORIGIN}
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        events: list[tuple[str, Any]] = []
        try:
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            assert resp.status == 200, resp.status
            assert resp.getheader("Content-Type", "").startswith("text/event-stream")
            name: str | None = None
            data: str | None = None
            while True:
                line = resp.readline()
                if not line:
                    break
                text = line.decode("utf-8").rstrip("\r\n")
                if text.startswith("event:"):
                    name = text[len("event:") :].strip()
                elif text.startswith("data:"):
                    data = text[len("data:") :].strip()
                elif text == "" and name is not None:
                    events.append((name, json.loads(data) if data else None))
                    if name == "done":
                        break
                    name, data = None, None
        finally:
            conn.close()
        return events

    def start_job(self) -> str:
        resp = self.request(
            "POST",
            "/jobs",
            body={"media_path": str(MEDIA_FILE), "translation_id": "kjv"},
        )
        assert resp.status == 202, resp.status
        job_id = resp.body["job_id"]
        assert isinstance(job_id, str)
        return job_id

    def wait_for_status(self, job_id: str, wanted: str, timeout: float = 30.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            resp = self.request("GET", f"/jobs/{job_id}")
            assert resp.status == 200, resp.status
            if resp.body["status"] == wanted:
                body: dict[str, Any] = resp.body
                return body
            assert resp.body["status"] != "failed" or wanted == "failed", resp.body
            assert time.monotonic() < deadline, f"job never reached {wanted}: {resp.body}"
            time.sleep(0.1)


def _launch_mock(home: Path) -> Sidecar:
    # The mock prints its port and token without flushing. Piped, Python block-buffers stdout,
    # so the readline loop below would wait forever unless the child is unbuffered.
    env = dict(os.environ, VERSESYNC_HOME=str(home), PYTHONUNBUFFERED="1")
    env.pop("APPDATA", None)
    proc = subprocess.Popen(
        [
            sys.executable,
            str(MOCK_SCRIPT),
            "--no-lock-file",
            "--duration",
            str(MOCK_JOB_DURATION_S),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=env,
    )
    assert proc.stdout is not None
    port: int | None = None
    token: str | None = None
    deadline = time.monotonic() + STARTUP_TIMEOUT_S
    while (port is None or token is None) and time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        m = re.search(r"listening on http://127\.0\.0\.1:(\d+)", line)
        if m:
            port = int(m.group(1))
        m = re.search(r"token: (\S+)", line)
        if m:
            token = m.group(1)
    if port is None or token is None:
        proc.kill()
        raise RuntimeError("mock sidecar did not report its port and token")
    return Sidecar("mock", port, token, proc)


def _launch_real(home: Path) -> Sidecar:
    # The fixture backend replays a recorded transcript (T-07), so no model or GPU is needed;
    # the bundled local Bible provider is the only provider the sidecar wires up.
    transcript = REPO_ROOT / "tests" / "fixtures" / "transcripts" / REAL_TRANSCRIPT
    config_path = home / "contract-config.yaml"
    config_path.write_text(
        json.dumps(
            {
                "transcription": {"backend": f"fixture:{transcript.as_posix()}"},
                "bible": {"provider": "local"},
            }
        ),
        encoding="utf-8",
    )
    env = dict(os.environ, VERSESYNC_HOME=str(home))
    env.pop("APPDATA", None)
    proc = subprocess.Popen(
        [sys.executable, "-m", "versesync.sidecar", "--config", str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=env,
    )
    assert proc.stdout is not None
    port: int | None = None
    deadline = time.monotonic() + STARTUP_TIMEOUT_S
    while port is None and time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        m = re.search(r"VERSESYNC_READY port=(\d+)", line)
        if m:
            port = int(m.group(1))
    if port is None:
        proc.kill()
        raise RuntimeError("real sidecar did not report readiness")
    lock = json.loads((home / "sidecar.json").read_text(encoding="utf-8"))
    return Sidecar("real", port, str(lock["token"]), proc)


@pytest.fixture(scope="module", params=["mock", "real"])
def server(
    request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[Sidecar]:
    home = tmp_path_factory.mktemp("home")
    sidecar = _launch_real(home) if request.param == "real" else _launch_mock(home)
    try:
        yield sidecar
    finally:
        if sidecar.process.poll() is None:
            sidecar.process.kill()
        sidecar.process.wait()
        if sidecar.process.stdout is not None:
            sidecar.process.stdout.close()


@pytest.fixture
def sidecar(server: Sidecar) -> Iterator[Sidecar]:
    """The shared server with the response hook cleared before and after each test."""
    server.response_hook = None
    yield server
    server.response_hook = None


@pytest.fixture(scope="module")
def finished_job(server: Sidecar) -> str:
    """A job that has run to completion, shared by the tests that read its output."""
    job_id = server.start_job()
    server.wait_for_status(job_id, "done")
    return job_id
