from __future__ import annotations

import json
import logging
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from versesync.bible.api_bible import OSIS_TO_USFM, ApiBibleProvider, parse_verses
from versesync.bible.base import (
    BibleError,
    PassageNotFound,
    ProviderUnavailable,
    RateLimited,
    RawPassage,
    TranslationNotLicensed,
)
from versesync.bible.format import format_passage, to_verseflow_block
from versesync.bible.local import LocalProvider
from versesync.detect.canon import load_canon
from versesync.types import Reference

FIXTURES = Path(__file__).parent / "fixtures" / "api_bible"
KEY = "sk-test-0123456789-secret"
KJV_ID = "de4e12af7f28f599-01"
BASE = "https://api.example.test/v1"
CONFIG = {KJV_ID: {"attribution": "Public domain.", "cache_allowed": True}}


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket, "socket", refuse)


def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))  # type: ignore[no-any-return]


class FakeTransport:
    """Records requests and answers from a ``{url suffix: (status, fixture)}`` table."""

    def __init__(self, routes: dict[str, tuple[int, str]]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, dict[str, str], float]] = []

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, dict[str, Any]]:
        self.calls.append((url, dict(headers), timeout))
        path = url.split("?")[0]
        for suffix, (status, name) in self.routes.items():
            if path.endswith(suffix):
                return status, _load(name)
        return 404, _load("error_404.json")


def _provider(routes: dict[str, tuple[int, str]]) -> tuple[ApiBibleProvider, FakeTransport]:
    transport = FakeTransport(routes)
    return ApiBibleProvider(KEY, BASE, transport, CONFIG, sleep=lambda _s: None), transport


def _ref(osis: str, chapter: int, verse: int | None = None, end: int | None = None) -> Reference:
    book = load_canon().by_osis(osis)
    return Reference(book.name, osis, chapter, verse, end)


def test_osis_to_usfm_covers_the_canon() -> None:
    osis = [b.osis for b in load_canon().books]
    assert sorted(OSIS_TO_USFM) == sorted(osis)
    assert all(len(u) == 3 and u == u.upper() for u in OSIS_TO_USFM.values())
    assert len(set(OSIS_TO_USFM.values())) == 66


def test_list_translations_uses_config_for_attribution_and_caching() -> None:
    provider, transport = _provider({"/bibles": (200, "bibles.json")})
    by_abbr = {t.abbreviation: t for t in provider.list_translations()}
    assert set(by_abbr) == {"KJV", "ASV", "WEB"}
    kjv = by_abbr["KJV"]
    assert (kjv.id, kjv.attribution, kjv.cache_allowed) == (KJV_ID, "Public domain.", True)
    # No config entry: nothing is inferred and caching is off.
    assert (by_abbr["ASV"].attribution, by_abbr["ASV"].cache_allowed) == ("", False)
    assert transport.calls[0][0] == f"{BASE}/bibles"
    assert transport.calls[0][1]["api-key"] == KEY


def test_fetch_builds_osis_passage_id() -> None:
    provider, transport = _provider({"1CO.6.19-1CO.6.20": (200, "passage_range.json")})
    raw = provider.fetch(_ref("1Cor", 6, 19, 20), KJV_ID)
    url = transport.calls[0][0]
    assert f"/bibles/{KJV_ID}/passages/1CO.6.19-1CO.6.20?" in url
    assert "include-verse-numbers=true" in url
    assert [v.verse for v in raw.verses] == [19, 20]
    assert raw.reference.osis == "1Cor"


def test_single_verse_passage_id() -> None:
    provider, transport = _provider({"JHN.3.16": (200, "passage_single.json")})
    raw = provider.fetch(_ref("John", 3, 16), KJV_ID)
    assert "/passages/JHN.3.16?" in transport.calls[0][0]
    assert [v.verse for v in raw.verses] == [16]


def test_chapter_only_reference_is_not_a_passage() -> None:
    provider, _ = _provider({})
    with pytest.raises(PassageNotFound):
        provider.fetch(_ref("John", 3), KJV_ID)


def test_fetch_chapter_uses_chapter_passage_id() -> None:
    provider, transport = _provider({"JHN.3": (200, "passage_single.json")})
    raw = provider.fetch_chapter("John", 3, KJV_ID)
    assert "/passages/JHN.3?" in transport.calls[0][0]
    assert raw.reference == _ref("John", 3)


