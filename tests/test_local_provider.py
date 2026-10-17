from __future__ import annotations

import gzip
import json
import socket
from pathlib import Path
from typing import Any

import pytest

from versesync.bible.base import (
    BibleError,
    PassageNotFound,
    TranslationNotLicensed,
)
from versesync.bible.format import format_passage
from versesync.bible.local import LocalProvider
from versesync.detect.canon import load_canon
from versesync.types import Reference


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket, "socket", refuse)


def _ref(osis: str, chapter: int, verse: int | None = None, end: int | None = None) -> Reference:
    book = load_canon().by_osis(osis)
    return Reference(book.name, osis, chapter, verse, end)


def _format(provider: LocalProvider, ref: Reference, **kw: Any) -> Any:
    translation = provider.list_translations()[0]
    raw = provider.fetch(ref, translation.id)
    return format_passage(raw, translation, load_canon(), source="local", **kw)


def test_default_translation_is_bundled_kjv() -> None:
    (kjv,) = LocalProvider().list_translations()
    assert (kjv.id, kjv.abbreviation, kjv.attribution) == ("kjv", "KJV", "Public domain.")
    assert kjv.cache_allowed is True


def test_john_3_16_formats_as_verseflow() -> None:
    passage = _format(LocalProvider(), _ref("John", 3, 16))
    assert passage.reference_display == "John 3:16 (KJV)"
    assert passage.body.startswith("16 For God so loved")
    assert passage.source == "local"
    assert not passage.truncated


def test_range_has_both_verses() -> None:
    raw = LocalProvider().fetch(_ref("1Cor", 6, 19, 20), "kjv")
    assert [v.verse for v in raw.verses] == [19, 20]
    assert raw.reference.osis == "1Cor"
    assert json.loads(raw.payload)[0]["verse"] == 19


def test_long_range_truncates_to_six() -> None:
    passage = _format(LocalProvider(), _ref("Ps", 23, 1, 6))
    assert not passage.truncated
    raw = LocalProvider().fetch(_ref("John", 1, 1, 10), "kjv")
    assert len(raw.verses) == 10
    passage = format_passage(raw, LocalProvider().list_translations()[0], load_canon())
    assert len(passage.verses) == 6
    assert passage.truncated is True


def test_fetch_chapter_returns_every_verse() -> None:
    raw = LocalProvider().fetch_chapter("Ps", 23, "kjv")
    assert len(raw.verses) == 6
    assert raw.reference.verse is None
    assert raw.reference.book == "Psalms"


def test_chapter_only_reference_is_not_found() -> None:
    with pytest.raises(PassageNotFound):
        LocalProvider().fetch(_ref("John", 3), "kjv")


@pytest.mark.parametrize(
    "ref",
    [_ref("John", 3, 99), _ref("John", 3, 16, 99), _ref("John", 99, 1), _ref("John", 3, 16, 15)],
)
def test_out_of_range_is_not_found(ref: Reference) -> None:
    with pytest.raises(PassageNotFound):
        LocalProvider().fetch(ref, "kjv")


def test_chapter_out_of_range_is_not_found() -> None:
    with pytest.raises(PassageNotFound):
        LocalProvider().fetch_chapter("John", 99, "kjv")


def test_unknown_translation_is_not_licensed() -> None:
    provider = LocalProvider()
    with pytest.raises(TranslationNotLicensed):
        provider.fetch(_ref("John", 3, 16), "esv")
    with pytest.raises(TranslationNotLicensed):
        provider.fetch_chapter("John", 3, "esv")


def test_all_errors_are_bible_errors() -> None:
    provider = LocalProvider()
    for call in (
        lambda: provider.fetch(_ref("John", 3), "kjv"),
        lambda: provider.fetch(_ref("John", 3, 99), "kjv"),
        lambda: provider.fetch(_ref("John", 3, 16), "nope"),
    ):
        with pytest.raises(BibleError):
            call()


def test_extra_store_adds_translation(tmp_path: Path) -> None:
    store = {
        "translation": {
            "id": "tst",
            "abbreviation": "TST",
            "name": "Test Version",
            "attribution": "Test only.",
            "cache_allowed": False,
        },
        "books": [{"osis": "John", "chapters": [["a"], ["b"], ["c one", "c two"]]}],
    }
    with gzip.open(tmp_path / "tst.json.gz", "wt", encoding="utf-8") as f:
        json.dump(store, f)
    provider = LocalProvider(tmp_path)
    ids = [t.id for t in provider.list_translations()]
    assert ids == ["kjv", "tst"]
    raw = provider.fetch(_ref("John", 3, 1, 2), "tst")
    assert [v.text for v in raw.verses] == ["c one", "c two"]
    assert not provider.list_translations()[1].cache_allowed
    with pytest.raises(PassageNotFound):
        provider.fetch(_ref("Gen", 1, 1), "tst")
