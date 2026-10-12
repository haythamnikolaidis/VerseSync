"""HTTP server: loopback binding, bearer auth, Origin allowlist, /health, idle self-exit.

Contract: docs/07-sidecar-api.md §1-2. The mock sidecar (tools/mock_sidecar.py) implements the
same auth rules; keep the two consistent.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
import time
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

API_VERSION = "1.0"
SIDECAR_VERSION = "1.0.0"
LOOPBACK = "127.0.0.1"

logger = logging.getLogger("versesync.server")


class SidecarState:
    """Everything the request handlers and the idle monitor share."""

    def __init__(
        self,
        *,
        token: str,
        allowed_origins: Iterable[str],
        log_path: Path | None = None,
        provider_id: str = "api_bible",
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.token = token
        self.allowed_origins = frozenset(allowed_origins)
        self.log_path = log_path
        self.provider_id = provider_id
        self._clock = clock
        self._lock = threading.Lock()
        self._ready = False
        self._degraded: dict[str, str] = {}
        self._clients = 0
        self._last_activity = clock()
        self._active_jobs: Callable[[], int] = lambda: 0
        self.shutdown_requested = threading.Event()

    # -- status ---------------------------------------------------------------

    def mark_ready(self) -> None:
        with self._lock:
            self._ready = True

    def set_degraded(self, key: str, reason: str | None) -> None:
        """Record (or clear, with ``reason=None``) a reason the sidecar is degraded.

        Degraded is a real state, not an error: the sidecar still serves, and the reason is
        logged so the panel can be told why.
        """
        with self._lock:
            if reason is None:
                self._degraded.pop(key, None)
            else:
                self._degraded[key] = reason

    def degraded_reasons(self) -> dict[str, str]:
        with self._lock:
            return dict(self._degraded)

    def set_active_jobs_provider(self, provider: Callable[[], int]) -> None:
        self._active_jobs = provider

    @property
    def active_jobs(self) -> int:
        return self._active_jobs()

    @property
    def status(self) -> str:
        with self._lock:
            ready, degraded = self._ready, bool(self._degraded)
        if not ready:
            return "starting"
        if degraded:
            return "degraded"
        return "busy" if self.active_jobs > 0 else "ready"

    def health(self) -> dict[str, Any]:
        """The docs/07-sidecar-api.md §2 shape. Unknown values are null, never invented."""
        return {
            "status": self.status,
            "api_version": API_VERSION,
            "sidecar_version": SIDECAR_VERSION,
            "device": None,
            "model_loaded": None,
            "gpu": None,
            "provider": {"id": self.provider_id, "reachable": None},
            "active_jobs": self.active_jobs,
        }

    # -- idle tracking --------------------------------------------------------

    @contextmanager
    def client_request(self) -> Iterator[None]:
        """Marks a request (including a long-lived SSE stream) as a connected client."""
        with self._lock:
            self._clients += 1
            self._last_activity = self._clock()
        try:
            yield
        finally:
            with self._lock:
                self._clients -= 1
                self._last_activity = self._clock()

    def idle_for(self) -> float | None:
        """Seconds since the last client or job activity, or None if busy right now."""
        with self._lock:
            clients, last = self._clients, self._last_activity
        if clients > 0 or self.active_jobs > 0:
            return None
        return self._clock() - last

    # -- auth -----------------------------------------------------------------

    def origin_allowed(self, origin: str | None) -> bool:
        return bool(origin) and origin in self.allowed_origins

    def authorized(self, authorization: str | None, origin: str | None) -> bool:
        """Bearer token and an allowlisted Origin; a missing Origin is rejected."""
        if not self.origin_allowed(origin):
            return False
        expected = f"Bearer {self.token}"
        return hmac.compare_digest((authorization or "").encode(), expected.encode())


class Handler(BaseHTTPRequestHandler):
    server: SidecarServer
    protocol_version = "HTTP/1.1"
    # Drops idle keep-alive connections so they cannot pin a thread forever.
    timeout = 30

    @property
    def state(self) -> SidecarState:
        return self.server.state

    # -- plumbing -------------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (stdlib signature)
        # Request lines only; headers (and so the token) are never logged.
        logger.debug("http %s", format % args)

    def _headers_common(self) -> None:
        self.send_header("X-VerseSync-Api", API_VERSION)
        origin = self.headers.get("Origin")
        if self.state.origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin or "")
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "X-VerseSync-Api")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._headers_common()
        self.end_headers()
        self.wfile.write(body)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self._headers_common()
        self.end_headers()

    def _send_error(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        hint: str | None = None,
    ) -> None:
        error: dict[str, Any] = {
            "code": code,
            "message": message,
            "detail": None,
            "retryable": retryable,
            "hint": hint,
        }
        self._send_json(status, {"error": error})

    def _route(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        with self.state.client_request():
            try:
                self._dispatch(method, path)
            except (BrokenPipeError, ConnectionResetError):
                raise
            except Exception:
                logger.exception("unhandled error", extra={"method": method, "path": path})
                where = self.state.log_path
                self._send_error(
                    500,
                    "internal",
                    "The transcription service hit an unexpected error."
                    + (f" Details are in the log at {where}." if where else ""),
                    hint=f"See the log at {where}." if where else None,
                )

    def _dispatch(self, method: str, path: str) -> None:
        if method == "GET" and path == "/health":
            self._send_json(200, self.state.health())
            return

        if not self.state.authorized(
            self.headers.get("Authorization"), self.headers.get("Origin")
        ):
            logger.warning("rejected request", extra={"method": method, "path": path})
            self._send_empty(401)
            return

        if method == "POST" and path == "/shutdown":
            self._send_json(200, {"status": "shutting_down"})
            self.state.shutdown_requested.set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        self._send_error(404, "bad_request", f"No such route: {method} {path}")

    # -- verbs ----------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._route("DELETE")

    def do_OPTIONS(self) -> None:  # noqa: N802
        """CORS preflight: answered only for allowlisted origins, never with the token."""
        with self.state.client_request():
            if not self.state.origin_allowed(self.headers.get("Origin")):
                self._send_empty(401)
                return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self._headers_common()
            self.end_headers()


class SidecarServer(ThreadingHTTPServer):
    """A ThreadingHTTPServer that can only ever bind the loopback interface."""

    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, state: SidecarState, port: int = 0) -> None:
        self.state = state
        self._idle_stop = threading.Event()
        self.idle_exited = False
        # The host is deliberately not a parameter: nothing may bind a non-loopback interface.
        super().__init__((LOOPBACK, port), Handler)

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def start_idle_monitor(self, timeout_s: float, poll_s: float | None = None) -> None:
        """Shut the server down once it has had no jobs and no clients for ``timeout_s``.

        A timeout of 0 disables self-exit.
        """
        if timeout_s <= 0:
            return
        interval = poll_s if poll_s is not None else max(0.05, min(5.0, timeout_s / 4))

        def watch() -> None:
            while not self._idle_stop.wait(interval):
                idle = self.state.idle_for()
                if idle is not None and idle >= timeout_s:
                    logger.info("idle timeout reached, exiting", extra={"idle_s": round(idle, 1)})
                    self.idle_exited = True
                    self.shutdown()
                    return

        threading.Thread(target=watch, name="idle-monitor", daemon=True).start()

    def server_close(self) -> None:
        self._idle_stop.set()
        super().server_close()