def test_parse_verses_splits_on_markers_and_keeps_markup() -> None:
    html = (
        '<p class="p"><span class="v" data-number="1">1</span>In <em>the</em> beginning</p>'
        '<p class="q"><span data-number="2" class="v">2</span>and the earth</p>'
    )
    verses = parse_verses(html)
    assert [v.verse for v in verses] == [1, 2]
    assert "<em>the</em>" in verses[0].text
    assert parse_verses("<p>no markers</p>") == ()


@pytest.mark.parametrize(
    ("fixture", "ref"),
    [
        ("passage_single.json", _ref("John", 3, 16)),
        ("passage_range.json", _ref("1Cor", 6, 19, 20)),
    ],
)
def test_output_is_identical_to_local_provider(fixture: str, ref: Reference) -> None:
    canon = load_canon()
    local = LocalProvider()
    local_t = local.list_translations()[0]
    local_passage = format_passage(local.fetch(ref, local_t.id), local_t, canon, source="local")

    provider = ApiBibleProvider(
        KEY,
        BASE,
        FakeTransport({"/bibles": (200, "bibles.json"), "/passages/" + _pid(ref): (200, fixture)}),
        CONFIG,
    )
    api_t = next(t for t in provider.list_translations() if t.abbreviation == "KJV")
    api_passage = format_passage(provider.fetch(ref, api_t.id), api_t, canon, source="local")

    assert api_passage.reference_display == local_passage.reference_display
    assert api_passage.body == local_passage.body
    assert api_passage.verses == local_passage.verses
    assert api_passage.word_count == local_passage.word_count
    assert to_verseflow_block(api_passage).encode("utf-8") == (
        to_verseflow_block(local_passage).encode("utf-8")
    )


def _pid(ref: Reference) -> str:
    usfm = OSIS_TO_USFM[ref.osis]
    start = f"{usfm}.{ref.chapter}.{ref.verse}"
    return start if ref.verse_end is None else f"{start}-{usfm}.{ref.chapter}.{ref.verse_end}"


@pytest.mark.parametrize(
    ("status", "fixture", "error"),
    [
        (404, "error_404.json", PassageNotFound),
        (429, "error_429.json", RateLimited),
        (503, "error_503.json", ProviderUnavailable),
        (401, "error_404.json", TranslationNotLicensed),
        (403, "error_404.json", TranslationNotLicensed),
    ],
)
def test_error_responses_raise_typed_errors(status: int, fixture: str, error: type) -> None:
    provider, _ = _provider({"JHN.3.16": (status, fixture)})
    with pytest.raises(error):
        provider.fetch(_ref("John", 3, 16), KJV_ID)


