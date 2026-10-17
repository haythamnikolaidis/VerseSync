"""The bootstrap corpus check: the grammar against T-41's hand labels (docs/11-testing.md)."""

from __future__ import annotations

from typing import Any

import pytest
from transcript_fixtures import FIXTURE_NAMES, load_labels, load_words

from versesync.detect.canon import Book, load_canon
from versesync.detect.grammar import Candidate, find_candidates
from versesync.detect.normalize import normalize
from versesync.types import Word

CANON = load_canon()

# Labels the grammar cannot find yet, keyed by (fixture, reference, mention start), each with a
# one-line reason.
KNOWN_MISSES: dict[tuple[str, str, float], str] = {
    ("numbers-and-ordinals", "3 John 2", 225.4): (
        "'third john , verse two' is a single-chapter book with no chapter, a form P1-P12 lack"
    ),
}


def candidates(name: str) -> list[Candidate]:
    words = [
        Word(text=w["text"], start=w["start"], end=w["end"], probability=w["probability"])
        for w in load_words(name)
    ]
    return find_candidates(normalize(words, CANON), CANON)


def book_and_chapter(reference: str) -> tuple[Book, int]:
    """ "1 Corinthians 6:19-20" -> (1 Corinthians, 6); "Psalm 122" -> (Psalms, 122)."""
    book_text, _, locator = reference.rpartition(" ")
    book = CANON.lookup(book_text)
    assert book is not None, reference
    return book, int(locator.split(":")[0])


def overlaps(c: Candidate, span: list[float]) -> bool:
    return c.source_start <= span[1] and c.source_end >= span[0]


def positive_labels() -> list[tuple[str, dict[str, Any]]]:
    return [
        (name, label)
        for name in FIXTURE_NAMES
        for label in load_labels(name)
        if label.get("reference") and label.get("mention_span_s")
    ]


def negative_labels() -> list[tuple[str, dict[str, Any]]]:
    return [
        (name, label)
        for name in FIXTURE_NAMES
        for label in load_labels(name)
        if label.get("negative")
    ]


def label_id(item: tuple[str, dict[str, Any]]) -> str:
    name, label = item
    span = label.get("mention_span_s") or label["span_s"]
    return f"{name}:{label['reference']}@{span[0]}"


@pytest.fixture(scope="module")
def found() -> dict[str, list[Candidate]]:
    return {name: candidates(name) for name in FIXTURE_NAMES}


@pytest.mark.parametrize("item", positive_labels(), ids=label_id)
def test_every_labelled_mention_has_a_candidate_with_its_book_and_chapter(
    item: tuple[str, dict[str, Any]], found: dict[str, list[Candidate]]
) -> None:
    name, label = item
    key = (name, label["reference"], label["mention_span_s"][0])
    book, chapter = book_and_chapter(label["reference"])
    hit = any(
        c.book.osis == book.osis and c.chapter == chapter and overlaps(c, label["mention_span_s"])
        for c in found[name]
    )
    if key in KNOWN_MISSES:
        assert not hit, f"{key} is now found; remove it from KNOWN_MISSES"
    else:
        assert hit, f"no candidate for {key}"


@pytest.mark.parametrize("item", negative_labels(), ids=label_id)
def test_negative_labels_have_no_candidates_inside_their_span(
    item: tuple[str, dict[str, Any]], found: dict[str, list[Candidate]]
) -> None:
    name, label = item
    inside = [c for c in found[name] if overlaps(c, label["span_s"])]
    assert inside == [], label["note"]


def test_psalms_ambiguity_labels_carry_their_alternative_reading(
    found: dict[str, list[Candidate]],
) -> None:
    pairs = [
        (name, label)
        for name in FIXTURE_NAMES
        for label in load_labels(name)
        if label.get("alternative_reference")
    ]
    assert pairs
    for name, label in pairs:
        book, chapter = book_and_chapter(label["reference"])
        alt_book, alt_chapter = book_and_chapter(label["alternative_reference"])
        primary = next(
            c
            for c in found[name]
            if c.book.osis == book.osis
            and c.chapter == chapter
            and overlaps(c, label["mention_span_s"])
        )
        assert [(a.book.osis, a.chapter) for a in primary.alternatives] == [
            (alt_book.osis, alt_chapter)
        ]


def test_known_misses_name_real_labels() -> None:
    labelled = {
        (name, label["reference"], label["mention_span_s"][0]) for name, label in positive_labels()
    }
    assert set(KNOWN_MISSES) <= labelled
    assert all(reason.strip() and "\n" not in reason for reason in KNOWN_MISSES.values())


def test_the_corpus_has_labels_to_check() -> None:
    assert len(positive_labels()) >= 10
    assert len(negative_labels()) >= 3
