"""Cue builder: one detection, resolution, alignment and timing become one schema cue.

Spec: docs/07-sidecar-api.md section 5. Key order follows the golden fixtures.
"""

from __future__ import annotations

import json
import math
from collections.abc import Collection, Mapping, Sequence
from dataclasses import replace
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from versesync.bible.base import Translation
from versesync.bible.resolver import LONG_PASSAGE, Resolution
from versesync.detect.canon import Canon
from versesync.detect.detector import Detection, make_snippet
from versesync.scripture_file import ExportEntry
from versesync.timing.align import Alignment
from versesync.timing.anchor import Timing, TimingConfig, compute_timing
from versesync.timing.locate import LocatedCue
from versesync.types import Word

# A document built without a scripture file stays 1.0, so it is byte-identical to a v1 one
# (docs/14-scripture-file-import.md section 6, T-51.4). One built from a scripture file is 1.1.
SCHEMA_VERSION = "1.0"
SCHEMA_VERSION_SCRIPTURE_FILE = "1.1"
LOW_CONFIDENCE_THRESHOLD = 0.55
# Sidecar-owned subset of the docs/09-ui-spec.md section 5.2 flags that start a cue disabled.
# repeat_read and out_of_order are deliberately absent: those cues start enabled.
DISABLED_BY_DEFAULT = frozenset(
    {
        "text_unavailable",
        "passage_not_found",
        "chapter_only",
        "suppressed_duplicate",
        "not_in_export",
        "not_found_in_audio",
        "repeat_mention",
    }
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
    "not_in_export",
    "not_found_in_audio",
    "repeat_mention",
    "repeat_read",
    "out_of_order",
)


def _ordered(present: Collection[str]) -> list[str]:
    return [flag for flag in _FLAG_ORDER if flag in present]


def _enabled(flags: Collection[str]) -> bool:
    return not any(flag in DISABLED_BY_DEFAULT for flag in flags)


def _flags(
    det: Detection, res: Resolution, timing: Timing, extra_flags: Collection[str] = ()
) -> list[str]:
    present = set(det.flags) | set(res.flags) | set(extra_flags)
    if timing.confidence < LOW_CONFIDENCE_THRESHOLD:
        present.add("low_confidence")
    return _ordered(present)


def _detection_block(det: Detection) -> dict[str, Any]:
    cand = det.candidate
    return {
        "pattern": cand.pattern,
        "contextual": cand.contextual,
        "book_match": {"tier": cand.book_match.tier, "distance": cand.book_match.distance},
        "token_span": list(cand.token_span),
        "word_span": list(cand.word_span),
    }


