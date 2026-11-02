"""Parse an EasyWorship scripture export into entries (docs/14 sections 2 and 3).

A port of VerseFlow's ``scripture-parser.js``: ``body`` and ``word_count`` are computed exactly as
its ``_finalize`` does, so the same file gives the same graphics in both tools (FR-4.2).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from versesync.detect.canon import Canon
from versesync.detect.parse import InvalidReference, parse_reference
from versesync.types import Reference

# VerseFlow's REFERENCE_RE. [0-9] stands in for JavaScript's ASCII-only \d, since Python's \d
# also matches other Unicode digits.
_REFERENCE_LINE = re.compile(
    r"((?:[0-9]+\s+)?[A-Za-z][A-Za-z ]*?\s+[0-9]+:[0-9]+(?:-[0-9]+)?)\s*\(([A-Za-z0-9]+)\)"
)
_LINE_BREAK = re.compile(r"\r?\n")
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class ExportEntry:
    index: int  # 0-based position in the file, repeats counted
    reference_line: str  # verbatim, e.g. "James 1:2-4 (NIV)"
    reference: Reference
    translation: str  # "NIV"
    lines: tuple[str, ...]  # verse lines, stripped
    body: str  # lines joined by single spaces, verse numbers kept
    word_count: int


@dataclass(frozen=True)
class ExportWarning:
    """A problem with part of the file; ``line`` is the 1-based line it was found on."""

    code: str
    message: str
    line: int

    def to_json(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "line": self.line}


class ScriptureFileEmpty(Exception):
    """The file has no usable entry (07 section 3 code ``scripture_file_empty``)."""

    code = "scripture_file_empty"

    def __init__(self) -> None:
        super().__init__("The scripture file has no readable scripture entries.")
        self.message = str(self)


def parse_scripture_file(path: Path, canon: Canon) -> tuple[list[ExportEntry], list[ExportWarning]]:
    """Read ``path`` and return its entries in file order, plus a warning for each skipped part.

    Raises ``ScriptureFileEmpty`` when no entry is valid.
    """
    # utf-8-sig drops a byte-order mark and leaves BOM-less text alone.
    text = path.read_text(encoding="utf-8-sig")
    entries: list[ExportEntry] = []
    warnings: list[ExportWarning] = []
    # The open block: (line number, reference line, reference text, translation, verse lines).
    current: tuple[int, str, str, str, list[str]] | None = None

    def close() -> None:
        nonlocal current
        if current is None:
            return
        number, reference_line, reference_text, translation, lines = current
        current = None
        try:
            reference = parse_reference(reference_text, canon)
        except InvalidReference as exc:
            warnings.append(
                ExportWarning(
                    "export_reference_invalid",
                    f'Line {number}: "{reference_line}" skipped. {exc.message}',
                    number,
                )
            )
            return
        # Whitespace runs collapse to one space, like VerseFlow's _finalize.
        body = _WHITESPACE.sub(" ", " ".join(lines)).strip()
        entries.append(
            ExportEntry(
                index=len(entries),
                reference_line=reference_line,
                reference=reference,
                translation=translation,
                lines=tuple(lines),
                body=body,
                word_count=len(body.split()) if body else 0,
            )
        )

    for number, raw in enumerate(_LINE_BREAK.split(text), start=1):
        line = raw.strip()
        if line == "":
            close()
            continue
        match = _REFERENCE_LINE.fullmatch(line)
        if match:
            close()
            current = (number, line, match.group(1), match.group(2), [])
        elif current is not None:
            current[4].append(line)
        else:
            warnings.append(
                ExportWarning(
                    "export_block_unreferenced",
                    f'Line {number}: "{line}" is not under a scripture reference and was skipped.',
                    number,
                )
            )
    close()

    if not entries:
        raise ScriptureFileEmpty()
    return entries, warnings
