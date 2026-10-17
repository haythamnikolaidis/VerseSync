"""The bootstrap corpus check: read-span alignment against T-41's hand labels (docs/05 section 4.2).

Each labelled read or paraphrase is detected, matched to its label by mention span, resolved
with the bundled KJV and aligned. The coverage distributions are written up in
docs/qa/alignment-calibration.md; ``test_calibration_doc_lists_every_measured_row`` keeps that
table equal to what this module measures.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from transcript_fixtures import FIXTURE_NAMES, FIXTURES_DIR, load_labels

from versesync.bible.local import LocalProvider
from versesync.detect.canon import load_canon
from versesync.detect.detector import Detection, detect
from versesync.detect.parse import parse_reference
from versesync.timing.align import AlignConfig, Alignment, align
from versesync.types import Reference, Word, load_words

CANON = load_canon()
PROVIDER = LocalProvider()
TRANSLATION = "kjv"
CALIBRATION_DOC = (
    Path(__file__).resolve().parent.parent / "docs" / "qa" / "alignment-calibration.md"
)

# The performance bound for aligning every detection in long-sermon-filler (T-17.3 step 2).
ALIGN_BUDGET_S = 1.0

# Labels whose classification differs from the hand label, keyed by (fixture, reference,
# mention start), each with a reason. The threshold is deliberately not moved to fix these
# (D24); they are evidence for a future tuning pass.
KNOWN_MISCLASSIFIED: dict[tuple[str, str, float], str] = {
    ("numbers-and-ordinals", "1 Corinthians 6:19-20", 10.0): (
        "the fixture reads a modern translation ('Holy Spirit', 'Or do you not know') while the "
        "bundled text is KJV ('What? know ye not ... the Holy Ghost'), so few words match"
    ),
    ("context-and-ambiguity", "Romans 12:12", 85.2): (
        "the paraphrase keeps 'rejoicing in hope' and 'patient in tribulation', four of the "
        "seven KJV content words, so it lands just above the 0.55 threshold"
    ),
}

# Labels with a read or paraphrase classification that detect() does not find, so there is no
# mention to align from. These are detection misses (see tests/test_grammar_corpus.py), not
# alignment results, and they stay out of the distributions.
KNOWN_UNDETECTED: dict[tuple[str, str, float], str] = {
    ("numbers-and-ordinals", "3 John 2", 225.4): (
        "'third john , verse two' is a single-chapter book with no chapter; the grammar has no "
        "pattern for it and detect() finds Philippians 4:2 instead"
    ),
}


@dataclass(frozen=True)
class Measured:
    fixture: str
    reference: str
    mention_s: float
    expected: str
    result: Alignment


def label_key(fixture: str, label: dict[str, Any]) -> tuple[str, str, float]:
    return (fixture, label["reference"], label["mention_span_s"][0])


def classified_labels() -> list[tuple[str, dict[str, Any]]]:
    return [
        (name, label)
        for name in FIXTURE_NAMES
        for label in load_labels(name)
        if label.get("expected_classification") in ("read", "paraphrase")
    ]


def mention_of(
    label: dict[str, Any], ref: Reference, detections: list[Detection]
) -> Detection | None:
    """The earliest detection that overlaps the label's mention span and names its chapter."""
    lo, hi = label["mention_span_s"]
    hits = [
        d
        for d in detections
        if d.candidate.source_start <= hi
        and d.candidate.source_end >= lo
        and d.reference.osis == ref.osis
        and d.reference.chapter == ref.chapter
    ]
    return min(hits, key=lambda d: d.candidate.word_span[0], default=None)


def verse_texts(ref: Reference) -> list[str]:
    passage = PROVIDER.fetch(ref, TRANSLATION)
    return [v.text for v in passage.verses]


