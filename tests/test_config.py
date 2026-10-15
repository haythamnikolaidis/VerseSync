from pathlib import Path

import pytest

from versesync import paths


def test_app_home_honours_env_and_creates_dir(app_home: Path) -> None:
    assert not app_home.exists()
    assert paths.app_home() == app_home
    assert app_home.is_dir()


def test_derived_paths(app_home: Path) -> None:
    assert paths.lock_path() == app_home / "sidecar.json"
    assert paths.cache_dir() == app_home / "cache"
    assert paths.log_path() == app_home / "logs" / "sidecar.log"


def test_app_home_default_posix(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("VERSESYNC_HOME", raising=False)
    monkeypatch.setattr("versesync.paths.sys.platform", "linux")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    assert paths.app_home() == tmp_path / ".local" / "share" / "versesync"


def test_app_home_default_windows(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("VERSESYNC_HOME", raising=False)
    monkeypatch.setattr("versesync.paths.sys.platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert paths.app_home() == tmp_path / "VerseSync"