def test_key_never_appears_in_logs_or_repr(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    provider, _ = _provider(
        {
            "/bibles": (200, "bibles.json"),
            "JHN.3.16": (200, "passage_single.json"),
            "1CO.6.19-1CO.6.20": (503, "error_503.json"),
        }
    )
    provider.list_translations()
    provider.fetch(_ref("John", 3, 16), KJV_ID)
    with pytest.raises(ProviderUnavailable) as err:
        provider.fetch(_ref("1Cor", 6, 19, 20), KJV_ID)
    assert caplog.records
    for record in caplog.records:
        assert KEY not in record.getMessage()
        assert KEY not in str(record.__dict__)
    assert KEY not in repr(provider)
    assert KEY not in str(provider)
    assert KEY not in str(err.value)
    assert KEY not in repr(vars(provider).get("_config"))


def test_network_failure_and_timeout_map_to_provider_unavailable() -> None:
    for exc in (ConnectionError("down"), TimeoutError("slow"), socket.gaierror("dns")):

        def failing(
            url: str, headers: Mapping[str, str], timeout: float, exc: OSError = exc
        ) -> Any:
            raise exc

        provider = ApiBibleProvider(KEY, BASE, failing, CONFIG)
        with pytest.raises(ProviderUnavailable):
            provider.fetch(_ref("John", 3, 16), KJV_ID)


def test_rate_limit_backs_off_once_and_retries_once() -> None:
    sleeps: list[float] = []
    responses = [(429, _load("error_429.json")), (200, _load("passage_single.json"))]
    calls: list[str] = []

    def transport(url: str, headers: Mapping[str, str], timeout: float) -> Any:
        calls.append(url)
        return responses[len(calls) - 1]

    provider = ApiBibleProvider(KEY, BASE, transport, CONFIG, sleep=sleeps.append)
    raw = provider.fetch(_ref("John", 3, 16), KJV_ID)
    assert [v.verse for v in raw.verses] == [16]
    assert len(calls) == 2
    assert len(sleeps) == 1


def test_persistent_rate_limit_stops_after_exactly_one_retry() -> None:
    sleeps: list[float] = []
    provider, transport = _provider({"JHN.3.16": (429, "error_429.json")})
    provider = ApiBibleProvider(KEY, BASE, transport, CONFIG, sleep=sleeps.append)
    with pytest.raises(RateLimited):
        provider.fetch(_ref("John", 3, 16), KJV_ID)
    assert len(transport.calls) == 2
    assert len(sleeps) == 1


def test_other_errors_are_not_retried() -> None:
    sleeps: list[float] = []
    for status in (404, 503, 401, 403):
        transport = FakeTransport({"JHN.3.16": (status, "error_404.json")})
        provider = ApiBibleProvider(KEY, BASE, transport, CONFIG, sleep=sleeps.append)
        with pytest.raises(BibleError):
            provider.fetch(_ref("John", 3, 16), KJV_ID)
        assert len(transport.calls) == 1
    assert sleeps == []


def _batch_transport(calls: list[str]) -> Any:
    """Answers any passage request with the verses its id asks for, from the KJV fixture."""

    def transport(
        url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, dict[str, Any]]:
        calls.append(url)
        pid = url.split("/passages/")[1].split("?")[0]
        first, _, last = pid.partition("-")
        lo = int(first.split(".")[2])
        hi = int(last.split(".")[2]) if last else lo
        html = "".join(
            f'<p><span data-number="{n}" class="v">{n}</span>verse {n} </p>'
            for n in range(lo, hi + 1)
        )
        return 200, {"data": {"id": pid, "content": html}}

    return transport


def test_adjacent_and_overlapping_verses_cost_one_request() -> None:
    calls: list[str] = []
    provider = ApiBibleProvider(KEY, BASE, _batch_transport(calls), CONFIG)
    refs = [_ref("John", 3, 16), _ref("John", 3, 17), _ref("John", 3, 17, 19), _ref("John", 3, 18)]
    result = provider.fetch_many(refs, KJV_ID)
    assert len(calls) == 1
    assert "/passages/JHN.3.16-JHN.3.19?" in calls[0]
    for ref in refs:
        raw = result[ref]
        assert isinstance(raw, RawPassage)
        last = ref.verse_end or ref.verse
        assert [v.verse for v in raw.verses] == list(range(ref.verse or 0, (last or 0) + 1))
        assert raw.reference == ref


def test_twenty_references_cost_at_most_twenty_requests() -> None:
    calls: list[str] = []
    provider = ApiBibleProvider(KEY, BASE, _batch_transport(calls), CONFIG)
    refs = [_ref("John", c, v) for c in range(1, 11) for v in (3, 9)]
    result = provider.fetch_many(refs, KJV_ID)
    assert len(refs) == 20
    assert len(calls) <= 20
    assert len(calls) == 20  # gaps and different chapters are never merged
    assert all(isinstance(result[r], RawPassage) for r in refs)


def test_fetch_many_reports_errors_per_reference_and_keeps_going() -> None:
    provider, transport = _provider(
        {"JHN.3.16": (200, "passage_single.json"), "1CO.6.19-1CO.6.20": (503, "error_503.json")}
    )
    good, bad = _ref("John", 3, 16), _ref("1Cor", 6, 19, 20)
    result = provider.fetch_many([good, bad], KJV_ID)
    assert isinstance(result[good], RawPassage)
    assert isinstance(result[bad], ProviderUnavailable)
    assert len(transport.calls) == 2


def test_fetch_many_raises_translation_not_licensed() -> None:
    provider, _ = _provider({"JHN.3.16": (403, "error_404.json")})
    with pytest.raises(TranslationNotLicensed):
        provider.fetch_many([_ref("John", 3, 16)], KJV_ID)
