"""run_pipeline: transcript words to a validated Cue Document, offline.

This is the only place the stages are joined (detect, resolve, align, time, assemble). The HTTP
service and the CLI both call it. Spec: docs/07-sidecar-api.md sections 4 and 5, and
docs/05-timing-and-placement.md section 10 (determinism): nothing here reads a clock or a random
source, and ``generated_at`` and the job dict are supplied by the caller.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from versesync.bible.base import BibleProvider, Translation
from versesync.bible.resolver import resolve_detections
from versesync.cues import build_cue, build_document
from versesync.detect.canon import load_canon
from versesync.detect.detector import DetectConfig, detect
from versesync.timing.align import AlignConfig, Alignment, align
from versesync.timing.anchor import TimingConfig, compute_timing
from versesync.types import Word

PHASE_DETECTING = "detecting"
PHASE_RESOLVING = "resolving"
PHASE_TIMING = "timing"


@dataclass(frozen=True)
class PipelineConfig:
    detect: DetectConfig = DetectConfig()
    align: AlignConfig = AlignConfig()
    timing: TimingConfig = TimingConfig()
    max_verses: int = 6


# (phase, fraction 0..1 within that phase, message)
PhaseCallback = Callable[[str, float, str | None], None]


class Cancelled(Exception):
    """The caller's ``is_cancelled`` returned true; no document was produced."""


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
) -> dict[str, Any]:
    """Detect, resolve, align and time every scripture mention in ``words``.

    Returns a schema-valid Cue Document; raises ``Cancelled`` if ``is_cancelled()`` turns true
    between phases, between fetched passages or between cues.
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
    report(PHASE_DETECTING, 1.0, f"{len(detections)} references found")

    check_cancelled()
    report(PHASE_RESOLVING, 0.0)

    def resolve_progress(done: int, total: int) -> None:
        check_cancelled()
        report(PHASE_RESOLVING, done / total if total else 1.0)

    resolutions, warnings = resolve_detections(
        [d.reference for d in detections],
        translation,
        provider,
        canon,
        max_verses=cfg.max_verses,
        progress=resolve_progress,
    )
    report(PHASE_RESOLVING, 1.0)

    check_cancelled()
    report(PHASE_TIMING, 0.0)
    cues: list[dict[str, Any]] = []
    for index, (det, res) in enumerate(zip(detections, resolutions, strict=True), start=1):
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
        cues.append(build_cue(index, det, res, alignment, timing, translation, canon))
        report(PHASE_TIMING, index / len(detections))
    report(PHASE_TIMING, 1.0)

    return build_document(
        job=job,
        translation=translation,
        cues=cues,
        warnings=warnings,
        word_count=len(words),
        words_ref=f"transcript_{job['id']}.json",
        generated_at=generated_at,
    )
