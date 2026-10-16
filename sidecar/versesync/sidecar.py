"""Sidecar entry point: ``python -m versesync.sidecar`` (docs/03-architecture.md section 3)."""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import secrets
import signal
import sys
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from types import FrameType
from typing import Any

from versesync import lockfile
from versesync.config import load_config
from versesync.paths import log_path
from versesync.server import API_VERSION, SIDECAR_VERSION, SidecarServer, _Route

# Chosen, not specified: how often the idle watcher re-checks the clock. Small enough that a
# 1 s idle limit is honoured promptly; large enough to cost nothing.
IDLE_POLL_S = 0.1

# Chosen: 1 MiB per file with 3 backups caps the log at about 4 MiB.
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUPS = 3

_log = logging.getLogger("versesync.sidecar")


class _TrackedServer(SidecarServer):
    """A ``SidecarServer`` that records when it last saw a request."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.last_request = time.monotonic()
        # T-20 replaces this with a count of running jobs; idle exit waits while it is non-zero.
        self.active_jobs: Callable[[], int] = lambda: 0

    def match(self, method: str, path: str) -> tuple[tuple[_Route, dict[str, str]] | None, bool]:
        self.last_request = time.monotonic()
        return super().match(method, path)


def _configure_logging() -> Path:
    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger("versesync")
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    return path


def _watch_idle(server: _TrackedServer, idle_exit_s: float, stop: threading.Event) -> None:
    while not stop.wait(IDLE_POLL_S):
        if server.active_jobs() > 0:
            server.last_request = time.monotonic()
            continue
        if time.monotonic() - server.last_request >= idle_exit_s:
            _log.info("idle for %s s with no jobs; shutting down", idle_exit_s)
            server.shutdown()
            return


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="versesync.sidecar")
    parser.add_argument("--port", type=int, default=0, help="loopback port (0 = ephemeral)")
    parser.add_argument("--config", type=Path, default=None, help="extra YAML config file")
    args = parser.parse_args(argv)

    log_file = _configure_logging()
    try:
        config = load_config(args.config)
    except (OSError, ValueError) as exc:
        _log.error("cannot load config: %s", exc)
        print(f"VerseSync sidecar: cannot load config: {exc} (log: {log_file})", file=sys.stderr)
        return 2

    token = secrets.token_urlsafe(32)  # once per launch; only the lock file ever holds it
    try:
        server = _TrackedServer(config, token, args.port)
    except OSError as exc:
        _log.error("cannot bind port %s: %s", args.port, exc)
        print(
            f"VerseSync sidecar: cannot bind port {args.port}: {exc} (log: {log_file})",
            file=sys.stderr,
        )
        return 1

    pid = os.getpid()
    info = lockfile.LockInfo(
        pid=pid,
        port=server.port,
        token=token,
        api_version=API_VERSION,
        sidecar_version=SIDECAR_VERSION,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    try:
        lockfile.acquire(info)
    except lockfile.LockHeld as held:
        server.shutdown()
        message = (
            f"VerseSync sidecar is already running (pid {held.info.pid}, port {held.info.port})."
        )
        _log.error(message)
        print(message, file=sys.stderr)
        return 1

    def _on_signal(signum: int, frame: FrameType | None) -> None:
        _log.info("received signal %s", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    stop = threading.Event()
    idle_exit_s = float(config.server.get("idle_exit_s", 0) or 0)
    if idle_exit_s > 0:
        threading.Thread(
            target=_watch_idle, args=(server, idle_exit_s, stop), name="sidecar-idle", daemon=True
        ).start()

    _log.info("sidecar %s listening on 127.0.0.1:%s (pid %s)", SIDECAR_VERSION, server.port, pid)
    server.mark_ready()
    if sys.stdout is not None:  # pythonw.exe has no stdout
        print(f"VERSESYNC_READY port={server.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        stop.set()
        lockfile.release(pid)
        _log.info("sidecar stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
