from __future__ import annotations

import pytest

from versesync.bible.base import (
    BibleError,
    Passage,
    PassageNotFound,
    ProviderUnavailable,
    RateLimited,
    RawVerse,
    Translation,
    TranslationNotLicensed,
)
from versesync.types import Reference

TRANSLATION_KEYS = {"id", "abbreviation", "name", "attribution", "cache_allowed"}


def _translation() -> Translation:
    return Translation("kjv", "KJV", "King James Version", "Public domain.")


def test_translation_to_json_matches_07_keys() -> None:
    out = _translation().to_json()
    assert set(out) == TRANSLATION_KEYS
    assert out["cache_allowed"] is True


def test_passage_to_json_shape() -> None:
    ref = Reference("John", "John", 3, 16)
    p = Passage(
        reference=ref,
        reference_display="John 3:16 (KJV)",
        body="16 For God so loved",
        verses=(RawVerse(16, "For God so loved"),),
        word_count=5,
        translation=_translation(),
        truncated=False,
        source="local",
    )
    out = p.to_json()
    assert out["verses"] == [{"verse": 16, "text": "For God so loved"}]
    assert set(out["translation"]) == TRANSLATION_KEYS
    assert out["reference_display"] == "John 3:16 (KJV)"
    assert out["source"] == "local"
    assert out["truncated"] is False


@pytest.mark.parametrize(
    ("cls", "code"),
    [
        (ProviderUnavailable, "provider_unavailable"),
        (RateLimited, "rate_limited"),
        (PassageNotFound, "passage_not_found"),
        (TranslationNotLicensed, "translation_not_licensed"),
    ],
)
def test_errors_carry_code_and_message(cls: type[BibleError], code: str) -> None:
    assert issubclass(cls, BibleError)
    err = cls()
    assert err.code == code
    assert str(err)
    assert cls("custom text").message == "custom text"
