import subprocess
import sys

import pytest

from versesync import lockfile
from versesync.lockfile import LockHeld, LockInfo
from versesync.paths import lock_path


def make_info(pid: int, port: int = 5000) -> LockInfo:
    return LockInfo(
        pid=pid,
        port=port,
        token="tok",
        api_version="1.0",
        sidecar_version="1.0.0",
        started_at="2026-01-01T00:00:00Z",
    )


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


@pytest.mark.usefixtures("app_home")
def test_read_absent_is_none() -> None:
    assert lockfile.read() is None


@pytest.mark.usefixtures("app_home")
def test_acquire_then_read_roundtrip() -> None:
    info = make_info(pid=1)
    lockfile.acquire(info)
    assert lockfile.read() == info


@pytest.mark.usefixtures("app_home")
def test_second_acquire_raises_lock_held(monkeypatch: pytest.MonkeyPatch) -> None:
    first = make_info(pid=111)
    lockfile.acquire(first)
    monkeypatch.setattr(lockfile, "pid_alive", lambda pid: True)
    with pytest.raises(LockHeld) as exc:
        lockfile.acquire(make_info(pid=222, port=6000))
    assert exc.value.info == first
    assert lockfile.read() == first


@pytest.mark.usefixtures("app_home")
def test_stale_lock_is_cleared() -> None:
    lockfile.acquire(make_info(pid=dead_pid()))
    fresh = make_info(pid=lockfile.os.getpid(), port=7000)
    lockfile.acquire(fresh)
    assert lockfile.read() == fresh


@pytest.mark.usefixtures("app_home")
def test_release_ignores_other_pid() -> None:
    info = make_info(pid=333)
    lockfile.acquire(info)
    lockfile.release(444)
    assert lockfile.read() == info
    lockfile.release(333)
    assert lockfile.read() is None
    assert not lock_path().exists()


@pytest.mark.usefixtures("app_home")
def test_release_without_lock_is_noop() -> None:
    lockfile.release(1)


@pytest.mark.usefixtures("app_home")
def test_corrupt_lock_reads_as_none_and_is_replaced() -> None:
    lock_path().write_text("not json", encoding="utf-8")
    assert lockfile.read() is None
    info = make_info(pid=5)
    lockfile.acquire(info)
    assert lockfile.read() == info


def test_pid_alive() -> None:
    assert lockfile.pid_alive(lockfile.os.getpid())
    assert not lockfile.pid_alive(dead_pid())
    assert not lockfile.pid_alive(0)
