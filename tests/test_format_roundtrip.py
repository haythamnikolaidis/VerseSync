"""Round trip: a Passage rendered as a VerseFlow .txt block and parsed by VerseFlow's own
scripture-parser.js must give back the identical reference, translation and body (06 section 2).

The parser under test is a verbatim copy of VerseFlow's ``js/scripture-parser.js`` kept in
``tests/fixtures/verseflow``. It is executed for real under Node when Node is available, and its
reference regex is additionally extracted from the file and applied in Python so the check also
runs where Node is absent. If a VerseFlow checkout is found the copy is compared with it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from versesync.bible.base import Reference
from versesync.bible.format import Passage, format_passage, to_verseflow_txt
from versesync.bible.local import LocalProvider
from versesync.detect.canon import load_canon

pytestmark = pytest.mark.usefixtures("no_network")

PARSER = Path(__file__).parent / "fixtures" / "verseflow" / "scripture-parser.js"
PARSER_SOURCE = PARSER.read_text(encoding="utf-8")

# The published regex from the task spec; the extracted one must equal it.
SPEC_REGEX = r"^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$"

NODE_RUNNER = """
const vm = require('vm');
const fs = require('fs');
const window = {};
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), { window, console: { warn() {} } });
const text = fs.readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify(window.VFParser.parseScriptures(text)));
"""

_provider = LocalProvider()
_web = _provider.list_translations()[0]


def passage(book: str, chapter: int, verse: int | None = None, end: int | None = None) -> Passage:
    raw = _provider.fetch(Reference(book, chapter, verse, end), _web.id)
    return format_passage(raw, _web, source="local")


def sample_passages() -> list[Passage]:
    return [
        passage("John", 3, 16),
        passage("1Cor", 6, 19, 20),
        passage("Ps", 23),
        passage("Jude", 1),
        passage("Song", 2, 1, 4),
        passage("Phlm", 1, 4, 6),
        passage("3John", 1, 14),
    ]


def all_chapter_passages() -> list[Passage]:
    out: list[Passage] = []
    for book in load_canon().books:
        for chapter in range(1, book.chapter_count + 1):
            out.append(passage(book.osis, chapter))
    return out


def extracted_regex() -> re.Pattern[str]:
    match = re.search(r"var REFERENCE_RE = /(.+)/;", PARSER_SOURCE)
    assert match, "REFERENCE_RE not found in the VerseFlow parser"
    return re.compile(match.group(1))


def verseflow_checkout() -> Path | None:
    candidates = [os.environ.get("VERSEFLOW_DIR"), str(Path(__file__).parents[2] / "verseflow")]
    for c in candidates:
        if c and (Path(c) / "js" / "scripture-parser.js").is_file():
            return Path(c)
    return None


def run_vf_parser(txt: str) -> list[dict]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    result = subprocess.run(  # noqa: S603
        [node, "-e", NODE_RUNNER, str(PARSER)],
        input=txt.encode("utf-8"),
        capture_output=True,
        check=True,
        timeout=60,
    )
    parsed: list[dict] = json.loads(result.stdout.decode("utf-8"))
    return parsed


def test_vendored_regex_is_the_published_one() -> None:
    assert extracted_regex().pattern == SPEC_REGEX


def test_vendored_parser_matches_verseflow_checkout() -> None:
    checkout = verseflow_checkout()
    if checkout is None:
        pytest.skip("no VerseFlow checkout available")
    live = (checkout / "js" / "scripture-parser.js").read_bytes()
    assert live == PARSER.read_bytes()


def test_roundtrip_through_the_real_parser() -> None:
    passages = sample_passages()
    parsed = run_vf_parser(to_verseflow_txt(passages))
    assert len(parsed) == len(passages)
    for p, got in zip(passages, parsed, strict=True):
        assert got["reference"] == p.reference_display
        assert got["translation"] == p.translation.abbreviation
        assert got["body"] == p.body
        assert got["wordCount"] == p.word_count


def test_roundtrip_every_chapter_of_the_bible_through_the_real_parser() -> None:
    passages = all_chapter_passages()
    assert len(passages) == 1189
    parsed = run_vf_parser(to_verseflow_txt(passages))
    assert len(parsed) == 1189
    for p, got in zip(passages, parsed, strict=True):
        assert (got["reference"], got["translation"], got["body"]) == (
            p.reference_display,
            "WEB",
            p.body,
        )


def test_reference_lines_match_the_regex_without_node() -> None:
    regex = extracted_regex()
    for p in all_chapter_passages() + sample_passages():
        m = regex.match(p.reference_display)
        assert m is not None, p.reference_display
        assert m.group(1) + " (" + m.group(2) + ")" == p.reference_display
        assert m.group(2) == "WEB"
        assert "–" not in p.reference_display


def test_body_survives_the_parsers_line_rules() -> None:
    # The parser splits on newlines and collapses whitespace; the body must already be stable.
    for p in all_chapter_passages():
        assert "\n" not in p.body
        assert p.body == re.sub(r"\s+", " ", p.body).strip()
        # A body line must never be mistaken for a reference line.
        assert extracted_regex().match(p.body) is None
