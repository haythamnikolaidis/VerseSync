"""Structured (JSON lines) logging to a file.

The log path is reported to the editor whenever the sidecar fails (docs/03-architecture.md §8),
so the file must exist and be writable before anything else can go wrong.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import time
from pathlib import Path
from typing import Any

# Attributes every LogRecord carries; anything else came in through ``extra=``.
_STANDARD_ATTRS = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}

_MAX_BYTES = 1_000_000
_BACKUP_COUNT = 3


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class RedactFilter(logging.Filter):
    """Replaces any occurrence of the given secret strings in the rendered message."""

    def __init__(self, secrets: list[str]) -> None:
        super().__init__()
        self._secrets = [s for s in secrets if s]

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if any(s in message for s in self._secrets):
            for s in self._secrets:
                message = message.replace(s, "<redacted>")
            record.msg = message
            record.args = None
        return True


def configure_logging(
    log_path: Path, *, redact: list[str] | None = None, level: int = logging.INFO
) -> logging.Handler:
    """Attach a rotating JSON file handler to the ``versesync`` logger and return it."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8"
    )
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactFilter(redact or []))
    root = logging.getLogger("versesync")
    root.setLevel(level)
    root.addHandler(handler)
    return handler


def remove_handler(handler: logging.Handler) -> None:
    logging.getLogger("versesync").removeHandler(handler)
    handler.close()
