"""Single-instance lock file (docs/07-sidecar-api.md section 1.1)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from versesync.paths import lock_path


@dataclass(frozen=True)
class LockInfo:
    pid: int
    port: int
    token: str
    api_version: str
    sidecar_version: str
    started_at: str


class LockHeld(Exception):
    """Raised by ``acquire`` when a live process already holds the lock."""

    def __init__(self, info: LockInfo) -> None:
        super().__init__(f"sidecar lock held by pid {info.pid} on port {info.port}")
        self.info = info


def pid_alive(pid: int) -> bool:
    """Return True if a process with this PID exists."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _pid_alive_win32(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # The process exists but belongs to another user.
        return True
    except OSError:
        return False
    return True


def _pid_alive_win32(pid: int) -> bool:
    import ctypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined,unused-ignore]
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        # Access denied means the process exists; any other failure means it does not.
        return bool(kernel32.GetLastError() == 5)
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return bool(code.value == still_active)
    finally:
        kernel32.CloseHandle(handle)


def read() -> LockInfo | None:
    """Return the lock contents, or None if absent or unreadable."""
    try:
        data = json.loads(lock_path().read_text(encoding="utf-8"))
        return LockInfo(
            pid=int(data["pid"]),
            port=int(data["port"]),
            token=str(data["token"]),
            api_version=str(data["api_version"]),
            sidecar_version=str(data["sidecar_version"]),
            started_at=str(data["started_at"]),
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def acquire(info: LockInfo) -> None:
    """Write the lock for ``info``; raise ``LockHeld`` if a live PID holds it."""
    existing = read()
    if existing is not None and existing.pid != info.pid and pid_alive(existing.pid):
        raise LockHeld(existing)
    path = lock_path()
    tmp = path.with_name(path.name + f".{info.pid}.tmp")
    tmp.write_text(json.dumps(asdict(info)), encoding="utf-8")
    _restrict_to_current_user(tmp)
    os.replace(tmp, path)


def release(pid: int) -> None:
    """Delete the lock only if it still names ``pid``."""
    existing = read()
    if existing is None or existing.pid != pid:
        return
    try:
        lock_path().unlink()
    except FileNotFoundError:
        pass


def _restrict_to_current_user(path: Path) -> None:
    """Best-effort user-only ACL (docs/07 section 1.1). Never fatal."""
    if sys.platform != "win32":
        return
    user = os.environ.get("USERNAME")
    if not user:
        return
    try:
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
            capture_output=True,
            check=False,
        )
    except OSError:
        pass