def measure_corpus() -> tuple[list[Measured], list[tuple[str, str, float]]]:
    measured: list[Measured] = []
    undetected: list[tuple[str, str, float]] = []
    detections: dict[str, list[Detection]] = {}
    words: dict[str, list[Word]] = {}
    for name, label in classified_labels():
        if name not in words:
            words[name] = load_words(FIXTURES_DIR / f"{name}.words.json")
            detections[name] = detect(words[name], CANON)
        if label_key(name, label) in KNOWN_UNDETECTED:
            undetected.append(label_key(name, label))
            continue
        ref = parse_reference(label["reference"], CANON)
        mention = mention_of(label, ref, detections[name])
        if mention is None:
            undetected.append(label_key(name, label))
            continue
        result = align(verse_texts(ref), words[name], mention.candidate.word_span[0])
        measured.append(
            Measured(
                name,
                label["reference"],
                label["mention_span_s"][0],
                label["expected_classification"],
                result,
            )
        )
    return measured, undetected


MEASURED, UNDETECTED = measure_corpus()  # UNDETECTED is exactly KNOWN_UNDETECTED


def row_id(m: Measured) -> str:
    return f"{m.fixture}:{m.reference}@{m.mention_s}"


@pytest.mark.parametrize("m", MEASURED, ids=row_id)
def test_classification_matches_label(m: Measured) -> None:
    key = (m.fixture, m.reference, m.mention_s)
    if key in KNOWN_MISCLASSIFIED:
        assert m.result.classification != m.expected, (
            f"{key} now matches its label; remove it from KNOWN_MISCLASSIFIED"
        )
    else:
        assert m.result.classification == m.expected, (
            f"coverage {m.result.coverage:.3f} for {row_id(m)}"
        )


@pytest.mark.parametrize("m", MEASURED, ids=row_id)
def test_coverage_is_always_reported(m: Measured) -> None:
    assert 0.0 <= m.result.coverage <= 1.0
    assert (m.result.read_start_s is None) == (m.result.classification == "paraphrase")


def test_known_lists_reference_real_labels() -> None:
    labels = {label_key(name, label) for name, label in classified_labels()}
    assert set(KNOWN_MISCLASSIFIED) <= labels
    assert set(KNOWN_UNDETECTED) <= labels
    assert all(KNOWN_MISCLASSIFIED.values()) and all(KNOWN_UNDETECTED.values())


def test_known_undetected_labels_still_have_no_detection() -> None:
    for fixture, reference, mention_start in KNOWN_UNDETECTED:
        label = next(
            label
            for name, label in classified_labels()
            if label_key(name, label) == (fixture, reference, mention_start)
        )
        lo, hi = label["mention_span_s"]
        words = load_words(FIXTURES_DIR / f"{fixture}.words.json")
        osis = CANON.lookup(reference.rsplit(" ", 1)[0])
        assert osis is not None
        found = [
            d
            for d in detect(words, CANON)
            if d.candidate.source_start <= hi
            and d.candidate.source_end >= lo
            and d.reference.osis == osis.osis
        ]
        assert not found, f"{reference} is now detected; remove it from KNOWN_UNDETECTED"


def doc_row(m: Measured) -> str:
    return (
        f"| {m.fixture} | {m.reference} | {m.mention_s:.1f} | {m.expected} | "
        f"{m.result.coverage:.3f} | {m.result.classification} |"
    )


def test_calibration_doc_lists_every_measured_row() -> None:
    doc = CALIBRATION_DOC.read_text(encoding="utf-8")
    for m in MEASURED:
        assert doc_row(m) in doc, f"docs/qa/alignment-calibration.md is missing: {doc_row(m)}"


def test_long_sermon_alignment_is_fast() -> None:
    words = load_words(FIXTURES_DIR / "long-sermon-filler.words.json")
    detections = detect(words, CANON)
    assert detections
    jobs: list[tuple[list[str], int]] = []
    for d in detections:
        if d.reference.verse is None:
            passage = PROVIDER.fetch_chapter(d.reference.osis, d.reference.chapter, TRANSLATION)
            texts = [v.text for v in passage.verses]
        else:
            texts = verse_texts(d.reference)
        jobs.append((texts, d.candidate.word_span[0]))

    start = time.perf_counter()
    results = [align(texts, words, index, AlignConfig()) for texts, index in jobs]
    elapsed = time.perf_counter() - start

    assert len(results) == len(detections)
    assert elapsed < ALIGN_BUDGET_S
