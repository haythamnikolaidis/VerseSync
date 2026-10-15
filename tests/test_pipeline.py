import json
import time
from typing import Any

import pytest
from transcript_fixtures import FIXTURE_NAMES, FIXTURES_DIR

from versesync.bible.base import Translation
from versesync.bible.local import LocalProvider
from versesync.cues import validate_document
from versesync.pipeline import Cancelled, PipelineConfig, run_pipeline
from versesync.types import Word, load_words

PROVIDER = LocalProvider()
TRANSLATION: Translation = PROVIDER.list_translations()[0]
JOB: dict[str, Any] = {
    "id": "job_TEST",
    "media_path": "D:/Sermons/test.MXF",
    "media_hash": "sha256:" + "ab" * 32,
    "media_duration_s": 600.0,
    "model": "distil-large-v3",
    "quantization": "float16",
    "device": "cpu",
    "language": "en",
    "options": {},
}
GENERATED_AT = "2026-09-14T10:00:00Z"
PIPELINE_BUDGET_S = 15.0  # NFR-2


def _words(name: str) -> list[Word]:
    return load_words(FIXTURES_DIR / f"{name}.words.json")


def _run(words: list[Word], **kwargs: Any) -> dict[str, Any]:
    return run_pipeline(
        words,
        translation=TRANSLATION,
        provider=PROVIDER,
        job=JOB,
        generated_at=GENERATED_AT,
        **kwargs,
    )


def _dump(doc: dict[str, Any]) -> str:
    return json.dumps(doc, sort_keys=False, indent=1, ensure_ascii=False)


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_document_is_schema_valid(name: str) -> None:
    doc = _run(_words(name))
    validate_document(doc)
    assert doc["cues"]
    assert doc["transcript"] == {
        "word_count": len(_words(name)),
        "words_ref": "transcript_job_TEST.json",
    }
    assert doc["job"] == JOB
    assert doc["generated_at"] == GENERATED_AT


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_two_runs_are_byte_identical(name: str) -> None:
    words = _words(name)
    assert _dump(_run(words)) == _dump(_run(words))


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_phases_in_order_with_fractions_never_decreasing(name: str) -> None:
    events: list[tuple[str, float, str | None]] = []
    _run(_words(name), on_phase=lambda p, f, m: events.append((p, f, m)))

    phases: list[str] = []
    for phase, _, _ in events:
        if not phases or phases[-1] != phase:
            phases.append(phase)
    assert phases == ["detecting", "resolving", "timing"]
    for phase in phases:
        fractions = [f for p, f, _ in events if p == phase]
        assert fractions == sorted(fractions)
        assert fractions[0] == 0.0
        assert fractions[-1] == 1.0
        assert all(0.0 <= f <= 1.0 for f in fractions)


@pytest.mark.parametrize("phase", ["detecting", "resolving", "timing"])
def test_cancelling_between_phases_raises(phase: str) -> None:
    seen: list[str] = []

    def on_phase(p: str, fraction: float, message: str | None) -> None:
        seen.append(p)

    def is_cancelled() -> bool:
        # Cancel as soon as the named phase has started reporting.
        return phase in seen

    with pytest.raises(Cancelled):
        _run(_words("numbers-and-ordinals"), on_phase=on_phase, is_cancelled=is_cancelled)


def test_cancelling_between_cues_raises() -> None:
    timing_ticks = 0

    def on_phase(p: str, fraction: float, message: str | None) -> None:
        nonlocal timing_ticks
        if p == "timing" and fraction > 0.0:
            timing_ticks += 1

    with pytest.raises(Cancelled):
        _run(
            _words("numbers-and-ordinals"),
            on_phase=on_phase,
            is_cancelled=lambda: timing_ticks >= 1,
        )
    assert timing_ticks == 1


def test_never_cancelled_runs_to_completion() -> None:
    assert _run(_words("read-vs-paraphrase"), is_cancelled=lambda: False)["cues"]


def test_no_references_gives_an_empty_valid_document() -> None:
    words = [Word("hello", 0.0, 0.4, 0.99), Word("there", 0.4, 0.8, 0.99)]
    events: list[str] = []
    doc = _run(words, on_phase=lambda p, f, m: events.append(p))
    assert doc["cues"] == []
    assert doc["transcript"]["word_count"] == 2
    assert events[-1] == "timing"


def test_config_is_applied() -> None:
    words = _words("read-vs-paraphrase")
    default = _run(words)
    short = _run(words, cfg=PipelineConfig(max_verses=1))
    assert [c["id"] for c in short["cues"]] == [c["id"] for c in default["cues"]]
    assert any(
        s["body_word_count"] < d["body_word_count"]
        for s, d in zip(short["cues"], default["cues"], strict=True)
    )


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_finishes_within_the_nfr2_budget(name: str) -> None:
    words = _words(name)
    start = time.perf_counter()
    _run(words)
    assert time.perf_counter() - start < PIPELINE_BUDGET_S


def test_cues_are_in_order_and_ids_sequential() -> None:
    doc = _run(_words("long-sermon-filler"))
    assert [c["id"] for c in doc["cues"]] == [
        f"cue_{i:03d}" for i in range(1, len(doc["cues"]) + 1)
    ]
    starts = [c["mention_start_s"] for c in doc["cues"]]
    assert starts == sorted(starts)
