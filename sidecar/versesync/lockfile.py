"""The sidecar lock file (docs/07-sidecar-api.md §1.1).

``sidecar.json`` records ``{pid, port, token, ...}`` so the panel can attach to a running
sidecar. It is created atomically (full content, user-only permissions, then hard-linked into
place) so a reader never sees a partial file and two sidecars cannot both claim it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_STILL_ACTIVE = 259
_CLAIM_ATTEMPTS = 5


class LockFileError(Exception):
    """The lock file could not be claimed or secured."""


class LockHeldError(LockFileError):
    """A live sidecar already holds the lock."""

    def __init__(self, path: Path, pid: int, port: int | None) -> None:
        super().__init__(f"A VerseSync sidecar is already running (pid {pid}). Lock file: {path}")
        self.path = path
        self.pid = pid
        self.port = port


def pid_alive(pid: int) -> bool:
    """True if a process with this PID exists."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _pid_alive_windows(pid: int) -> bool:  # pragma: no cover - exercised on Windows only
    # os.kill(pid, 0) would terminate the process on Windows, so query it instead.
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    process_query_limited_information = 0x1000
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        # Access denied still means the process exists; anything else means it does not.
        return bool(ctypes.get_last_error() == 5)
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return bool(code.value == _STILL_ACTIVE)
    finally:
        kernel32.CloseHandle(handle)


def restrict_to_current_user(path: Path) -> None:
    """Make ``path`` readable and writable by the current user only.

    POSIX: mode 0600. Windows: drop inherited ACEs and grant the current user alone via
    ``icacls``. Raises :class:`LockFileError` if that cannot be done, because the file holds
    the bearer token.
    """
    if sys.platform != "win32":
        os.chmod(path, 0o600)
        return
    user = os.environ.get("USERNAME")
    if not user:
        raise LockFileError("Cannot restrict the lock file to the current user: USERNAME unset.")
    domain = os.environ.get("USERDOMAIN")
    principal = f"{domain}\\{user}" if domain else user
    try:
        result = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{principal}:(F)"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as e:
        raise LockFileError(f"Cannot restrict the lock file ACL: {e}") from e
    if result.returncode != 0:
        raise LockFileError(f"icacls failed ({result.returncode}): {result.stdout.strip()}")


def read_lock(path: Path) -> dict[str, Any] | None:
    """The parsed lock payload, or None if absent or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _holder_pid(data: dict[str, Any] | None) -> int | None:
    pid = data.get("pid") if data else None
    return pid if isinstance(pid, int) and not isinstance(pid, bool) else None


@dataclass
class LockFile:
    path: Path
    payload: dict[str, Any]

    def release(self) -> None:
        """Remove the lock, but only if it is still ours."""
        current = read_lock(self.path)
        if (
            current
            and current.get("pid") == self.payload["pid"]
            and current.get("token") == self.payload["token"]
        ):
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


def claim(
    path: Path,
    *,
    port: int,
    token: str,
    api_version: str,
    sidecar_version: str,
    pid: int | None = None,
) -> LockFile:
    """Claim the lock, clearing it first if the recorded PID is dead.

    Raises :class:`LockHeldError` if a live sidecar holds it.
    """
    pid = os.getpid() if pid is None else pid
    payload: dict[str, Any] = {
        "pid": pid,
        "port": port,
        "token": token,
        "api_version": api_version,
        "sidecar_version": sidecar_version,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_name(f"{path.name}.{pid}.tmp")
        # Written and secured before it is linked into place, so the token is never exposed.
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload))
    except OSError as e:
        raise LockFileError(f"Could not write the lock file {path}: {e.strerror or e}") from e

    try:
        restrict_to_current_user(staging)
        for _ in range(_CLAIM_ATTEMPTS):
            try:
                os.link(staging, path)  # atomic; fails if the lock exists
                return LockFile(path, payload)
            except FileExistsError:
                pass
            existing = read_lock(path)
            holder = _holder_pid(existing)
            if holder is not None and holder != pid and pid_alive(holder):
                port_held = existing.get("port") if existing else None
                raise LockHeldError(path, holder, port_held if isinstance(port_held, int) else None)
            # Dead holder or unreadable file: clear it, unless someone replaced it meanwhile.
            if read_lock(path) == existing:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        raise LockFileError(f"Could not claim the lock file {path}.")
    except OSError as e:
        raise LockFileError(f"Could not write the lock file {path}: {e.strerror or e}") from e
    finally:
        try:
            staging.unlink()
        except FileNotFoundError:
            pass
