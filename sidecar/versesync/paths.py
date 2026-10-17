"""Filesystem locations used by the sidecar."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def app_home() -> Path:
    """Return the application home directory, creating it if needed.

    Order: ``$VERSESYNC_HOME``, then ``%APPDATA%\\VerseSync`` on Windows, then
    ``~/.local/share/versesync``.
    """
    override = os.environ.get("VERSESYNC_HOME")
    if override:
        home = Path(override)
    elif sys.platform == "win32" and os.environ.get("APPDATA"):
        home = Path(os.environ["APPDATA"]) / "VerseSync"
    else:
        home = Path.home() / ".local" / "share" / "versesync"
    home.mkdir(parents=True, exist_ok=True)
    return home


def lock_path() -> Path:
    return app_home() / "sidecar.json"


def cache_dir() -> Path:
    return app_home() / "cache"


def log_path() -> Path:
    return app_home() / "logs" / "sidecar.log"
