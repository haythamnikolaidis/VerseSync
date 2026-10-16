"""API.Bible adapter (06 sections 3.1, 5 and 8).

The HTTP transport is injected as ``fetch_json(url, headers, timeout) -> (status, body)`` so
the adapter never touches the network itself. The API key is held privately: it is never
logged, never part of ``repr()`` and never serialised.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import quote

from versesync.bible.base import (
    PassageNotFound,
    ProviderUnavailable,
    RateLimited,
    RawPassage,
    RawVerse,
    Translation,
    TranslationNotLicensed,
)
from versesync.detect.canon import load_canon
from versesync.types import Reference

log = logging.getLogger(__name__)

FetchJson = Callable[[str, Mapping[str, str], float], tuple[int, dict[str, Any]]]

# OSIS book ids (the canon's ids) to the uppercase USFM ids API.Bible uses in passage ids.
OSIS_TO_USFM: dict[str, str] = {
    "Gen": "GEN", "Exod": "EXO", "Lev": "LEV", "Num": "NUM", "Deut": "DEU",
    "Josh": "JOS", "Judg": "JDG", "Ruth": "RUT", "1Sam": "1SA", "2Sam": "2SA",
    "1Kgs": "1KI", "2Kgs": "2KI", "1Chr": "1CH", "2Chr": "2CH", "Ezra": "EZR",
    "Neh": "NEH", "Esth": "EST", "Job": "JOB", "Ps": "PSA", "Prov": "PRO",
    "Eccl": "ECC", "Song": "SNG", "Isa": "ISA", "Jer": "JER", "Lam": "LAM",
    "Ezek": "EZK", "Dan": "DAN", "Hos": "HOS", "Joel": "JOL", "Amos": "AMO",
    "Obad": "OBA", "Jonah": "JON", "Mic": "MIC", "Nah": "NAM", "Hab": "HAB",
    "Zeph": "ZEP", "Hag": "HAG", "Zech": "ZEC", "Mal": "MAL", "Matt": "MAT",
    "Mark": "MRK", "Luke": "LUK", "John": "JHN", "Acts": "ACT", "Rom": "ROM",
    "1Cor": "1CO", "2Cor": "2CO", "Gal": "GAL", "Eph": "EPH", "Phil": "PHP",
    "Col": "COL", "1Thess": "1TH", "2Thess": "2TH", "1Tim": "1TI", "2Tim": "2TI",
    "Titus": "TIT", "Phlm": "PHM", "Heb": "HEB", "Jas": "JAS", "1Pet": "1PE",
    "2Pet": "2PE", "1John": "1JN", "2John": "2JN", "3John": "3JN", "Jude": "JUD",
    "Rev": "REV",
}  # fmt: skip

# A verse-number marker: <span data-number="16" class="v">16</span> (attribute order varies).
_VERSE_MARKER = re.compile(
    r"<span\b(?=[^>]*\bclass=[\"']v[\"'])[^>]*>\s*(\d+)\s*</span>", re.IGNORECASE
)
_TIMEOUT_S = 10.0  # the 06 section 8 default for bible.api_bible.timeout_s
# Chosen, not specified: one short pause before the single retry after a 429 (06 section 3.2).
_RATE_LIMIT_BACKOFF_S = 2.0


class ApiBibleProvider:
    """Serves verse text from API.Bible v1 through an injected JSON transport."""

    id = "api_bible"

    def __init__(
        self,
        api_key: str,
        base_url: str,
        fetch_json: FetchJson,
        translations_config: Mapping[str, Mapping[str, Any]] | None = None,
        timeout_s: float = _TIMEOUT_S,
        sleep: Callable[[float], None] = time.sleep,
        rate_limit_backoff_s: float = _RATE_LIMIT_BACKOFF_S,
    ) -> None:
        self.__api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._fetch_json = fetch_json
        # Keyed by API.Bible bible id: {"attribution": str, "cache_allowed": bool}.
        self._config = dict(translations_config or {})
        self._timeout_s = timeout_s
        self._sleep = sleep
        self._backoff_s = rate_limit_backoff_s

    def __repr__(self) -> str:
        return f"ApiBibleProvider(base_url={self._base_url!r})"

    def list_translations(self) -> list[Translation]:
        body = self._get("/bibles")
        out: list[Translation] = []
        for item in body.get("data", []):
            bible_id = str(item["id"])
            conf = self._config.get(bible_id, {})
            out.append(
                Translation(
                    id=bible_id,
                    abbreviation=str(item.get("abbreviation") or item.get("name", bible_id)),
                    name=str(item.get("name", bible_id)),
                    # Never inferred: attribution and caching come from configuration only,
                    # and caching is off without an explicit entry (06 section 5).
                    attribution=str(conf.get("attribution", "")),
                    cache_allowed=bool(conf.get("cache_allowed", False)),
                )
            )
        return out

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        if ref.verse is None:
            raise PassageNotFound(
                "A chapter-only reference cannot be fetched as a passage; use fetch_chapter."
            )
        book = _usfm(ref.osis)
        start = f"{book}.{ref.chapter}.{ref.verse}"
        passage_id = (
            start if ref.verse_end is None else f"{start}-{book}.{ref.chapter}.{ref.verse_end}"
        )
        return self._passage(ref, translation_id, passage_id)

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        name = load_canon().by_osis(book_osis).name
        ref = Reference(name, book_osis, chapter)
        return self._passage(ref, translation_id, f"{_usfm(book_osis)}.{chapter}")

    def _passage(self, ref: Reference, translation_id: str, passage_id: str) -> RawPassage:
        path = (
            f"/bibles/{quote(translation_id, safe='')}/passages/{quote(passage_id, safe='.-')}"
            "?content-type=html&include-verse-numbers=true&include-notes=false"
            "&include-titles=false&include-chapter-numbers=false"
        )
        body = self._get(path)
        content = str(body.get("data", {}).get("content", ""))
        verses = parse_verses(content)
        if not verses:
            raise PassageNotFound(f"{passage_id} returned no verses in this translation.")
        return RawPassage(self.id, translation_id, ref, verses, json.dumps(body, sort_keys=True))

    def _get(self, path: str) -> dict[str, Any]:
        """GET with error mapping; one back-off and one retry after a 429 (06 section 3.2)."""
        try:
            return self._get_once(path)
        except RateLimited:
            self._sleep(self._backoff_s)
            return self._get_once(path)

    def _get_once(self, path: str) -> dict[str, Any]:
        url = self._base_url + path
        headers = {"api-key": self.__api_key, "accept": "application/json"}
        log.debug("API.Bible GET %s", url)
        try:
            status, body = self._fetch_json(url, headers, self._timeout_s)
        except OSError as err:  # connection failures and timeouts (TimeoutError is an OSError)
            raise ProviderUnavailable() from err
        if status == 200:
            return body
        if status == 404:
            raise PassageNotFound()
        if status == 429:
            raise RateLimited()
        if status in (401, 403):
            raise TranslationNotLicensed()
        raise ProviderUnavailable(f"The Bible text provider answered HTTP {status}.")


def _usfm(osis: str) -> str:
    try:
        return OSIS_TO_USFM[osis]
    except KeyError:
        raise PassageNotFound(f"'{osis}' is not a known book.") from None


def parse_verses(content: str) -> tuple[RawVerse, ...]:
    """Split API.Bible HTML on its verse-number markers; text keeps its markup."""
    marks = list(_VERSE_MARKER.finditer(content))
    verses: list[RawVerse] = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(content)
        verses.append(RawVerse(int(m.group(1)), content[m.end() : end]))
    return tuple(verses)
