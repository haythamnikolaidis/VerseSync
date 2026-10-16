from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest

from versesync.config import load_config
from versesync.server import API_VERSION, ApiError, Request, SidecarServer

TOKEN = "test-token"
ORIGIN = "cep://com.versesync.panel"


@pytest.fixture
def server(app_home: Any) -> Iterator[SidecarServer]:
    srv = SidecarServer(load_config(), TOKEN)

    def echo(request: Request) -> dict[str, Any]:
        return {"id": request.params["id"], "body": request.json()}

    def fail(request: Request) -> None:
        raise ApiError(409, "job_not_finished", "Not done.", hint="Wait.", retryable=True)

    def crash(request: Request) -> None:
        raise RuntimeError("secret internal detail")

    srv.route("POST", "/jobs/{id}", echo)
    srv.route("GET", "/fail", fail)
    srv.route("GET", "/crash", crash)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    thread.join(timeout=5)


def call(
    server: SidecarServer,
    path: str,
    *,
    method: str = "GET",
    token: str | None = TOKEN,
    origin: str | None = ORIGIN,
    body: bytes | None = None,
) -> tuple[int, Any, bytes]:
    headers: dict[str, str] = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if origin is not None:
        headers["Origin"] = origin
    req = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}", data=body, method=method, headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


def test_valid_token_and_origin_gives_200(server: SidecarServer) -> None:
    status, _, body = call(server, "/jobs/abc", method="POST", body=b'{"a": 1}')
    assert status == 200
    assert json.loads(body) == {"id": "abc", "body": {"a": 1}}


def test_missing_token_gives_bare_401(server: SidecarServer) -> None:
    status, _, body = call(server, "/jobs/abc", method="POST", token=None)
    assert (status, body) == (401, b"")


def test_wrong_token_gives_bare_401(server: SidecarServer) -> None:
    status, _, body = call(server, "/jobs/abc", method="POST", token="nope")
    assert (status, body) == (401, b"")


def test_missing_origin_gives_401(server: SidecarServer) -> None:
    status, _, body = call(server, "/jobs/abc", method="POST", origin=None)
    assert (status, body) == (401, b"")


def test_origin_not_on_allowlist_gives_401(server: SidecarServer) -> None:
    status, _, _ = call(server, "/jobs/abc", method="POST", origin="http://evil.example")
    assert status == 401


def test_unknown_route_unauthenticated_is_401_not_404(server: SidecarServer) -> None:
    status, _, _ = call(server, "/nope", token=None)
    assert status == 401


def test_api_header_on_200_401_and_404(server: SidecarServer) -> None:
    ok = call(server, "/health", token=None, origin=None)
    denied = call(server, "/jobs/abc", method="POST", token=None)
    missing = call(server, "/nope")
    assert [r[0] for r in (ok, denied, missing)] == [200, 401, 404]
    for _, headers, _ in (ok, denied, missing):
        assert headers["X-VerseSync-Api"] == API_VERSION == "1.0"


def test_unknown_route_gives_404_envelope(server: SidecarServer) -> None:
    status, _, body = call(server, "/nope")
    assert status == 404
    error = json.loads(body)["error"]
    assert error["code"] == "bad_request"
    assert set(error) == {"code", "message", "detail", "retryable", "hint"}


def test_wrong_method_on_known_path_is_405(server: SidecarServer) -> None:
    status, _, body = call(server, "/jobs/abc")
    assert status == 405
    assert "error" in json.loads(body)


def test_api_error_renders_envelope(server: SidecarServer) -> None:
    status, headers, body = call(server, "/fail")
    assert status == 409
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body) == {
        "error": {
            "code": "job_not_finished",
            "message": "Not done.",
            "detail": None,
            "retryable": True,
            "hint": "Wait.",
        }
    }


def test_unexpected_exception_is_500_internal_without_leak(server: SidecarServer) -> None:
    status, headers, body = call(server, "/crash")
    assert status == 500
    assert json.loads(body)["error"]["code"] == "internal"
    assert b"secret internal detail" not in body
    assert headers["X-VerseSync-Api"] == "1.0"


def test_malformed_json_body_is_400(server: SidecarServer) -> None:
    status, _, body = call(server, "/jobs/abc", method="POST", body=b"{not json")
    assert status == 400
    assert json.loads(body)["error"]["code"] == "bad_request"


def test_binds_loopback_only(server: SidecarServer) -> None:
    assert server._httpd.server_address[0] == "127.0.0.1"
    assert server.server_address[0] == "127.0.0.1"
    assert server.port == server.server_address[1] != 0


def test_health_needs_no_auth_and_starts_starting(server: SidecarServer) -> None:
    status, _, body = call(server, "/health", token=None, origin=None)
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "starting"
    assert data["api_version"] == "1.0"
    assert data["active_jobs"] == 0
    server.mark_ready()
    assert json.loads(call(server, "/health", token=None, origin=None)[2])["status"] == "ready"


def test_health_body_is_overridable(server: SidecarServer) -> None:
    server.health = lambda: {"status": "degraded"}  # type: ignore[method-assign]
    assert json.loads(call(server, "/health", token=None)[2]) == {"status": "degraded"}


def test_shutdown_requires_auth(server: SidecarServer) -> None:
    assert call(server, "/shutdown", method="POST", token=None)[0] == 401


def test_shutdown_stops_serving(app_home: Any) -> None:
    srv = SidecarServer(load_config(), TOKEN)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    status, _, _ = call(srv, "/shutdown", method="POST")
    assert status == 200
    thread.join(timeout=5)
    assert not thread.is_alive()
    srv.shutdown()  # idempotent


def test_shutdown_before_serving_releases_socket(app_home: Any) -> None:
    srv = SidecarServer(load_config(), TOKEN)
    srv.shutdown()
    srv.serve_forever()  # returns immediately once closed
