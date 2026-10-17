from __future__ import annotations

import pytest
from transcript_fixtures import FIXTURE_NAMES, load_labels, load_words


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_words_load_and_are_well_formed(name: str) -> None:
    words = load_words(name)
    assert len(words) > 0

    prev_end = -1.0
    for word in words:
        assert isinstance(word["text"], str) and word["text"]
        assert word["start"] >= prev_end
        assert word["end"] > word["start"]
        assert 0.0 <= word["probability"] <= 1.0
        prev_end = word["end"]


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_speaking_pace_is_plausible(name: str) -> None:
    # Per-word duration, not the whole-fixture average — a fixture legitimately contains
    # multi-second gaps between separate thoughts, which would otherwise drag a whole-corpus
    # average well below any natural speaking pace without saying anything about plausibility.
    words = load_words(name)
    for word in words:
        word_duration = word["end"] - word["start"]
        assert 0.1 <= word_duration <= 1.5, (
            f"{name}: word {word['text']!r} took {word_duration:.2f}s, outside a natural "
            "~2-3 words/second pace"
        )


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_labels_load_and_spans_fall_within_the_words(name: str) -> None:
    words = load_words(name)
    labels = load_labels(name)
    assert len(labels) > 0
    fixture_end = words[-1]["end"]

    # Labels round to 1 decimal place (documented in tests/fixtures/README.md); words keep 2.
    # That alone can put a label's rounded upper bound a few hundredths past the last word's
    # actual end, so compare with the same tolerance rather than an exact <=.
    slack = 0.1

    for label in labels:
        span = label.get("mention_span_s") or label.get("span_s")
        assert span is not None
        assert 0.0 <= span[0] < span[1] <= fixture_end + slack
        if label.get("expected_classification") == "read":
            read_span = label["read_span_s"]
            assert 0.0 <= read_span[0] < read_span[1] <= fixture_end + slack
        if not label.get("negative"):
            assert label.get("reference")


def _joined_text(name: str) -> str:
    return " ".join(w["text"] for w in load_words(name))


def test_every_t41_step_2_bullet_is_covered_somewhere() -> None:
    corpus = " ".join(_joined_text(name) for name in FIXTURE_NAMES)

    # spoken numbers
    assert "one hundred and nineteen" in corpus
    assert "one hundred and seventy six" in corpus
    assert "twenty eight" in corpus

    # ordinal books
    assert "First Corinthians" in corpus
    assert "Second Timothy" in corpus
    assert "Third John" in corpus

    # a verse range, a single verse, a chapter-only reference
    all_labels = [label for name in FIXTURE_NAMES for label in load_labels(name)]
    references = [label["reference"] for label in all_labels if label.get("reference")]
    assert any("-" in ref for ref in references), "no verse-range reference labelled"
    assert any(":" in ref and "-" not in ref for ref in references), (
        "no single-verse reference labelled"
    )
    assert any(":" not in ref for ref in references), "no chapter-only reference labelled"

    # context-carried verse
    assert any("context-carried" in (label.get("note") or "") for label in all_labels)

    # Psalms concatenation ambiguity
    assert any(label.get("alternative_reference") for label in all_labels)

    # negative cases
    assert "lost his job" in corpus
    assert "Mark my words" in corpus
    assert "acts on what it believes" in corpus
    negatives = [label for label in all_labels if label.get("negative")]
    assert len(negatives) >= 3

    # one long verbatim reading and one paraphrase of the same passage
    read_refs = {
        label["reference"] for label in all_labels if label.get("expected_classification") == "read"
    }
    paraphrase_refs = {
        label["reference"]
        for label in all_labels
        if label.get("expected_classification") == "paraphrase"
    }
    assert read_refs & paraphrase_refs, "no reference is both READ and PARAPHRASE somewhere"


def test_duplicate_suppression_window_is_exercised() -> None:
    labels = load_labels("long-sermon-filler")
    john_316 = [label for label in labels if label.get("reference") == "John 3:16"]
    assert len(john_316) >= 2

    first = john_316[0]["mention_span_s"][0]
    inside_cooldown = [
        label for label in labels if "Expected: suppressed" in (label.get("note") or "")
    ]
    assert len(inside_cooldown) == 1
    gap_to_suppressed = inside_cooldown[0]["mention_span_s"][0] - first
    assert 0 < gap_to_suppressed < 60, "the suppressed duplicate must be inside the 60s cooldown"

    second_read = [label for label in john_316 if label.get("expected_classification") == "read"][1]
    gap_to_second = second_read["mention_span_s"][0] - first
    assert gap_to_second > 60, "the un-suppressed repeat must fall outside the 60s cooldown"
