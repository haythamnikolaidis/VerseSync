"""run_pipeline: transcript words to a validated Cue Document, offline.

This is the only place the stages are joined (detect, resolve, align, time, assemble). The HTTP
service and the CLI both call it. Spec: docs/07-sidecar-api.md sections 4 and 5, and
docs/05-timing-and-placement.md section 10 (determinism): nothing here reads a clock or a random
source, and ``generated_at`` and the job dict are supplied by the caller.

With a scripture file (docs/14-scripture-file-import.md) its entries become the cues, located by
their own text, and the detections no entry used are kept as disabled ``not_in_export`` cues.
Without one, the stages run exactly as they did before the file existed.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from versesync.bible.base import BibleProvider, Translation, TranslationNotLicensed
from versesync.bible.resolver import TEXT_UNAVAILABLE, Resolution, resolve_detections
from versesync.cues import (
    build_cue,
    build_document,
    build_export_cue,
    build_unplaced_export_cue,
    number_cues,
    provider_text_source,
    unplaced_export_duration,
)
from versesync.detect.canon import load_canon
from versesync.detect.detector import DetectConfig, Detection, detect
from versesync.scripture_file import ExportEntry, ExportWarning
from versesync.timing.align import AlignConfig, Alignment, align, transcript_tokens
from versesync.timing.anchor import TimingConfig, compute_timing
from versesync.timing.locate import LocateConfig, LocatedCue, LocateResult, build_candidates, locate
from versesync.types import Reference, Word

PHASE_DETECTING = "detecting"
PHASE_RESOLVING = "resolving"
PHASE_TIMING = "timing"

NOT_IN_EXPORT = "not_in_export"
# The located cues whose entry has a placement of its own; the others repeat an entry that has one.
_PRIMARY_KINDS = frozenset({"assigned", "out_of_order"})

# Sorts the cues of an export document: mention start, then entry cues before the detections no
# entry used, then the entry's index or the detection's number, then the place in the located cues.
_SortKey = tuple[float, int, int, int]


@dataclass(frozen=True)
class PipelineConfig:
    detect: DetectConfig = DetectConfig()
    align: AlignConfig = AlignConfig()
    timing: TimingConfig = TimingConfig()
    locate: LocateConfig = LocateConfig()
    max_verses: int = 6


# (phase, fraction 0..1 within that phase, message)
PhaseCallback = Callable[[str, float, str | None], None]


class Cancelled(Exception):
    """The caller's ``is_cancelled`` returned true; no document was produced."""


def _locate_entries(
    entries: Sequence[ExportEntry],
    words: Sequence[Word],
    detections: Sequence[Detection],
    cfg: PipelineConfig,
) -> LocateResult:
    """Find every entry of the scripture file in the transcript (docs/14 section 4)."""
    tokens = transcript_tokens(words)
    locate_cfg = replace(cfg.locate, align=cfg.align)
    candidates = build_candidates(entries, tokens, detections, locate_cfg)
    return locate(entries, candidates, tokens, detections, locate_cfg)


def _text_unavailable(
    refs: Sequence[Reference],
) -> tuple[list[Resolution], list[dict[str, Any]]]:
    """Resolutions for refs the provider can't serve at all, shaped like ``resolve_detections``."""
    unavailable = (TEXT_UNAVAILABLE,)
    resolutions = [Resolution(None, unavailable if ref.verse is not None else ()) for ref in refs]
    count = sum(1 for resolution in resolutions if resolution.flags)
    warnings = (
        [{"code": "provider_partial", "message": f"{count} passages could not be fetched."}]
        if count
        else []
    )
    return resolutions, warnings


def _unplaced_anchors(
    entries: Sequence[ExportEntry],
    cues: Sequence[LocatedCue],
    built: Mapping[int, dict[str, Any]],
    timing: TimingConfig,
) -> dict[int, float]:
    """The anchor of each entry that was not found in the audio (docs/14 section 5).

    It is the midpoint of the anchors of the nearest placed entries before and after it in file
    order; before the first, the next one's anchor minus its duration; after the last, the
    previous one's anchor plus its duration; never below 0. A run of unplaced entries between
    the same two neighbours shares one anchor. When no entry is placed, the anchors start at 0
    and are spaced by each entry's own duration, in file order.

    ``built[position]`` is the cue made for ``cues[position]``.
    """
    placed: dict[int, tuple[float, float]] = {}
    for position, located in enumerate(cues):
        if located.kind in _PRIMARY_KINDS:
            cue = built[position]
            placed[located.entry_index] = (cue["source_anchor_s"], cue["source_duration_s"])

    after: list[tuple[float, float] | None] = [None] * len(entries)
    following: tuple[float, float] | None = None
    for place in range(len(entries) - 1, -1, -1):
        after[place] = following
        following = placed.get(entries[place].index, following)

    anchors: dict[int, float] = {}
    before: tuple[float, float] | None = None
    elapsed = 0.0
    for place, entry in enumerate(entries):
        if entry.index in placed:
            before = placed[entry.index]
            continue
        ahead = after[place]
        if before is not None and ahead is not None:
            anchor = (before[0] + ahead[0]) / 2
        elif ahead is not None:
            anchor = ahead[0] - ahead[1]
        elif before is not None:
            anchor = before[0] + before[1]
        else:
            anchor = elapsed
            elapsed += unplaced_export_duration(entry, timing)
        anchors[entry.index] = round(max(anchor, 0.0), 3)
    return anchors


