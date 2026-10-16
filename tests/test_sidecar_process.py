from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from versesync.paths import lock_path

ORIGIN = "cep://com.versesync.panel"


def _launch(home: Path, *extra: str, module: str = "versesync.sidecar") -> subprocess.Popen[str]:
    env = dict(os.environ, VERSESYNC_HOME=str(home))
    return subprocess.Popen(
        [sys.executable, "-m", module, *extra],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def _ready_port(proc: subprocess.Popen[str]) -> int:
    assert proc.stdout is not None
    line = proc.stdout.readline().strip()
    assert line.startswith("VERSESYNC_READY port="), line
    return int(line.split("=", 1)[1])


def _call(port: int, path: str, token: str | None = None, method: str = "GET") -> Any:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method=method, data=b"" if method == "POST" else None
    )
    request.add_header("Origin", ORIGIN)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


@pytest.fixture
def home(app_home: Any) -> Path:
    return Path(os.environ["VERSESYNC_HOME"])


@pytest.fixture
def procs() -> Iterator[list[subprocess.Popen[str]]]:
    started: list[subprocess.Popen[str]] = []
    yield started
    for proc in started:
        if proc.poll() is None:
            proc.kill()
        proc.communicate()


def test_ready_health_and_lock(home: Path, procs: list[subprocess.Popen[str]]) -> None:
    proc = _launch(home)
    procs.append(proc)
    port = _ready_port(proc)
    assert _call(port, "/health")["status"] == "ready"
    lock = json.loads(lock_path().read_text(encoding="utf-8"))
    assert lock["port"] == port
    assert lock["pid"] == proc.pid
    token = lock["token"]
    assert _call(port, "/shutdown", token, "POST") == {"status": "shutting_down"}
    assert proc.wait(timeout=10) == 0


def test_alias_module_runs(home: Path, procs: list[subprocess.Popen[str]]) -> None:
    proc = _launch(home, module="versesync")
    procs.append(proc)
    port = _ready_port(proc)
    token = json.loads(lock_path().read_text(encoding="utf-8"))["token"]
    _call(port, "/shutdown", token, "POST")
    assert proc.wait(timeout=10) == 0


def test_shutdown_removes_lock_and_keeps_token_out_of_log(
    home: Path, procs: list[subprocess.Popen[str]]
) -> None:
    proc = _launch(home)
    procs.append(proc)
    port = _ready_port(proc)
    token = json.loads(lock_path().read_text(encoding="utf-8"))["token"]
    _call(port, "/shutdown", token, "POST")
    assert proc.wait(timeout=10) == 0
    assert not lock_path().exists()
    log = (home / "logs" / "sidecar.log").read_text(encoding="utf-8")
    assert "listening" in log
    assert token not in log


def test_idle_exit(home: Path, procs: list[subprocess.Popen[str]]) -> None:
    home.mkdir(parents=True, exist_ok=True)
    config = home / "idle.yaml"
    config.write_text("server:\n  idle_exit_s: 1\n", encoding="utf-8")
    proc = _launch(home, "--config", str(config))
    procs.append(proc)
    _ready_port(proc)
    started = time.monotonic()
    assert proc.wait(timeout=5) == 0
    assert time.monotonic() - started < 5
    assert not lock_path().exists()


def test_second_instance_refused(home: Path, procs: list[subprocess.Popen[str]]) -> None:
    first = _launch(home)
    procs.append(first)
    port = _ready_port(first)
    second = _launch(home)
    procs.append(second)
    _, stderr = second.communicate(timeout=10)
    assert second.returncode != 0
    assert "already running" in stderr
    assert _call(port, "/health")["status"] == "ready"
    token = json.loads(lock_path().read_text(encoding="utf-8"))["token"]
    _call(port, "/shutdown", token, "POST")
    assert first.wait(timeout=10) == 0