def build_cue(
    index: int,
    det: Detection,
    res: Resolution,
    alignment: Alignment | None,
    timing: Timing,
    translation: Translation,
    canon: Canon,
    *,
    extra_flags: Collection[str] = (),
    text_source: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the cue dict for detection number ``index``.

    ``extra_flags`` and ``text_source`` are for a cue built next to a scripture file's entries
    (``not_in_export`` and the provider text source); a cue built without one passes neither.
    """
    cand = det.candidate
    passage = res.passage
    flags = _flags(det, res, timing, extra_flags)

    cue: dict[str, Any] = {
        "id": f"cue_{index:03d}",
        "enabled": _enabled(flags),
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
    cue["detection"] = _detection_block(det)
    cue["snippet"] = det.snippet
    if text_source is not None:
        cue["text_source"] = dict(text_source)
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


# docs/14-scripture-file-import.md section 5: a cue placed by its mention alone is trusted at 0.8
# of the detection's confidence.
MENTION_ONLY_WEIGHT = 0.8
# The cue kinds that add their own flag.
_KIND_FLAGS = frozenset({"out_of_order", "repeat_read", "repeat_mention"})


def provider_text_source(translation: Translation) -> dict[str, Any]:
    """The ``text_source`` of a cue whose body came from the Bible text service."""
    return {"kind": "provider", "translation": translation.abbreviation}


def _export_text_source(entry: ExportEntry) -> dict[str, Any]:
    return {"kind": "export", "translation": entry.translation, "entry_index": entry.index}


def _is_multi_verse(entry: ExportEntry) -> bool:
    ref = entry.reference
    return ref.verse is not None and ref.verse_end is not None and ref.verse_end > ref.verse


def _verse_count(entry: ExportEntry) -> int:
    ref = entry.reference
    if ref.verse is None or ref.verse_end is None:
        return 1
    return max(1, ref.verse_end - ref.verse + 1)


def _verse_offsets(entry: ExportEntry, located: LocatedCue, anchor_s: float) -> dict[str, float]:
    """Each later verse's start, in seconds after ``anchor_s``, keyed by verse number.

    The entry's first verse has no key, and neither has a verse the reading didn't match
    (docs/14 section 5). The schema allows no negative offset, so one is held at 0: a verse
    never starts before the cue it belongs to.
    """
    return {
        str(number): max(0.0, round(start - anchor_s, 3))
        for number, start in located.verse_starts
        if number != entry.reference.verse
    }


def unplaced_export_duration(entry: ExportEntry, cfg: TimingConfig) -> float:
    """The PARAPHRASE duration of an entry that was not found in the audio (05 section 3.3)."""
    return compute_timing(0.0, None, entry.word_count, 0.0, cfg).source_duration_s


def _export_cue(
    entry: ExportEntry,
    *,
    anchor_s: float,
    duration_s: float,
    mention_start_s: float,
    mention_end_s: float,
    classification: str,
    coverage: float | None,
    read_span: tuple[float, float] | None,
    confidence: float,
    detection: Detection | None,
    snippet: str,
    verse_offsets: dict[str, float],
    flags: Collection[str],
    max_verses: int,
) -> dict[str, Any]:
    """The cue for one entry, without its id; ``number_cues`` gives it one.

    The reference line, the body and the translation are the export's own, never the provider's
    (docs/14 section 5), and the body is never truncated: a passage over ``max_verses`` is flagged
    ``long_passage`` and kept whole, because it is what was on screen.
    """
    present = set(flags)
    if _verse_count(entry) > max_verses:
        present.add(LONG_PASSAGE)
    ordered = _ordered(present)

    cue: dict[str, Any] = {
        "enabled": _enabled(ordered),
        "origin": "detected",
        "reference": entry.reference.to_json(),
        "reference_display": entry.reference_line,
        "body": entry.body,
        "body_word_count": entry.word_count,
        "body_truncated": False,
        "source_anchor_s": anchor_s,
        "source_duration_s": duration_s,
        "mention_start_s": mention_start_s,
        "mention_end_s": mention_end_s,
        "classification": classification,
    }
    if coverage is not None:
        cue["read_coverage"] = coverage
    if read_span is not None:
        cue["read_start_s"], cue["read_end_s"] = read_span
    cue["confidence"] = confidence
    if detection is not None:
        cue["detection"] = _detection_block(detection)
    cue["snippet"] = snippet
    cue["text_source"] = _export_text_source(entry)
    if verse_offsets:
        cue["verse_offsets_s"] = verse_offsets
    cue["flags"] = ordered
    cue["alternatives"] = []
    return cue


def build_export_cue(
    entry: ExportEntry,
    located: LocatedCue,
    words: Sequence[Word],
    cfg: TimingConfig,
    *,
    read_coverage_threshold: float,
    max_verses: int,
) -> dict[str, Any]:
    """The cue for a located entry that has a placement, by the table of docs/14 section 5.

    A text placement with coverage of at least ``read_coverage_threshold`` is a READ cue, with the
    anchor and duration of 05 section 3. A weaker one with no mention is a ``low_confidence``
    PARAPHRASE cue, anchored on its first matched word. A mention alone, or a weak reading with a
    mention, is a PARAPHRASE cue anchored on the mention. The READ cue of a multi-verse entry runs
    to the end of the reading, not to ``max_read_duration_s``; the panel's overlap sweep (05
    section 8) still shortens it where another cue begins.
    """
    placement = located.placement
    if placement is None:
        raise ValueError("an unplaced entry has no placement; use build_unplaced_export_cue")
    text, mention = placement.text, placement.mention
    detection = mention.detection if mention is not None else None
    flags: set[str] = {located.kind} if located.kind in _KIND_FLAGS else set()

    alignment: Alignment | None = None
    coverage: float | None = None
    read_span: tuple[float, float] | None = None
    if text is not None:
        coverage = text.coverage
        if text.coverage >= read_coverage_threshold:
            alignment = Alignment(
                "read", text.coverage, text.read_start_s, text.read_end_s, text.word_span
            )
            read_span = (text.read_start_s, text.read_end_s)

    if detection is not None:
        mention_start_s = detection.candidate.source_start
        mention_end_s = detection.candidate.source_end
        snippet = detection.snippet
    elif text is not None:
        # Found by its text alone: the first matched word stands in for the spoken reference.
        mention_start_s = mention_end_s = text.read_start_s
        snippet = make_snippet(words, text.word_span)
    else:
        raise ValueError("a placement has a text candidate, a mention, or both")

    if alignment is not None:
        # The evidence for the reading. A mention adds to it only on the in-order placement, and
        # compute_timing's corroboration bonus is not used (docs/14 section 5).
        confidence = coverage if coverage is not None else 0.0
        if located.kind == "assigned" and detection is not None:
            confidence = max(confidence, detection.confidence)
        classification = "read"
    elif detection is not None:
        confidence = MENTION_ONLY_WEIGHT * detection.confidence
        classification = "paraphrase"
    else:
        confidence = coverage if coverage is not None else 0.0
        classification = "paraphrase"
        flags.add("low_confidence")

    timing_cfg = cfg
    if alignment is not None and _is_multi_verse(entry):
        timing_cfg = replace(cfg, max_read_duration_s=math.inf)
    timing = compute_timing(mention_start_s, alignment, entry.word_count, confidence, timing_cfg)

    offsets = _verse_offsets(entry, located, timing.source_anchor_s) if alignment else {}
    return _export_cue(
        entry,
        anchor_s=timing.source_anchor_s,
        duration_s=timing.source_duration_s,
        mention_start_s=mention_start_s,
        mention_end_s=mention_end_s,
        classification=classification,
        coverage=coverage,
        read_span=read_span,
        confidence=confidence,
        detection=detection,
        snippet=snippet,
        verse_offsets=offsets,
        flags=flags,
        max_verses=max_verses,
    )


def build_unplaced_export_cue(
    entry: ExportEntry, anchor_s: float, cfg: TimingConfig, *, max_verses: int
) -> dict[str, Any]:
    """The cue for an entry that was not found in the audio, at the interpolated ``anchor_s``.

    It starts disabled with the ``not_found_in_audio`` flag and a confidence of 0.0, so the editor
    sets its time (docs/14 section 5).
    """
    return _export_cue(
        entry,
        anchor_s=anchor_s,
        duration_s=unplaced_export_duration(entry, cfg),
        mention_start_s=anchor_s,
        mention_end_s=anchor_s,
        classification="paraphrase",
        coverage=None,
        read_span=None,
        confidence=0.0,
        detection=None,
        snippet="",
        verse_offsets={},
        flags={"not_found_in_audio"},
        max_verses=max_verses,
    )


def number_cues(cues: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The cues in the order given, with the ids ``cue_001``, ``cue_002``, ... first in each."""
    return [
        {"id": f"cue_{number:03d}", **{k: v for k, v in cue.items() if k != "id"}}
        for number, cue in enumerate(cues, start=1)
    ]


