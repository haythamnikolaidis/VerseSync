"""Per-user data locations shared by the lock file, config and log."""

from __future__ import annotations

import os
from pathlib import Path


def app_dir() -> Path:
    """Directory holding the lock file, config and logs.

    ``VERSESYNC_HOME`` wins (tests, support reproduction); otherwise ``%APPDATA%\\VerseSync`` on
    Windows. Elsewhere ``$XDG_DATA_HOME/VerseSync`` or ``~/.local/share/VerseSync`` is used so
    the sidecar stays runnable on a developer machine.
    """
    override = os.environ.get("VERSESYNC_HOME")
    if override:
        return Path(override)
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "VerseSync"
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "VerseSync"


def lock_path() -> Path:
    return app_dir() / "sidecar.json"


def config_path() -> Path:
    return app_dir() / "config.yaml"


def default_log_path() -> Path:
    return app_dir() / "logs" / "sidecar.log"
