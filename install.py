"""Sidecar installer: one command from a bare Python to a working VerseSync sidecar.

    python install.py [--dry-run] [--cpu | --gpu] [--venv PATH]

It picks the pinned PyTorch wheel (and the CUDA runtime pins when an NVIDIA GPU is present)
for the running Python (3.11, 3.12 or 3.13), creates a virtual environment, and installs
``versesync[transcribe]`` from this checkout. The upstream transcription engine is pinned in
``pyproject.toml`` (the ``transcribe`` extra), so it is not repeated here.

The torch wheel URLs, their sha256 fragments and the CUDA runtime pins are copied from the
upstream Faster-Whisper-Transcriber installer (reference/fwt/install.py); pip checks the
``#sha256=`` fragment of a direct URL.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

SUPPORTED_TAGS = ("cp311", "cp312", "cp313")

TORCH_PINS: dict[str, dict[str, list[str]]] = {
    "cp311": {
        "GPU": [
            "https://download.pytorch.org/whl/cu128/torch-2.9.0%2Bcu128-cp311-cp311-win_amd64.whl#sha256=dc6f6c6e7d7eed20c687fc189754a6ea6bf2da9c64eff59fd6753b80ed4bca05",
            "nvidia-cuda-runtime-cu12==12.8.90",
            "nvidia-cublas-cu12==12.8.4.1",
            "nvidia-cuda-nvrtc-cu12==12.8.93",
            "nvidia-cuda-nvcc-cu12==12.8.93",
            "nvidia-cudnn-cu12==9.10.2.21",
        ],
        "CPU": [
            "https://download.pytorch.org/whl/cpu/torch-2.9.0%2Bcpu-cp311-cp311-win_amd64.whl#sha256=389e1e0b8083fd355f7caf5ba82356b5e01c318998bd575dbf2285a0d8137089"
        ]
    },
    "cp312": {
        "GPU": [
            "https://download.pytorch.org/whl/cu128/torch-2.9.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=c97dc47a1f64745d439dd9471a96d216b728d528011029b4f9ae780e985529e0",
            "nvidia-cuda-runtime-cu12==12.8.90",
            "nvidia-cublas-cu12==12.8.4.1",
            "nvidia-cuda-nvrtc-cu12==12.8.93",
            "nvidia-cuda-nvcc-cu12==12.8.93",
            "nvidia-cudnn-cu12==9.10.2.21",
        ],
        "CPU": [
            "https://download.pytorch.org/whl/cpu/torch-2.9.0%2Bcpu-cp312-cp312-win_amd64.whl#sha256=e438061b87ec7dd6018fca9f975219889aa0a3f6cdc3ea10dd0ae2bc7f1c47ce"
        ]
    },
    "cp313": {
        "GPU": [
            "https://download.pytorch.org/whl/cu128/torch-2.9.0%2Bcu128-cp313-cp313-win_amd64.whl#sha256=9cba9f0fa2e1b70fffdcec1235a1bb727cbff7e7b118ba111b2b7f984b7087e2",
            "nvidia-cuda-runtime-cu12==12.8.90",
            "nvidia-cublas-cu12==12.8.4.1",
            "nvidia-cuda-nvrtc-cu12==12.8.93",
            "nvidia-cuda-nvcc-cu12==12.8.93",
            "nvidia-cudnn-cu12==9.10.2.21",
        ],
        "CPU": [
            "https://download.pytorch.org/whl/cpu/torch-2.9.0%2Bcpu-cp313-cp313-win_amd64.whl#sha256=728372e3f58c5826445f677746e5311c1935c1a7c59599f73a49ded850e038e8"
        ]
    }
}


REPO_ROOT = Path(__file__).resolve().parent


def python_tag(version: tuple[int, int] | None = None) -> str:
    """Return the CPython wheel tag (``cp312``) for ``version`` or the running interpreter."""
    major, minor = version if version is not None else sys.version_info[:2]
    return f"cp{major}{minor}"


def has_nvidia_gpu() -> bool:
    """True when ``nvidia-smi`` is on PATH and exits cleanly."""
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return False
    try:
        result = subprocess.run([exe], capture_output=True, check=False, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def default_venv() -> Path:
    """``<app home>/venv``, where the panel launches the sidecar from (panel/js/sidecar.js).

    The app home follows ``versesync.paths.app_home``: ``$VERSESYNC_HOME``, then
    ``%APPDATA%/VerseSync`` on Windows, then ``~/.local/share/versesync``.
    """
    override = os.environ.get("VERSESYNC_HOME")
    if override:
        return Path(override) / "venv"
    appdata = os.environ.get("APPDATA")
    if sys.platform == "win32" and appdata:
        return Path(appdata) / "VerseSync" / "venv"
    return Path.home() / ".local" / "share" / "versesync" / "venv"


def unexpanded_variable(path: Path) -> str | None:
    """The first ``%NAME%`` left in ``path``, or None.

    ``"%APPDATA%/VerseSync/venv"`` typed into Git Bash or PowerShell reaches us unexpanded, and
    would create a folder literally named ``%APPDATA%`` under the current directory.
    """
    match = re.search(r"%[A-Za-z_][A-Za-z0-9_]*%", str(path))
    return match.group(0) if match else None


def venv_python(venv: Path) -> Path:
    """Path of the interpreter inside ``venv``."""
    if sys.platform == "win32":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def run(cmd: Sequence[str], dry_run: bool = False) -> None:
    """Run one command. Every subprocess call that installs anything goes through here."""
    print("+ " + subprocess.list2cmdline(list(cmd)))
    if dry_run:
        return
    subprocess.run(list(cmd), check=True)


def build_commands(tag: str, gpu: bool, venv: Path, repo: Path = REPO_ROOT) -> list[list[str]]:
    """The full ordered command list for one install."""
    hardware = "GPU" if gpu else "CPU"
    py = str(venv_python(venv))
    commands: list[list[str]] = [
        [sys.executable, "-m", "venv", str(venv)],
        [py, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
    ]
    for pin in TORCH_PINS[tag][hardware]:
        commands.append([py, "-m", "pip", "install", pin])
    commands.append([py, "-m", "pip", "install", f"{repo}[transcribe]"])
    return commands


def main(
    argv: Sequence[str] | None = None,
    *,
    gpu_detector: Callable[[], bool] = has_nvidia_gpu,
    version: tuple[int, int] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description="Install the VerseSync sidecar.")
    parser.add_argument("--dry-run", action="store_true", help="print the commands, run nothing")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--cpu", action="store_true", help="force the CPU-only torch wheel")
    group.add_argument("--gpu", action="store_true", help="force the CUDA torch wheel")
    parser.add_argument("--venv", type=Path, default=None, help="virtual environment location")
    args = parser.parse_args(argv)

    tag = python_tag(version)
    if tag not in SUPPORTED_TAGS:
        print(
            f"Python {tag[2]}.{tag[3:]} is not supported. VerseSync needs Python 3.11, 3.12 "
            "or 3.13; install one of those and run this installer with it.",
            file=sys.stderr,
        )
        return 2

    gpu = True if args.gpu else False if args.cpu else gpu_detector()
    print(f"Python {tag}, {'NVIDIA GPU' if gpu else 'CPU-only'} install")

    venv = args.venv if args.venv is not None else default_venv()
    variable = unexpanded_variable(venv)
    if variable is not None:
        print(
            f"--venv contains {variable}, which this shell did not expand. Leave --venv out to "
            "use the default location, or pass a path with the variable expanded.",
            file=sys.stderr,
        )
        return 2
    try:
        for command in build_commands(tag, gpu, venv):
            run(command, args.dry_run)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Install failed: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        print("Dry run: nothing was installed.")
    else:
        print(f"Installed. Sidecar interpreter: {venv_python(venv)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
