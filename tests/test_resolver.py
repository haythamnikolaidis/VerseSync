from __future__ import annotations

import pytest

from versesync.bible.base import (
    BibleError,
    PassageNotFound,
    ProviderUnavailable,
    RateLimited,
    RawPassage,
    RawVerse,
    Translation,
    TranslationNotLicensed,
)
from versesync.bible.resolver import Resolution, resolve_detections
from versesync.detect.canon import Canon
from versesync.types import Reference

TRANSLATION = Translation("t1", "TST", "Test", "Test attribution")


def _ref(canon: Canon, osis: str, chapter: int, verse: int | None = None, end: int | None = None):
    return Reference(canon.by_osis(osis).name, osis, chapter, verse, end)


class FakeProvider:
    """Fails on demand: ``errors`` maps (osis, chapter, verse) to the error to raise."""

    id = "fake"

    def __init__(self, errors: dict[tuple[str, int, int | None], BibleError] | None = None):
        self.errors = errors or {}
        self.calls: list[Reference] = []

    def list_translations(self) -> list[Translation]:
        return [TRANSLATION]

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        self.calls.append(ref)
        error = self.errors.get((ref.osis, ref.chapter, ref.verse))
        if error is not None:
            raise error
        last = ref.verse_end or ref.verse or 1
        verses = tuple(RawVerse(v, f"text {v}") for v in range((ref.verse or 1), last + 1))
        return RawPassage(self.id, translation_id, ref, verses, "")

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        raise AssertionError("not used")


def test_mixed_batch_flags_and_single_warning(canon: Canon) -> None:
    refs = [
        _ref(canon, "Rom", 8, 28),
        _ref(canon, "Rom", 8, 29),
        _ref(canon, "Rom", 8, 30),
        _ref(canon, "Rom", 8, 31),
    ]
    provider = FakeProvider(
        {
            ("Rom", 8, 29): ProviderUnavailable(),
            ("Rom", 8, 30): RateLimited(),
            ("Rom", 8, 31): PassageNotFound(),
        }
    )
    results, warnings = resolve_detections(refs, TRANSLATION, provider, canon)
    assert results[0].passage is not None and results[0].flags == ()
    assert results[1] == Resolution(None, ("text_unavailable",))
    assert results[2] == Resolution(None, ("text_unavailable",))
    assert results[3] == Resolution(None, ("passage_not_found",))
    assert warnings == [{"code": "provider_partial", "message": "2 passages could not be fetched."}]


def test_not_licensed_propagates(canon: Canon) -> None:
    provider = FakeProvider({("Rom", 8, 28): TranslationNotLicensed()})
    with pytest.raises(TranslationNotLicensed):
        resolve_detections([_ref(canon, "Rom", 8, 28)], TRANSLATION, provider, canon)


def test_chapter_only_never_hits_provider(canon: Canon) -> None:
    provider = FakeProvider()
    results, warnings = resolve_detections([_ref(canon, "Ps", 23)], TRANSLATION, provider, canon)
    assert results == [Resolution(None, ())]
    assert warnings == []
    assert provider.calls == []


def test_ten_verse_reference_is_long_passage(canon: Canon) -> None:
    provider = FakeProvider()
    results, _ = resolve_detections(
        [_ref(canon, "Ps", 119, 1, 10)], TRANSLATION, provider, canon, max_verses=6
    )
    assert results[0].flags == ("long_passage",)
    assert results[0].passage is not None and len(results[0].passage.verses) == 6


def test_progress_called_after_each_reference(canon: Canon) -> None:
    seen: list[tuple[int, int]] = []
    refs = [_ref(canon, "Ps", 23), _ref(canon, "Rom", 8, 28)]
    resolve_detections(
        refs, TRANSLATION, FakeProvider(), canon, progress=lambda d, t: seen.append((d, t))
    )
    assert seen == [(1, 2), (2, 2)]


class BatchProvider(FakeProvider):
    def __init__(self, first: BibleError | None, outcomes: list | None = None) -> None:
        super().__init__()
        self.first = first
        self.outcomes = outcomes
        self.batches = 0

    def fetch_many(self, refs, translation_id):  # type: ignore[no-untyped-def]
        self.batches += 1
        if self.first is not None and self.batches == 1:
            raise self.first
        if self.outcomes is not None:
            return self.outcomes
        return [self.fetch(r, translation_id) for r in refs]


def test_fetch_many_is_used_and_rate_limit_retried_once(canon: Canon) -> None:
    provider = BatchProvider(RateLimited())
    results, warnings = resolve_detections(
        [_ref(canon, "Rom", 8, 28)], TRANSLATION, provider, canon
    )
    assert provider.batches == 2
    assert results[0].passage is not None
    assert warnings == []


def test_fetch_many_per_ref_errors(canon: Canon) -> None:
    refs = [_ref(canon, "Rom", 8, 28), _ref(canon, "Rom", 8, 29)]
    raw = FakeProvider().fetch(refs[0], "t1")
    provider = BatchProvider(None, [raw, PassageNotFound()])
    results, warnings = resolve_detections(refs, TRANSLATION, provider, canon)
    assert results[1].flags == ("passage_not_found",)
    assert warnings == []


def test_fetch_many_batch_failure_flags_every_ref(canon: Canon) -> None:
    refs = [_ref(canon, "Rom", 8, 28), _ref(canon, "Rom", 8, 29)]
    provider = BatchProvider(ProviderUnavailable())
    results, warnings = resolve_detections(refs, TRANSLATION, provider, canon)
    assert [r.flags for r in results] == [("text_unavailable",)] * 2
    assert warnings[0]["message"] == "2 passages could not be fetched."
