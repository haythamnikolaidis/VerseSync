"""HTTP server core for the sidecar (docs/07-sidecar-api.md §1-§3).

Loopback-only ``ThreadingHTTPServer`` with a small router, bearer-token and ``Origin``
authentication, the ``X-VerseSync-Api`` header on every response, and the §3 error envelope.
"""

from __future__ import annotations

import hmac
import json
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, unquote, urlsplit

from versesync.config import Config

if TYPE_CHECKING:
    from versesync.jobs import JobService

API_VERSION = "1.0"
API_HEADER = "X-VerseSync-Api"
SIDECAR_VERSION = "1.0.0"  # matches tools/mock_sidecar.py, which the contract tests (T-42) compare

# Loopback only (07 §1, NFR-4). Never "" or "0.0.0.0".
BIND_HOST = "127.0.0.1"

# Chosen, not specified: a request body above this is rejected before it is read. The largest
# legitimate body is a job-start JSON document (well under 1 MiB); 16 MiB leaves ample headroom.
MAX_BODY_BYTES = 16 * 1024 * 1024

# Chosen: stdlib default is 0.5 s, which makes every shutdown (and test teardown) wait that long.
SHUTDOWN_POLL_S = 0.05

_log = logging.getLogger("versesync.server")


class ApiError(Exception):
    """An error rendered as the 07 §3 envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        hint: str | None = None,
        detail: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.detail = detail
        self.retryable = retryable

    def body(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "detail": self.detail,
                "retryable": self.retryable,
                "hint": self.hint,
            }
        }


@dataclass
class Request:
    """What a route handler receives."""

    method: str
    path: str
    params: dict[str, str]
    query: dict[str, list[str]]
    headers: Any
    raw_body: bytes = b""

    def json(self) -> Any:
        """The body parsed as JSON; an empty body is ``{}``. Malformed JSON is a 400."""
        if not self.raw_body:
            return {}
        try:
            return json.loads(self.raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ApiError(400, "bad_request", "The request body is not valid JSON.") from exc


# A handler returns the JSON payload (status 200) or a ``(status, payload)`` pair.
RouteResult = Any
RouteHandler = Callable[[Request], RouteResult]


@dataclass
class _Route:
    method: str
    regex: re.Pattern[str]
    handler: RouteHandler
    auth: bool


def _compile_pattern(pattern: str) -> re.Pattern[str]:
    parts = re.split(r"\{(\w+)\}", pattern)
    out = []
    for index, part in enumerate(parts):
        out.append(f"(?P<{part}>[^/]+)" if index % 2 else re.escape(part))
    return re.compile("^" + "".join(out) + "$")


class _Httpd(ThreadingHTTPServer):
    daemon_threads = True
    # SO_REUSEADDR on Windows lets another process share the port; never wanted here.
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], app: SidecarServer) -> None:
        self.app = app
        super().__init__(address, _Handler)


class _Handler(BaseHTTPRequestHandler):
    server_version = "VerseSyncSidecar/1.0"

    @property
    def app(self) -> SidecarServer:
        server = self.server
        assert isinstance(server, _Httpd)
        return server.app

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # The request line can carry a path but never the Authorization header.
        _log.debug("%s - %s", self.address_string(), format % args)

    def end_headers(self) -> None:
        # Every response, including stdlib-generated ones, names the API version.
        self.send_header(API_HEADER, API_VERSION)
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        self._dispatch()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET  # noqa: N815

    def _authorized(self) -> bool:
        """Bearer token plus a present, allowlisted Origin (07 §1.2-§1.3)."""
        origin = self.headers.get("Origin")
        if not origin or origin not in self.app.allowed_origins:
            return False
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.app.token}"
        return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_unauthorized(self) -> None:
        self.send_response(401)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as exc:
            raise ApiError(400, "bad_request", "The Content-Length header is invalid.") from exc
        if length < 0:
            raise ApiError(400, "bad_request", "The Content-Length header is invalid.")
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "bad_request", "The request body is too large.")
        return self.rfile.read(length) if length else b""

    def _dispatch(self) -> None:
        try:
            split = urlsplit(self.path)
            method = self.command
            matched, path_known = self.app.match(method, split.path)
            if matched is None or matched[0].auth:
                if not self._authorized():
                    self._send_unauthorized()
                    return
            if matched is None:
                if path_known:
                    raise ApiError(405, "bad_request", f"{method} is not allowed here.")
                raise ApiError(404, "bad_request", "No such endpoint.")
            route, params = matched
            request = Request(
                method=method,
                path=split.path,
                params=params,
                query=parse_qs(split.query),
                headers=self.headers,
                raw_body=self._read_body(),
            )
            result = route.handler(request)
            if isinstance(result, tuple):
                status, payload = result
            else:
                status, payload = 200, result
            self._send_json(status, payload)
        except ApiError as exc:
            self._send_json(exc.status, exc.body())
        except Exception:
            # Full detail goes to the log only; the client sees nothing of the cause.
            _log.exception("unhandled error serving %s %s", self.command, self.path.split("?")[0])
            error = ApiError(
                500,
                "internal",
                "Something went wrong inside VerseSync.",
                hint="Check the VerseSync log for details.",
            )
            self._send_json(error.status, error.body())


class SidecarServer:
    """Loopback HTTP server with bearer-token auth, an Origin allowlist and a small router."""

    def __init__(self, config: Config, token: str, port: int = 0) -> None:
        self.config = config
        self.token = token
        self.allowed_origins: frozenset[str] = frozenset(
            str(origin) for origin in config.server.get("allowed_origins", [])
        )
        self._routes: list[_Route] = []
        self._httpd = _Httpd((BIND_HOST, port), self)
        self.port: int = self._httpd.server_address[1]
        self._lifecycle = threading.Lock()
        self._serving = False
        self._closed = False
        self.jobs: JobService | None = None
        self.status = "starting"  # starting | ready | busy | degraded (07 §2)
        self.route("GET", "/health", lambda request: self.health(), auth=False)
        self.route("POST", "/shutdown", self._handle_shutdown)

    @property
    def server_address(self) -> tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    def route(self, method: str, pattern: str, handler: RouteHandler, *, auth: bool = True) -> None:
        """Register ``handler`` for ``method`` + ``pattern`` (``{name}`` captures one segment)."""
        self._routes.append(_Route(method.upper(), _compile_pattern(pattern), handler, auth))

    def match(self, method: str, path: str) -> tuple[tuple[_Route, dict[str, str]] | None, bool]:
        """Return ``((route, params) or None, path_known_for_some_method)``."""
        path_known = False
        for route in self._routes:
            found = route.regex.match(path)
            if found is None:
                continue
            path_known = True
            if route.method == method:
                params = {name: unquote(value) for name, value in found.groupdict().items()}
                return (route, params), True
        return None, path_known

    def attach_jobs(self, service: JobService) -> None:
        """Register the ``/jobs`` routes (07 section 2) backed by ``service``."""
        self.jobs = service
        self.route("POST", "/jobs", service.start)
        self.route("GET", "/jobs/{id}", service.status)
        self.route("GET", "/jobs/{id}/result", service.result)
        self.route("GET", "/jobs/{id}/transcript", service.transcript)
        self.route("DELETE", "/jobs/{id}", service.cancel)

    def mark_ready(self) -> None:
        """Move ``/health`` from ``starting`` to ``ready``."""
        self.status = "ready"

    def health(self) -> dict[str, Any]:
        """The ``/health`` body (07 §2). Subclasses and the entry point override the pieces."""
        return {
            "status": self.status,
            "api_version": API_VERSION,
            "sidecar_version": SIDECAR_VERSION,
            "device": None,
            "model_loaded": None,
            "gpu": None,
            "provider": None,
            "active_jobs": 0,
        }

    def _handle_shutdown(self, request: Request) -> RouteResult:
        # httpd.shutdown() waits for serve_forever to return, so it must not run on the
        # request thread that is still answering this call.
        threading.Thread(target=self.shutdown, name="sidecar-shutdown", daemon=True).start()
        return {"status": "shutting_down"}

    def serve_forever(self) -> None:
        with self._lifecycle:
            if self._closed:
                return
            self._serving = True
        try:
            self._httpd.serve_forever(poll_interval=SHUTDOWN_POLL_S)
        finally:
            self._httpd.server_close()

    def shutdown(self) -> None:
        """Stop serving and release the socket. Safe to call more than once."""
        with self._lifecycle:
            if self._closed:
                return
            self._closed = True
            serving = self._serving
        if serving:
            self._httpd.shutdown()
        else:
            self._httpd.server_close()
