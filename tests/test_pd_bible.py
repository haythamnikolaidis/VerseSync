"""Checks on the bundled public-domain KJV text."""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path

import pytest

KJV_PATH = (
    Path(__file__).resolve().parent.parent
    / "sidecar"
    / "versesync"
    / "bible"
    / "data"
    / "kjv.json.gz"
)


def _load() -> dict:
    with gzip.open(KJV_PATH, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def kjv() -> dict:
    return _load()


def _book(kjv: dict, osis: str) -> dict:
    return next(b for b in kjv["books"] if b["osis"] == osis)


def test_translation_metadata(kjv: dict) -> None:
    assert kjv["translation"] == {
        "id": "kjv",
        "abbreviation": "KJV",
        "name": "King James Version",
        "attribution": "Public domain.",
    }


def test_totals(kjv: dict) -> None:
    books = kjv["books"]
    assert len(books) == 66
    assert sum(len(b["chapters"]) for b in books) == 1189
    assert sum(len(c) for b in books for c in b["chapters"]) == 31102


def test_book_order_and_ids(kjv: dict) -> None:
    ids = [b["osis"] for b in kjv["books"]]
    assert len(set(ids)) == 66
    assert ids[0] == "Gen" and ids[-1] == "Rev"
    assert ids[18] == "Ps" and ids[21] == "Song" and ids[45] == "1Cor"


def test_known_passages(kjv: dict) -> None:
    assert _book(kjv, "Gen")["chapters"][0][0].startswith("In the beginning")
    assert len(_book(kjv, "Ps")["chapters"][118]) == 176
    assert len(_book(kjv, "3John")["chapters"][0]) == 14


def test_no_empty_or_marked_up_verses(kjv: dict) -> None:
    for book in kjv["books"]:
        for chapter in book["chapters"]:
            assert chapter
            for text in chapter:
                assert text
                assert text == " ".join(text.split())
                assert not any(ch in text for ch in "[]¶{}<>")


def test_load_time_under_200ms() -> None:
    start = time.perf_counter()
    _load()
    assert time.perf_counter() - start < 0.2


def test_compressed_size_under_limit() -> None:
    assert KJV_PATH.stat().st_size < 1_500_000