def _export_cues(
    entries: Sequence[ExportEntry],
    located: LocateResult,
    words: Sequence[Word],
    cfg: PipelineConfig,
    check_cancelled: Callable[[], None],
    advance: Callable[[], None],
) -> list[tuple[_SortKey, dict[str, Any]]]:
    """One cue for each located cue, without ids, each with its sort key.

    ``check_cancelled`` is called before each cue is built and ``advance`` after.
    """
    by_index = {entry.index: entry for entry in entries}
    built: dict[int, dict[str, Any]] = {}
    for position, cue in enumerate(located.cues):
        if cue.placement is not None:
            check_cancelled()
            built[position] = build_export_cue(
                by_index[cue.entry_index],
                cue,
                words,
                cfg.timing,
                read_coverage_threshold=cfg.align.read_coverage_threshold,
                max_verses=cfg.max_verses,
            )
            advance()
    anchors = _unplaced_anchors(entries, located.cues, built, cfg.timing)
    for position, cue in enumerate(located.cues):
        if cue.placement is None:
            check_cancelled()
            built[position] = build_unplaced_export_cue(
                by_index[cue.entry_index],
                anchors[cue.entry_index],
                cfg.timing,
                max_verses=cfg.max_verses,
            )
            advance()
    return [
        ((cue["mention_start_s"], 0, located.cues[position].entry_index, position), cue)
        for position, cue in built.items()
    ]


def run_pipeline(
    words: Sequence[Word],
    *,
    translation: Translation,
    provider: BibleProvider,
    job: dict[str, Any],
    generated_at: str,
    cfg: PipelineConfig = PipelineConfig(),
    on_phase: PhaseCallback | None = None,
    is_cancelled: Callable[[], bool] = lambda: False,
    scripture_file: list[ExportEntry] | None = None,
    scripture_warnings: Sequence[ExportWarning] = (),
    scripture_file_block: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Detect, resolve, align and time every scripture mention in ``words``.

    Returns a schema-valid Cue Document; raises ``Cancelled`` if ``is_cancelled()`` turns true
    between phases, between fetched passages or between cues.

    With ``scripture_file``, the parsed entries of an export (docs/14), the document is 1.1:
    each entry becomes a cue with its own reference, translation and text, located in the
    transcript, and the detections no entry used become disabled ``not_in_export`` cues whose
    text the provider supplies. The provider is called only for those; an entry's text is never
    fetched and never reaches the Bible cache. ``scripture_warnings`` are the parser's, and
    ``scripture_file_block`` is the document's ``{path, sha256, entry_count}``. Without entries
    the document is 1.0 and the output is what the pipeline gave before the file existed.
    """

    def report(phase: str, fraction: float, message: str | None = None) -> None:
        if on_phase is not None:
            on_phase(phase, fraction, message)

    def check_cancelled() -> None:
        if is_cancelled():
            raise Cancelled()

    canon = load_canon()

    check_cancelled()
    report(PHASE_DETECTING, 0.0)
    detections = detect(words, canon, cfg.detect)
    located = _locate_entries(scripture_file, words, detections, cfg) if scripture_file else None
    report(PHASE_DETECTING, 1.0, f"{len(detections)} references found")

    # The detections that become cues of their own: all of them, or those no entry used.
    if located is None:
        pending = detections
    else:
        consumed = set(located.consumed_detection_ids)
        pending = [d for d in detections if d.id not in consumed]

    check_cancelled()
    report(PHASE_RESOLVING, 0.0)

    def resolve_progress(done: int, total: int) -> None:
        check_cancelled()
        report(PHASE_RESOLVING, done / total if total else 1.0)

    resolutions: list[Resolution] = []
    warnings: list[dict[str, Any]] = []
    if located is None or pending:
        refs = [d.reference for d in pending]
        try:
            resolutions, warnings = resolve_detections(
                refs,
                translation,
                provider,
                canon,
                max_verses=cfg.max_verses,
                progress=resolve_progress,
            )
        except TranslationNotLicensed:
            if located is None:
                raise
            # The entries carry the text; what the provider can't serve costs the leftovers
            # their text, not the job (docs/12 D27).
            resolutions, warnings = _text_unavailable(refs)
    report(PHASE_RESOLVING, 1.0)

    check_cancelled()
    report(PHASE_TIMING, 0.0)
    total = len(pending) + (len(located.cues) if located is not None else 0)
    done = 0

    def advance() -> None:
        nonlocal done
        done += 1
        report(PHASE_TIMING, done / total)

    keyed: list[tuple[_SortKey, dict[str, Any]]] = []
    if located is not None:
        keyed = _export_cues(scripture_file or [], located, words, cfg, check_cancelled, advance)

    extra: dict[str, Any] = {}
    if located is not None:
        extra = {"extra_flags": (NOT_IN_EXPORT,), "text_source": provider_text_source(translation)}
    cues: list[dict[str, Any]] = []
    for index, (det, res) in enumerate(zip(pending, resolutions, strict=True), start=1):
        check_cancelled()
        passage = res.passage
        alignment: Alignment | None = None
        if passage is not None:
            alignment = align(
                [v.text for v in passage.verses], words, det.candidate.word_span[0], cfg.align
            )
        timing = compute_timing(
            det.candidate.source_start,
            alignment,
            passage.word_count if passage is not None else None,
            det.confidence,
            cfg.timing,
        )
        cues.append(build_cue(index, det, res, alignment, timing, translation, canon, **extra))
        advance()
    report(PHASE_TIMING, 1.0)

    if located is not None:
        keyed += [((cue["mention_start_s"], 1, n, 0), cue) for n, cue in enumerate(cues)]
        cues = number_cues([cue for _, cue in sorted(keyed, key=lambda item: item[0])])
    return build_document(
        job=job,
        translation=translation,
        cues=cues,
        warnings=[w.to_json() for w in scripture_warnings] + warnings,
        word_count=len(words),
        words_ref=f"transcript_{job['id']}.json",
        generated_at=generated_at,
        from_scripture_file=located is not None,
        scripture_file=scripture_file_block if located is not None else None,
    )
