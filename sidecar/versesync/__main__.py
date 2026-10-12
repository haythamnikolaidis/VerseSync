"""Entry point: ``python -m versesync.sidecar`` (or ``python -m versesync``)."""

from __future__ import annotations

import argparse
import logging
import secrets
import signal
import sys
import threading
from pathlib import Path
from typing import TextIO

from . import paths
from .config import ConfigError, load_config
from .lockfile import LockFileError, LockHeldError, claim
from .logs import configure_logging, remove_handler
from .server import API_VERSION, SIDECAR_VERSION, SidecarServer, SidecarState

logger = logging.getLogger("versesync.main")

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_LOCK = 3


def _say(message: str, stream: TextIO | None) -> None:
    # pythonw.exe has no stdout/stderr; the log file is the record in that case.
    if stream is not None:
        print(message, file=stream, flush=True)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="versesync.sidecar", description=__doc__)
    parser.add_argument(
        "--port", type=int, default=0, help="Port on 127.0.0.1; 0 picks an ephemeral port."
    )
    parser.add_argument(
        "--idle-timeout-s", type=float, default=None,
        help="Exit after this many idle seconds with no jobs or clients "
        "(0 disables; default from config, 30 minutes).",
    )
    parser.add_argument("--config", type=Path, default=None, help="Path to config.yaml.")
    parser.add_argument("--log-file", type=Path, default=None, help="Path of the JSON log file.")
    parser.add_argument(
        "--lock-file", type=Path, default=None,
        help=r"Path of the lock file (default %%APPDATA%%\VerseSync\sidecar.json).",
    )
    parser.add_argument(
        "--print-token", action="store_true",
        help="Print the bearer token to stdout, for manual curl use. Off by default.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    log_path: Path = args.log_file or paths.default_log_path()
    token = secrets.token_urlsafe(32)  # per launch; never persisted anywhere but the lock file

    handler = configure_logging(log_path, redact=[token])
    try:
        return _run(args, token, log_path)
    finally:
        remove_handler(handler)


def _run(args: argparse.Namespace, token: str, log_path: Path) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as e:
        logger.error("configuration error", extra={"error": str(e)})
        _say(f"{e} Log: {log_path}", sys.stderr)
        return EXIT_CONFIG

    idle_timeout_s = (
        config.idle_timeout_s if args.idle_timeout_s is None else args.idle_timeout_s
    )
    state = SidecarState(
        token=token,
        allowed_origins=config.allowed_origins,
        log_path=log_path,
        provider_id=config.provider_id,
    )
    try:
        server = SidecarServer(state, port=args.port)
    except OSError as e:
        logger.error("cannot bind", extra={"error": str(e)})
        _say(f"Cannot bind 127.0.0.1:{args.port}: {e.strerror or e}. Log: {log_path}", sys.stderr)
        return EXIT_LOCK

    lock_path: Path = args.lock_file or paths.lock_path()
    try:
        lock = claim(
            lock_path,
            port=server.port,
            token=token,
            api_version=API_VERSION,
            sidecar_version=SIDECAR_VERSION,
        )
    except LockHeldError as e:
        logger.error("lock held by a live sidecar", extra={"pid": e.pid, "port": e.port})
        _say(f"{e} Log: {log_path}", sys.stderr)
        server.server_close()
        return EXIT_LOCK
    except LockFileError as e:
        logger.error("lock file error", extra={"error": str(e)})
        _say(f"{e} Log: {log_path}", sys.stderr)
        server.server_close()
        return EXIT_LOCK

    def request_stop(signum: int, _frame: object) -> None:
        logger.info("signal received", extra={"signal": signum})
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, request_stop)
        except (ValueError, OSError):
            pass  # not the main thread, or the platform lacks the signal

    state.mark_ready()
    server.start_idle_monitor(idle_timeout_s)
    logger.info(
        "sidecar ready",
        extra={"port": server.port, "pid": lock.payload["pid"], "idle_timeout_s": idle_timeout_s},
    )
    _say(f"[versesync] listening on http://127.0.0.1:{server.port}", sys.stdout)
    _say(f"[versesync] lock file: {lock_path}", sys.stdout)
    _say(f"[versesync] log file: {log_path}", sys.stdout)
    if args.print_token:
        _say(f"[versesync] token: {token}", sys.stdout)

    try:
        server.serve_forever()
    finally:
        lock.release()
        server.server_close()
        logger.info("sidecar stopped", extra={"idle_exit": server.idle_exited})
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
