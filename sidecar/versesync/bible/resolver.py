"""The resolving phase: detections in, passages or cue flags out (06 sections 3.2 and 5).

A provider failure never fails a job (FR-4.5). Every error becomes a flag on the one reference
it belongs to, except ``TranslationNotLicensed``, which is a job-level failure and propagates.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from versesync.bible.base import (
    BibleError,
    BibleProvider,
    Passage,
    PassageNotFound,
    ProviderUnavailable,
    RateLimited,
    RawPassage,
    Translation,
    TranslationNotLicensed,
)
from versesync.bible.format import format_passage
from versesync.detect.canon import Canon
from versesync.types import Reference

TEXT_UNAVAILABLE = "text_unavailable"
PASSAGE_NOT_FOUND = "passage_not_found"
LONG_PASSAGE = "long_passage"


@dataclass(frozen=True)
class Resolution:
    passage: Passage | None
    flags: tuple[str, ...]  # subset of {'text_unavailable', 'passage_not_found', 'long_passage'}


_Outcome = RawPassage | BibleError


def _fetch_each(
    provider: BibleProvider, refs: Sequence[Reference], translation_id: str
) -> list[_Outcome]:
    out: list[_Outcome] = []
    for ref in refs:
        try:
            out.append(provider.fetch(ref, translation_id))
        except TranslationNotLicensed:
            raise
        except BibleError as err:
            out.append(err)
    return out


def _fetch_batch(
    provider: BibleProvider, refs: Sequence[Reference], translation_id: str
) -> list[_Outcome]:
    """Fetch every ref, one outcome each. ``fetch_many`` is optional on a provider.

    ``fetch_many(refs, translation_id)`` returns one ``RawPassage`` or ``BibleError`` per ref.
    If it raises for the whole batch, every ref gets that error. A ``RateLimited`` batch is
    retried once, immediately: detection and resolving read no clock (AGENT.md section 6).
    """
    many: Callable[[Sequence[Reference], str], Sequence[_Outcome]] | None = getattr(
        provider, "fetch_many", None
    )
    if many is None:
        return _fetch_each(provider, refs, translation_id)
    for attempt in (1, 2):
        try:
            results = list(many(refs, translation_id))
        except TranslationNotLicensed:
            raise
        except RateLimited as err:
            if attempt == 1:
                continue
            return [err] * len(refs)
        except BibleError as err:
            return [err] * len(refs)
        break
    for result in results:
        if isinstance(result, TranslationNotLicensed):
            raise result
    return results


def resolve_detections(
    refs: Sequence[Reference],
    translation: Translation,
    provider: BibleProvider,
    canon: Canon,
    *,
    max_verses: int = 6,
    progress: Callable[[int, int], None] | None = None,
) -> tuple[list[Resolution], list[dict[str, Any]]]:
    """Resolve each reference to a passage or flags; returns (one per ref, warnings)."""
    total = len(refs)
    fetchable = [i for i, ref in enumerate(refs) if ref.verse is not None]
    outcomes = dict(
        zip(
            fetchable,
            _fetch_batch(provider, [refs[i] for i in fetchable], translation.id),
            strict=True,
        )
    )
    resolutions: list[Resolution] = []
    unavailable = 0
    for index, ref in enumerate(refs):
        outcome = outcomes.get(index)
        if outcome is None:  # chapter-only: nothing to fetch and no flag
            resolutions.append(Resolution(None, ()))
        elif isinstance(outcome, (ProviderUnavailable, RateLimited)):
            unavailable += 1
            resolutions.append(Resolution(None, (TEXT_UNAVAILABLE,)))
        elif isinstance(outcome, PassageNotFound):
            resolutions.append(Resolution(None, (PASSAGE_NOT_FOUND,)))
        elif isinstance(outcome, BibleError):
            # Any other provider failure is treated as the provider being unavailable.
            unavailable += 1
            resolutions.append(Resolution(None, (TEXT_UNAVAILABLE,)))
        else:
            passage = format_passage(outcome, translation, canon, max_verses=max_verses)
            flags = (LONG_PASSAGE,) if passage.truncated else ()
            resolutions.append(Resolution(passage, flags))
        if progress is not None:
            progress(index + 1, total)
    warnings: list[dict[str, Any]] = []
    if unavailable:
        warnings.append(
            {"code": "provider_partial", "message": f"{unavailable} passages could not be fetched."}
        )
    return resolutions, warnings
