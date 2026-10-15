"""Cue builder: one detection, resolution, alignment and timing become one schema cue.

Spec: docs/07-sidecar-api.md section 5. Key order follows the golden fixtures.
"""

from __future__ import annotations

from typing import Any

from versesync.bible.base import Translation
from versesync.bible.resolver import Resolution
from versesync.detect.canon import Canon
from versesync.detect.detector import Detection
from versesync.timing.align import Alignment
from versesync.timing.anchor import Timing

LOW_CONFIDENCE_THRESHOLD = 0.55
# Sidecar-owned subset of the docs/09-ui-spec.md section 5.2 flags that start a cue disabled.
DISABLED_BY_DEFAULT = frozenset(
    {"text_unavailable", "passage_not_found", "chapter_only", "suppressed_duplicate"}
)

# Order of the schema's flag enum. The panel-owned flags (cut_from_edit, multiple_placements,
# speed_change_unsupported) are deliberately absent: the sidecar never emits them.
_FLAG_ORDER = (
    "low_confidence",
    "overlap",
    "truncated",
    "long_passage",
    "text_unavailable",
    "passage_not_found",
    "chapter_only",
    "suppressed_duplicate",
)


def _flags(det: Detection, res: Resolution, timing: Timing) -> list[str]:
    present = set(det.flags) | set(res.flags)
    if timing.confidence < LOW_CONFIDENCE_THRESHOLD:
        present.add("low_confidence")
    return [flag for flag in _FLAG_ORDER if flag in present]


def build_cue(
    index: int,
    det: Detection,
    res: Resolution,
    alignment: Alignment | None,
    timing: Timing,
    translation: Translation,
    canon: Canon,
) -> dict[str, Any]:
    """Assemble the cue dict for detection number ``index``."""
    cand = det.candidate
    passage = res.passage
    flags = _flags(det, res, timing)

    cue: dict[str, Any] = {
        "id": f"cue_{index:03d}",
        "enabled": not any(flag in DISABLED_BY_DEFAULT for flag in flags),
        "origin": "detected",
        "reference": det.reference.to_json(),
        "reference_display": f"{det.reference.display(canon)} ({translation.abbreviation})",
        "body": passage.body if passage is not None else "",
        "body_word_count": passage.word_count if passage is not None else 0,
        "body_truncated": passage.truncated if passage is not None else False,
        "source_anchor_s": timing.source_anchor_s,
        "source_duration_s": timing.source_duration_s,
        "mention_start_s": cand.source_start,
        "mention_end_s": cand.source_end,
        "classification": alignment.classification if alignment is not None else "paraphrase",
    }
    if alignment is not None:
        cue["read_coverage"] = alignment.coverage
        if alignment.read_start_s is not None:
            cue["read_start_s"] = alignment.read_start_s
        if alignment.read_end_s is not None:
            cue["read_end_s"] = alignment.read_end_s
    cue["confidence"] = timing.confidence
    cue["detection"] = {
        "pattern": cand.pattern,
        "contextual": cand.contextual,
        "book_match": {"tier": cand.book_match.tier, "distance": cand.book_match.distance},
        "token_span": list(cand.token_span),
        "word_span": list(cand.word_span),
    }
    cue["snippet"] = det.snippet
    cue["flags"] = flags
    cue["alternatives"] = [
        {
            "reference": ref.to_json(),
            "reference_display": f"{ref.display(canon)} ({translation.abbreviation})",
            "body": "",
            "confidence": confidence,
            "reason": reason,
        }
        for ref, confidence, reason in det.alternatives
    ]
    return cue
