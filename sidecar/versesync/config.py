"""YAML configuration.

Follows the load-defaults-then-deep-merge pattern of Faster-Whisper-Transcriber's
``config/manager.py``. Unlike that manager this one is read-only: the sidecar never writes
configuration back, which is what keeps credentials from ever being serialised.

Credentials are held as :class:`Secret` values. A ``Secret`` renders as ``<redacted>`` in
``repr``/``str``/f-strings, refuses to be pickled, is not JSON serialisable, and is excluded
from :meth:`Config.public_dict`. Code that genuinely needs the value calls ``reveal()``.
"""

from __future__ import annotations

import copy
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NoReturn

import yaml

from . import paths

logger = logging.getLogger("versesync.config")

DEFAULT_IDLE_TIMEOUT_S = 30 * 60

# Origins a CEP panel can present. Panels load from the local file system, which Chromium
# reports as "file://" or, for some contexts, the opaque origin "null". Configurable because the
# list is an allowlist, not a guess about every host build.
DEFAULT_ALLOWED_ORIGINS = ["file://", "null"]

DEFAULT_CONFIG: dict[str, Any] = {
    "sidecar": {
        "idle_timeout_s": DEFAULT_IDLE_TIMEOUT_S,
        "allowed_origins": list(DEFAULT_ALLOWED_ORIGINS),
    },
    "transcription": {
        "model": "distil-large-v3",
        "device": "auto",
        "quantization": "float16",
        "vad_filter": True,
        "scripture_prompt": True,
        "condition_on_previous_text": True,
        # Pinned for VerseSync jobs; null re-detects the language per run (docs/02 Gap 4).
        "language": "en",
        "batch_size": 8,
        # null keeps faster-whisper's Silero defaults, the settings spike T-02 measured with.
        "vad_parameters": None,
        "seed": 0,
    },
    "provider": {"id": "api_bible"},
    "credentials": {"api_bible_key": "", "esv_api_key": ""},
}

# Environment overrides for credentials, so a key never has to live in a file.
CREDENTIAL_ENV = {
    "api_bible_key": "VERSESYNC_API_BIBLE_KEY",
    "esv_api_key": "VERSESYNC_ESV_API_KEY",
}


class ConfigError(Exception):
    """The configuration file exists but cannot be used."""


class Secret:
    """A credential that will not leak through logging or serialisation."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __bool__(self) -> bool:
        return bool(self._value)

    def __repr__(self) -> str:
        return "Secret(<redacted>)"

    def __str__(self) -> str:
        return "<redacted>"

    def __format__(self, spec: str) -> str:
        return "<redacted>"

    def __reduce__(self) -> NoReturn:
        raise TypeError("Secret cannot be pickled")

    def __copy__(self) -> Secret:
        return self

    def __deepcopy__(self, memo: dict[int, Any]) -> Secret:
        return self


@dataclass(frozen=True)
class Credentials:
    api_bible_key: Secret = field(default_factory=lambda: Secret(""), repr=False)
    esv_api_key: Secret = field(default_factory=lambda: Secret(""), repr=False)


@dataclass(frozen=True)
class Config:
    idle_timeout_s: float
    allowed_origins: tuple[str, ...]
    transcription: dict[str, Any]
    provider_id: str
    credentials: Credentials

    def public_dict(self) -> dict[str, Any]:
        """Everything except credentials; safe to log or return over HTTP."""
        return {
            "idle_timeout_s": self.idle_timeout_s,
            "allowed_origins": list(self.allowed_origins),
            "transcription": copy.deepcopy(self.transcription),
            "provider_id": self.provider_id,
        }


def _deep_update(base: dict[str, Any], update: dict[str, Any]) -> None:
    for key, value in update.items():
        if isinstance(base.get(key), dict) and isinstance(value, dict):
            _deep_update(base[key], value)
        else:
            base[key] = value


def _read_yaml(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        logger.info("config file not found, using defaults", extra={"path": str(path)})
        return {}
    except OSError as e:
        raise ConfigError(f"Cannot read the configuration file {path}: {e.strerror or e}") from e
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ConfigError(f"The configuration file {path} is not valid YAML.") from e
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"The configuration file {path} must contain a mapping at top level.")
    return data


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ConfigError(f"{name} must be a non-negative number.")
    return float(value)


def load_config(path: Path | None = None, env: dict[str, str] | None = None) -> Config:
    """Load defaults, merge the YAML file over them, then apply credential env overrides."""
    env = dict(os.environ) if env is None else env
    merged = copy.deepcopy(DEFAULT_CONFIG)
    _deep_update(merged, _read_yaml(path if path is not None else paths.config_path()))

    sidecar = merged["sidecar"]
    origins = sidecar["allowed_origins"]
    if not isinstance(origins, list) or not all(isinstance(o, str) for o in origins):
        raise ConfigError("sidecar.allowed_origins must be a list of strings.")

    secrets_in: dict[str, str] = {}
    for key, env_name in CREDENTIAL_ENV.items():
        value = env.get(env_name) or merged["credentials"].get(key) or ""
        secrets_in[key] = str(value)

    return Config(
        idle_timeout_s=_number(sidecar["idle_timeout_s"], "sidecar.idle_timeout_s"),
        allowed_origins=tuple(origins),
        transcription=dict(merged["transcription"]),
        provider_id=str(merged["provider"]["id"]),
        credentials=Credentials(
            api_bible_key=Secret(secrets_in["api_bible_key"]),
            esv_api_key=Secret(secrets_in["esv_api_key"]),
        ),
    )
