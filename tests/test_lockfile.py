"""Lock file: atomic claim, stale-lock clearing, user-only permissions."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from versesync import lockfile
from versesync.lockfile import LockHeldError, claim, pid_alive, read_lock


def make(path: Path, **overrides: object) -> lockfile.LockFile:
    kwargs: dict[str, object] = {
        "port": 5000, "token": "tok", "api_version": "1.0", "sidecar_version": "1.0.0",
    }
    kwargs.update(overrides)
    return claim(path, **kwargs)  # type: ignore[arg-type]


def dead_pid() -> int:
    """A PID that belonged to a process that has since exited."""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


@pytest.fixture
def live_pid() -> int:
    # The parent of the test process is alive for the whole run.
    return os.getppid()


def test_claim_writes_the_documented_payload(tmp_path: Path) -> None:
    path = tmp_path / "VerseSync" / "sidecar.json"
    lock = make(path, port=51733, token="b7f3")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert set(data) == {
        "pid", "port", "token", "api_version", "sidecar_version", "started_at",
    }
    assert data["pid"] == os.getpid() and data["port"] == 51733 and data["token"] == "b7f3"
    assert data["started_at"].endswith("Z")
    assert lock.payload == data
    assert not list(path.parent.glob("*.tmp"))


def test_second_sidecar_cannot_claim_a_live_lock(tmp_path: Path, live_pid: int) -> None:
    path = tmp_path / "sidecar.json"
    make(path, pid=live_pid, port=6001, token="first")
    with pytest.raises(LockHeldError) as exc:
        make(path, port=6002, token="second")
    assert exc.value.pid == live_pid and exc.value.port == 6001
    held = read_lock(path)
    assert held is not None and held["token"] == "first"
    assert not list(tmp_path.glob("*.tmp"))


def test_stale_lock_with_a_dead_pid_is_cleared(tmp_path: Path) -> None:
    path = tmp_path / "sidecar.json"
    make(path, pid=dead_pid(), port=6001, token="old")
    lock = make(path, port=6002, token="new")
    data = read_lock(path)
    assert data is not None and data["token"] == "new" and data["pid"] == os.getpid()
    assert lock.payload["port"] == 6002


def test_unreadable_lock_is_treated_as_stale(tmp_path: Path) -> None:
    path = tmp_path / "sidecar.json"
    path.write_text("{not json", encoding="utf-8")
    make(path, token="fresh")
    data = read_lock(path)
    assert data is not None and data["token"] == "fresh"


def test_release_removes_only_our_own_lock(tmp_path: Path) -> None:
    path = tmp_path / "sidecar.json"
    ours = make(path, token="ours")
    path.unlink()
    other = make(path, pid=dead_pid(), token="theirs")
    ours.release()
    assert path.exists()  # replaced by someone else, left alone
    other.release()
    assert not path.exists()


def test_release_removes_the_lock(tmp_path: Path) -> None:
    path = tmp_path / "sidecar.json"
    lock = make(path)
    lock.release()
    assert not path.exists()
    lock.release()  # idempotent


def test_pid_alive() -> None:
    assert pid_alive(os.getpid())
    assert not pid_alive(dead_pid())
    assert not pid_alive(0)
    assert not pid_alive(-5)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
def test_lock_file_is_user_only_on_posix(tmp_path: Path) -> None:
    path = tmp_path / "sidecar.json"
    make(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_acl_failure_is_fatal_and_leaves_no_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(_path: Path) -> None:
        raise lockfile.LockFileError("cannot secure")

    monkeypatch.setattr(lockfile, "restrict_to_current_user", refuse)
    path = tmp_path / "sidecar.json"
    with pytest.raises(lockfile.LockFileError):
        make(path)
    assert not path.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_windows_acl_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The icacls invocation is built correctly (the real ACL is checked on Windows only)."""
    calls: list[list[str]] = []

    def fake_run(cmd: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("USERNAME", "editor")
    monkeypatch.setenv("USERDOMAIN", "STUDIO")
    lockfile.restrict_to_current_user(tmp_path / "sidecar.json")
    assert calls == [
        [
            "icacls", str(tmp_path / "sidecar.json"),
            "/inheritance:r", "/grant:r", "STUDIO\\editor:(F)",
        ]
    ]


def test_windows_acl_failure_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(cmd: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, 5, stdout="Access is denied", stderr="")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("USERNAME", "editor")
    with pytest.raises(lockfile.LockFileError, match="icacls failed"):
        lockfile.restrict_to_current_user(tmp_path / "sidecar.json")


def test_concurrent_processes_race_for_the_lock(tmp_path: Path) -> None:
    """Exactly one of several concurrent sidecar processes wins the lock."""
    path = tmp_path / "sidecar.json"
    code = (
        "import sys, time\n"
        "from pathlib import Path\n"
        "from versesync.lockfile import claim, LockHeldError\n"
        "try:\n"
        "    claim(Path(sys.argv[1]), port=1, token=sys.argv[2], api_version='1.0',"
        " sidecar_version='1.0.0')\n"
        "except LockHeldError:\n"
        "    print('held'); sys.exit(0)\n"
        "print('won'); sys.stdout.flush(); time.sleep(2)\n"
    )
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", code, str(path), f"t{i}"],
            stdout=subprocess.PIPE,
            text=True,
        )
        for i in range(4)
    ]
    outputs = []
    for p in procs:
        out, _ = p.communicate(timeout=30)
        outputs.append(out.strip())
    assert outputs.count("won") == 1
    assert outputs.count("held") == 3
