"""Auth, Origin allowlist, headers, /health and idle self-exit for the real sidecar server."""

from __future__ import annotations

import http.client
import inspect
import json
import logging
import os
import pickle
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from versesync.config import Secret, load_config
from versesync.logs import configure_logging, remove_handler
from versesync.server import API_VERSION, SidecarServer, SidecarState

TOKEN = "test-token-abc123"
ORIGIN = "file://"


def request(
    server: SidecarServer,
    method: str,
    path: str,
    *,
    token: str | None = TOKEN,
    origin: str | None = ORIGIN,
) -> tuple[int, http.client.HTTPMessage, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if origin is not None:
        headers["Origin"] = origin
    try:
        conn.request(method, path, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.msg, resp.read()
    finally:
        conn.close()


def start(state: SidecarState) -> tuple[SidecarServer, threading.Thread]:
    server = SidecarServer(state, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def stop(server: SidecarServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


@pytest.fixture
def state() -> SidecarState:
    s = SidecarState(token=TOKEN, allowed_origins=["file://", "null"])
    s.mark_ready()
    return s


@pytest.fixture
def server(state: SidecarState) -> Iterator[SidecarServer]:
    srv, thread = start(state)
    yield srv
    stop(srv, thread)


def test_health_is_unauthenticated_and_has_the_contract_shape(server: SidecarServer) -> None:
    status, headers, body = request(server, "GET", "/health", token=None, origin=None)
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "ready"
    assert data["api_version"] == API_VERSION
    for key in ("sidecar_version", "device", "model_loaded", "gpu", "provider", "active_jobs"):
        assert key in data
    assert headers["X-VerseSync-Api"] == API_VERSION


def test_protected_route_without_token_is_401_with_no_body(server: SidecarServer) -> None:
    status, headers, body = request(server, "GET", "/models", token=None)
    assert status == 401
    assert body == b""
    assert headers["X-VerseSync-Api"] == API_VERSION


def test_wrong_token_is_401_with_no_body(server: SidecarServer) -> None:
    status, headers, body = request(server, "GET", "/models", token="nope")
    assert (status, body) == (401, b"")
    assert headers["X-VerseSync-Api"] == API_VERSION


def test_missing_origin_is_rejected_even_with_the_right_token(server: SidecarServer) -> None:
    status, _, body = request(server, "GET", "/models", origin=None)
    assert (status, body) == (401, b"")


def test_foreign_origin_is_rejected_even_with_the_right_token(server: SidecarServer) -> None:
    status, _, body = request(server, "GET", "/models", origin="https://evil.example")
    assert (status, body) == (401, b"")


def test_valid_token_and_origin_pass_auth(server: SidecarServer) -> None:
    # No /models route exists yet, so passing auth shows up as the typed 404 rather than 401.
    status, headers, body = request(server, "GET", "/models")
    assert status == 404
    assert json.loads(body)["error"]["code"] == "bad_request"
    assert headers["X-VerseSync-Api"] == API_VERSION


def test_every_method_is_authenticated(server: SidecarServer) -> None:
    for method in ("POST", "DELETE"):
        status, _, _ = request(server, method, "/jobs", token=None)
        assert status == 401


def test_preflight_only_answers_allowlisted_origins(server: SidecarServer) -> None:
    status, headers, _ = request(server, "OPTIONS", "/jobs", token=None)
    assert status == 204
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    status, headers, _ = request(server, "OPTIONS", "/jobs", token=None, origin="https://x.test")
    assert status == 401
    assert "Access-Control-Allow-Origin" not in headers


def test_socket_is_bound_to_loopback_only(server: SidecarServer) -> None:
    host, port = server.socket.getsockname()[:2]
    assert host == "127.0.0.1"
    assert port == server.port != 0


def test_server_has_no_way_to_choose_a_host() -> None:
    assert "host" not in inspect.signature(SidecarServer.__init__).parameters


def test_status_transitions() -> None:
    fresh = SidecarState(token=TOKEN, allowed_origins=[])
    assert fresh.status == "starting"
    fresh.mark_ready()
    assert fresh.status == "ready"
    fresh.set_active_jobs_provider(lambda: 2)
    assert fresh.status == "busy"
    assert fresh.health()["active_jobs"] == 2
    fresh.set_degraded("gpu", "No GPU found")
    assert fresh.status == "degraded"
    assert fresh.degraded_reasons() == {"gpu": "No GPU found"}
    fresh.set_degraded("gpu", None)
    assert fresh.status == "busy"


def test_degraded_still_serves_health(state: SidecarState) -> None:
    state.set_degraded("provider", "unreachable")
    srv, thread = start(state)
    try:
        status, _, body = request(srv, "GET", "/health", token=None, origin=None)
        assert status == 200
        assert json.loads(body)["status"] == "degraded"
    finally:
        stop(srv, thread)


def test_shutdown_endpoint_requires_auth_and_stops_the_server(state: SidecarState) -> None:
    srv, thread = start(state)
    try:
        assert request(srv, "POST", "/shutdown", token=None)[0] == 401
        assert thread.is_alive()
        assert request(srv, "POST", "/shutdown")[0] == 200
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        srv.server_close()


def test_idle_self_exit_fires() -> None:
    state = SidecarState(token=TOKEN, allowed_origins=[])
    state.mark_ready()
    srv = SidecarServer(state, port=0)
    srv.start_idle_monitor(0.3, poll_s=0.05)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    started = time.monotonic()
    thread.start()
    thread.join(timeout=5)
    srv.server_close()
    assert not thread.is_alive()
    assert srv.idle_exited
    assert time.monotonic() - started >= 0.3


def test_idle_exit_waits_for_active_jobs_and_clients() -> None:
    now = [0.0]
    state = SidecarState(token=TOKEN, allowed_origins=[], clock=lambda: now[0])
    state.set_active_jobs_provider(lambda: 1)
    now[0] = 100.0
    assert state.idle_for() is None  # a running job is never idle
    state.set_active_jobs_provider(lambda: 0)
    assert state.idle_for() == 100.0
    with state.client_request():
        assert state.idle_for() is None  # an open request/stream is a client
        now[0] = 150.0
    now[0] = 160.0
    assert state.idle_for() == 10.0  # the clock restarts when the client leaves


def test_requests_reset_the_idle_clock() -> None:
    state = SidecarState(token=TOKEN, allowed_origins=[])
    state.mark_ready()
    srv, thread = start(state)
    srv.start_idle_monitor(0.6, poll_s=0.05)
    try:
        for _ in range(5):
            time.sleep(0.2)
            assert request(srv, "GET", "/health", token=None, origin=None)[0] == 200
        assert thread.is_alive()  # 1s of polling outlived a 0.6s idle timeout
    finally:
        stop(srv, thread)


def test_internal_error_reports_the_log_path(tmp_path: Path) -> None:
    log_path = tmp_path / "sidecar.log"
    state = SidecarState(token=TOKEN, allowed_origins=["file://"], log_path=log_path)
    state.mark_ready()

    def boom() -> int:
        raise RuntimeError("kaput")

    state.set_active_jobs_provider(boom)
    handler = configure_logging(log_path, redact=[TOKEN])
    srv, thread = start(state)
    try:
        status, _, body = request(srv, "GET", "/health", token=None, origin=None)
        assert status == 500
        error = json.loads(body)["error"]
        assert error["code"] == "internal"
        assert str(log_path) in error["message"]
        assert str(log_path) in error["hint"]
    finally:
        stop(srv, thread)
        remove_handler(handler)
    assert "kaput" in log_path.read_text(encoding="utf-8")


def test_logs_are_json_and_never_contain_the_token(tmp_path: Path) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    handler = configure_logging(log_path, redact=[TOKEN])
    state = SidecarState(token=TOKEN, allowed_origins=["file://"], log_path=log_path)
    state.mark_ready()
    srv, thread = start(state)
    try:
        request(srv, "GET", "/models", token="wrong")
        logging.getLogger("versesync.test").info("token is %s", TOKEN)
    finally:
        stop(srv, thread)
        remove_handler(handler)
    text = log_path.read_text(encoding="utf-8")
    assert TOKEN not in text and "wrong" not in text
    lines = [json.loads(line) for line in text.splitlines()]
    assert any(line["msg"] == "rejected request" for line in lines)


def test_credentials_are_never_rendered(tmp_path: Path) -> None:
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("credentials:\n  api_bible_key: sekret-key-1\n", encoding="utf-8")
    config = load_config(cfg_path, env={})
    secret = config.credentials.api_bible_key
    assert isinstance(secret, Secret) and secret.reveal() == "sekret-key-1"
    rendered = [
        repr(config), str(config), repr(secret), f"{secret}", json.dumps(config.public_dict()),
    ]
    assert all("sekret-key-1" not in r for r in rendered)
    with pytest.raises(TypeError):
        json.dumps({"k": secret})
    with pytest.raises(TypeError):
        pickle.dumps(secret)


def test_credentials_can_come_from_the_environment(tmp_path: Path) -> None:
    config = load_config(tmp_path / "missing.yaml", env={"VERSESYNC_API_BIBLE_KEY": "from-env"})
    assert config.credentials.api_bible_key.reveal() == "from-env"
    assert config.transcription["model"] == "distil-large-v3"
    assert config.idle_timeout_s == 1800


def test_subprocess_end_to_end(tmp_path: Path) -> None:
    """`python -m versesync.sidecar` binds loopback, writes the lock, serves, then idles out."""
    env = {**os.environ, "VERSESYNC_HOME": str(tmp_path)}
    proc = subprocess.Popen(
        [sys.executable, "-m", "versesync.sidecar", "--idle-timeout-s", "2"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    lock = tmp_path / "sidecar.json"
    try:
        deadline = time.monotonic() + 15
        while not lock.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        data = json.loads(lock.read_text(encoding="utf-8"))
        assert data["pid"] == proc.pid
        assert data["api_version"] == API_VERSION
        conn = http.client.HTTPConnection("127.0.0.1", data["port"], timeout=5)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        assert resp.status == 200 and json.loads(resp.read())["status"] == "ready"
        conn.close()
        auth = {"Authorization": f"Bearer {data['token']}", "Origin": "file://"}
        conn = http.client.HTTPConnection("127.0.0.1", data["port"], timeout=5)
        conn.request("GET", "/x", headers=auth)
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 404  # authenticated
        conn.close()
        assert proc.wait(timeout=30) == 0  # idle self-exit
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for stream in (proc.stdout, proc.stderr):
            if stream:
                stream.close()
    assert not lock.exists()  # released on exit
    assert (tmp_path / "logs" / "sidecar.log").exists()
