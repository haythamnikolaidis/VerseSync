from pathlib import Path

import pytest

from versesync import paths
from versesync.config import Config, load_config


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


def test_defaults(app_home: Path) -> None:
    cfg = load_config()
    assert cfg.timing["lead_in_s"] == 0.5
    assert cfg.timing["duplicate_cooldown_s"] == 60
    assert cfg.bible["provider"] == "api_bible"
    assert cfg.bible["max_verses_per_passage"] == 6
    assert cfg.server == {
        "idle_exit_s": 1800,
        "allowed_origins": ["cep://com.versesync.panel"],
        "allowed_media_roots": [],
        "estimate_factor": {"cuda": 0.05, "cpu": 0.5, "default": 0.5},
    }
    assert cfg.transcription["model"] == "distil-large-v3"
    assert cfg.transcription["backend"] == "faster_whisper"


def test_home_file_deep_merges_defaults(app_home: Path) -> None:
    app_home.mkdir(parents=True)
    (app_home / "config.yaml").write_text(
        "timing:\n  lead_in_s: 0.75\nbible:\n  api_bible:\n    timeout_s: 3\n", encoding="utf-8"
    )
    cfg = load_config()
    assert cfg.timing["lead_in_s"] == 0.75
    assert cfg.timing["tail_pad_s"] == 1.0
    assert cfg.bible["api_bible"]["timeout_s"] == 3
    assert cfg.bible["api_bible"]["max_retries"] == 2


def test_explicit_path_overrides_home_file(app_home: Path, tmp_path: Path) -> None:
    app_home.mkdir(parents=True)
    (app_home / "config.yaml").write_text("timing:\n  lead_in_s: 0.75\n", encoding="utf-8")
    extra = tmp_path / "extra.yaml"
    extra.write_text("timing:\n  lead_in_s: 1.5\nserver:\n  idle_exit_s: 5\n", encoding="utf-8")
    cfg = load_config(extra)
    assert cfg.timing["lead_in_s"] == 1.5
    assert cfg.server["idle_exit_s"] == 5


def test_empty_file_and_missing_file(app_home: Path, tmp_path: Path) -> None:
    empty = tmp_path / "empty.yaml"
    empty.write_text("", encoding="utf-8")
    assert load_config(empty).timing["lead_in_s"] == 0.5
    assert load_config(tmp_path / "absent.yaml").timing["lead_in_s"] == 0.5


def test_defaults_are_not_shared_between_loads(app_home: Path) -> None:
    load_config().server["allowed_origins"].append("x")
    assert load_config().server["allowed_origins"] == ["cep://com.versesync.panel"]


def test_secret_reads_env_var_named_in_config(
    app_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = load_config()
    assert cfg.secret("api_key_env") is None
    monkeypatch.setenv("VERSESYNC_API_BIBLE_KEY", "s3cr3t-value")
    assert cfg.secret("api_key_env") == "s3cr3t-value"
    assert cfg.secret("no_such_key") is None


def test_secret_never_in_repr(app_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERSESYNC_API_BIBLE_KEY", "s3cr3t-value")
    cfg = load_config()
    assert cfg.secret("api_key_env") == "s3cr3t-value"
    assert "s3cr3t-value" not in repr(cfg)
    assert "s3cr3t-value" not in str(cfg)
    assert "VERSESYNC_API_BIBLE_KEY" in repr(cfg)
    assert isinstance(cfg, Config)
