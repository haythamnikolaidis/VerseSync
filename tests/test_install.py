"""Dry-run tests for the sidecar installer (T-36.1). Nothing here runs pip or nvidia-smi."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "versesync_install", Path(__file__).resolve().parent.parent / "install.py"
)
assert _SPEC is not None and _SPEC.loader is not None
install = importlib.util.module_from_spec(_SPEC)
sys.modules["versesync_install"] = install
_SPEC.loader.exec_module(install)


def _dry_run(capsys: pytest.CaptureFixture[str], gpu: bool, version: tuple[int, int], tmp: Path):
    code = install.main(
        ["--dry-run", "--venv", str(tmp / "venv")],
        gpu_detector=lambda: gpu,
        version=version,
    )
    return code, capsys.readouterr()


@pytest.fixture(autouse=True)
def no_subprocess(monkeypatch: pytest.MonkeyPatch) -> list[object]:
    calls: list[object] = []

    def boom(*args: object, **kwargs: object) -> None:
        calls.append(args)
        raise AssertionError("dry run must not spawn a process")

    monkeypatch.setattr(subprocess, "run", boom)
    return calls


@pytest.mark.parametrize("version", [(3, 11), (3, 12), (3, 13)])
def test_gpu_and_cpu_command_lists_differ(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, version: tuple[int, int]
) -> None:
    code_gpu, gpu_out = _dry_run(capsys, True, version, tmp_path)
    code_cpu, cpu_out = _dry_run(capsys, False, version, tmp_path)
    assert code_gpu == code_cpu == 0
    tag = f"cp{version[0]}{version[1]}"
    assert f"cu128/torch-2.9.0%2Bcu128-{tag}" in gpu_out.out
    assert "nvidia-cudnn-cu12==9.10.2.21" in gpu_out.out
    assert f"cpu/torch-2.9.0%2Bcpu-{tag}" in cpu_out.out
    assert "nvidia-" not in cpu_out.out
    assert "cu128" not in cpu_out.out
    assert gpu_out.out != cpu_out.out


def test_commands_create_venv_and_install_extra(tmp_path: Path) -> None:
    venv = tmp_path / "venv"
    commands = install.build_commands("cp312", False, venv)
    assert commands[0][1:4] == ["-m", "venv", str(venv)]
    py = str(install.venv_python(venv))
    assert all(c[0] == py for c in commands[1:])
    assert commands[-1][-1].endswith("[transcribe]")
    assert str(install.REPO_ROOT) in commands[-1][-1]


def test_gpu_list_has_torch_then_cuda_pins_then_project(tmp_path: Path) -> None:
    pins = install.build_commands("cp311", True, tmp_path)[2:-1]
    assert len(pins) == len(install.TORCH_PINS["cp311"]["GPU"]) == 6
    assert "torch-2.9.0%2Bcu128" in pins[0][-1]


def test_unsupported_python_exits_with_clear_message(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    code, out = _dry_run(capsys, True, (3, 10), tmp_path)
    assert code == 2
    assert "Python 3.10 is not supported" in out.err
    assert "3.11, 3.12 or 3.13" in out.err
    assert "+ " not in out.out


def test_forced_flags_skip_detection(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    def detector() -> bool:
        raise AssertionError("detector must not be called")

    code = install.main(
        ["--dry-run", "--gpu", "--venv", str(tmp_path)], gpu_detector=detector, version=(3, 12)
    )
    assert code == 0
    assert "cu128" in capsys.readouterr().out


def test_every_supported_tag_has_both_pin_sets() -> None:
    for tag in install.SUPPORTED_TAGS:
        assert install.TORCH_PINS[tag]["GPU"] and install.TORCH_PINS[tag]["CPU"]
        assert all("#sha256=" in p for p in install.TORCH_PINS[tag]["CPU"])


def test_run_dry_run_does_not_execute(capsys: pytest.CaptureFixture[str]) -> None:
    install.run(["definitely-not-a-program", "--flag"], dry_run=True)
    assert "+ definitely-not-a-program --flag" in capsys.readouterr().out
