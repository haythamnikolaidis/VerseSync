"""Checks on the generated canon table."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CANON_PATH = ROOT / "sidecar" / "versesync" / "detect" / "data" / "canon.json"
GENERATOR_PATH = ROOT / "tools" / "generate_canon.py"


@pytest.fixture(scope="module")
def canon() -> list[dict]:
    return json.loads(CANON_PATH.read_text(encoding="utf-8"))


def _book(canon: list[dict], osis: str) -> dict:
    return next(b for b in canon if b["osis"] == osis)


def test_totals(canon: list[dict]) -> None:
    assert len(canon) == 66
    assert sum(b["chapter_count"] for b in canon) == 1189
    assert sum(sum(b["verse_counts"]) for b in canon) == 31102
    for b in canon:
        assert len(b["verse_counts"]) == b["chapter_count"]


def test_known_counts(canon: list[dict]) -> None:
    assert _book(canon, "Ps")["verse_counts"][118] == 176
    assert _book(canon, "Jude")["chapter_count"] == 1
    assert sum(_book(canon, "Obad")["verse_counts"]) == 21
    assert _book(canon, "3John")["verse_counts"] == [14]


def test_names(canon: list[dict]) -> None:
    psalms = _book(canon, "Ps")
    assert psalms["name"] == "Psalms"
    assert psalms["display_name"] == "Psalm"
    for b in canon:
        if b["osis"] != "Ps":
            assert b["display_name"] == b["name"]


def test_aliases_are_normalised(canon: list[dict]) -> None:
    for b in canon:
        for alias in b["aliases"]:
            assert alias == " ".join(alias.split())
            assert alias.isascii()
            assert all(ch.isalnum() or ch == " " for ch in alias)
            assert alias == alias.lower()


def test_no_alias_maps_to_two_books(canon: list[dict]) -> None:
    owner: dict[str, str] = {}
    for b in canon:
        for alias in b["aliases"]:
            assert owner.setdefault(alias, b["osis"]) == b["osis"], alias


def test_spoken_forms(canon: list[dict]) -> None:
    owner = {a: b["osis"] for b in canon for a in b["aliases"]}
    assert owner["psalm"] == owner["psalms"] == "Ps"
    assert owner["song of solomon"] == owner["song of songs"] == owner["canticles"] == "Song"
    assert owner["revelation"] == owner["revelations"] == "Rev"
    assert owner["one corinthians"] == "1Cor"


def test_numbered_books_have_all_ordinal_forms(canon: list[dict]) -> None:
    bases = {
        "samuel",
        "kings",
        "chronicles",
        "corinthians",
        "thessalonians",
        "timothy",
        "peter",
        "john",
    }
    numbered = [b for b in canon if b["numbered"]]
    assert {b["base"] for b in numbered} == bases
    forms = {
        1: ["1", "first", "1st", "i", "one"],
        2: ["2", "second", "2nd", "ii", "two"],
        3: ["3", "third", "3rd", "iii", "three"],
    }
    for b in numbered:
        for prefix in forms[b["ordinal"]]:
            assert f"{prefix} {b['base']}" in b["aliases"], (b["osis"], prefix)
    assert not any(b["numbered"] for b in canon if b["osis"] == "John")


def test_generator_reproduces_file_byte_for_byte(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location("generate_canon", GENERATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    out = tmp_path / "canon.json"
    assert module.main(["generate_canon.py", str(out)]) == 0
    assert out.read_bytes() == CANON_PATH.read_bytes()
