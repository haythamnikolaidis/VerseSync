"""Every data file the sidecar ships must be declared as package data (found by T-07.H fix-up).

A non-editable ``pip install`` (what install.py does) copies only declared files, so a missed
glob makes the installed sidecar crash at startup while the checkout works.
"""

from __future__ import annotations

import tomllib
from fnmatch import fnmatchcase
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "sidecar" / "versesync"


def test_every_data_file_is_declared_as_package_data() -> None:
    with (ROOT / "pyproject.toml").open("rb") as f:
        globs = tomllib.load(f)["tool"]["setuptools"]["package-data"]["versesync"]
    data_files = [
        path.relative_to(PACKAGE).as_posix()
        for path in PACKAGE.rglob("*")
        if path.is_file() and path.suffix not in (".py", ".pyc") and "__pycache__" not in path.parts
    ]
    assert data_files, "expected bundled data files"
    # Anchored at the package root, as setuptools resolves them (PurePath.match is not).
    missing = [f for f in data_files if not any(fnmatchcase(f, g) for g in globs)]
    assert missing == [], f"not declared in [tool.setuptools.package-data]: {missing}"
