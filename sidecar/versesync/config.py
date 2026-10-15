"""Sidecar configuration: built-in defaults, overlaid by YAML files.

Credentials are never stored here. The config holds the *name* of an environment
variable (for example ``api_key_env``) and :meth:`Config.secret` reads it on demand.
"""

from __future__ import annotations

import copy
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from versesync.paths import app_home

# docs/05-timing-and-placement.md section 2 (config table).
_TIMING_DEFAULTS: dict[str, Any] = {
    "lead_in_s": 0.5,
    "tail_pad_s": 1.0,
    "duration_mode": "auto",
    "fixed_duration_s": 8.0,
    "min_duration_s": 3.0,
    "max_duration_s": 20.0,
    "max_read_duration_s": 45.0,
    "min_visible_s": 2.0,
    "overlap_gap_s": 0.25,
    "read_coverage_threshold": 0.55,
    "duplicate_cooldown_s": 60,
}

# docs/06-bible-text-service.md section 8.
_BIBLE_DEFAULTS: dict[str, Any] = {
    "provider": "api_bible",
    "api_bible": {
        "api_key_env": "VERSESYNC_API_BIBLE_KEY",
        "base_url": "https://api.scripture.api.bible/v1",
        "timeout_s": 10,
        "max_retries": 2,
    },
    "local": {"store_path": "%APPDATA%/VerseSync/bibles"},
    "default_translation": "kjv",
    "max_verses_per_passage": 6,
    "cache_enabled": True,
}

_SERVER_DEFAULTS: dict[str, Any] = {
    "idle_exit_s": 1800,
    "allowed_origins": ["cep://com.versesync.panel"],
    "allowed_media_roots": [],
}

_SECTIONS = ("transcription", "detection", "timing", "bible", "server")


def _defaults() -> dict[str, dict[str, Any]]:
    return {
        "transcription": {},
        "detection": {},
        "timing": copy.deepcopy(_TIMING_DEFAULTS),
        "bible": copy.deepcopy(_BIBLE_DEFAULTS),
        "server": copy.deepcopy(_SERVER_DEFAULTS),
    }


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Return ``base`` overlaid with ``override``; nested dicts merge, other values replace."""
    merged = dict(base)
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _deep_merge(current, value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


@dataclass(frozen=True)
class Config:
    transcription: dict[str, Any] = field(default_factory=dict)
    detection: dict[str, Any] = field(default_factory=dict)
    timing: dict[str, Any] = field(default_factory=dict)
    bible: dict[str, Any] = field(default_factory=dict)
    server: dict[str, Any] = field(default_factory=dict)

    def secret(self, env_name_key: str) -> str | None:
        """Return the value of the env var named by config key ``env_name_key``.

        The key is searched for in every section (and one level of nested provider
        tables). Returns None if the key is unset or the variable is not set.
        """
        name = self._find(env_name_key)
        if not isinstance(name, str) or not name:
            return None
        return os.environ.get(name) or None

    def _find(self, key: str) -> Any:
        for section in (self.transcription, self.detection, self.timing, self.bible, self.server):
            if key in section:
                return section[key]
            for value in section.values():
                if isinstance(value, dict) and key in value:
                    return value[key]
        return None

    def __repr__(self) -> str:
        # Only config (variable names, never secret values) is printed; secrets are
        # read from the environment on demand and never held by this object.
        parts = ", ".join(f"{name}={getattr(self, name)!r}" for name in _SECTIONS)
        return f"Config({parts})"


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise ValueError(f"{path}: config must be a YAML mapping")
    return loaded


def load_config(path: Path | None = None) -> Config:
    """Load defaults, then ``app_home()/config.yaml``, then ``path`` (each overriding the last)."""
    merged: dict[str, Any] = _defaults()
    for source in (app_home() / "config.yaml", path):
        if source is not None:
            merged = _deep_merge(merged, _read_yaml(source))
    return Config(**{name: merged[name] for name in _SECTIONS})