class InvalidCueDocument(Exception):
    """A Cue Document that does not conform to schemas/cue-document.schema.json."""


_PACKAGED_SCHEMA = Path(__file__).resolve().parent / "data" / "cue-document.schema.json"
_REPO_SCHEMA = Path(__file__).resolve().parents[2] / "schemas" / "cue-document.schema.json"


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    # The repo copy is the source of truth in development; the packaged copy serves an install.
    path = _REPO_SCHEMA if _REPO_SCHEMA.is_file() else _PACKAGED_SCHEMA
    with path.open("r", encoding="utf-8") as f:
        return Draft202012Validator(json.load(f))


def validate_document(doc: dict[str, Any]) -> None:
    """Raise ``InvalidCueDocument`` listing every schema violation; return None when valid."""
    errors = sorted(_validator().iter_errors(doc), key=lambda e: [str(p) for p in e.path])
    if errors:
        lines = [f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors]
        raise InvalidCueDocument("; ".join(lines))


def build_document(
    *,
    job: dict[str, Any],
    translation: Translation,
    cues: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
    word_count: int,
    words_ref: str,
    generated_at: str,
    from_scripture_file: bool = False,
    scripture_file: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble and validate the Cue Document; a malformed one never leaves this function.

    A document built from a scripture file is 1.1; one built without is 1.0 and holds no 1.1
    field (docs/14 section 6). ``scripture_file`` is the optional ``{path, sha256, entry_count}``
    block, and giving it makes the document 1.1 as well.
    """
    from_export = from_scripture_file or scripture_file is not None
    doc: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION_SCRIPTURE_FILE if from_export else SCHEMA_VERSION,
        "generated_at": generated_at,
        "job": job,
        "translation": {
            "id": translation.id,
            "abbreviation": translation.abbreviation,
            "name": translation.name,
            "attribution": translation.attribution,
        },
        "transcript": {"word_count": word_count, "words_ref": words_ref},
    }
    if scripture_file is not None:
        doc["scripture_file"] = dict(scripture_file)
    doc["cues"] = cues
    doc["warnings"] = warnings
    validate_document(doc)
    return doc


def _dump(obj: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, sort_keys=False, indent=1, ensure_ascii=False)
        f.write("\n")


def write_document(doc: dict[str, Any], words: Sequence[Word], out_path: Path) -> None:
    """Write the document and, beside it, the transcript named by ``transcript.words_ref``."""
    validate_document(doc)
    out_path = Path(out_path)
    _dump(doc, out_path)
    _dump(
        [
            {"text": w.text, "start": w.start, "end": w.end, "probability": w.probability}
            for w in words
        ],
        out_path.parent / doc["transcript"]["words_ref"],
    )


def read_document(path: Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as f:
        doc: dict[str, Any] = json.load(f)
    return doc
