"""run_pipeline with a scripture file: entries become cues (docs/14 sections 5 and 6, T-51.4).

Every transcript here is synthetic and every verse is King James or World English Bible text
(public domain): the repo is public, so no real sermon text is used.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from versesync.bible.base import (
    ProviderUnavailable,
    RawPassage,
    Translation,
    TranslationNotLicensed,
)
from versesync.bible.cache import CachingProvider
from versesync.bible.local import LocalProvider
from versesync.cues import SCHEMA_VERSION, SCHEMA_VERSION_SCRIPTURE_FILE, validate_document
from versesync.detect.canon import load_canon
from versesync.detect.detector import Detection, detect
from versesync.pipeline import Cancelled, PipelineConfig, run_pipeline
from versesync.scripture_file import ExportEntry, ExportWarning, parse_scripture_file
from versesync.timing.align import transcript_tokens
from versesync.timing.anchor import TimingConfig, paraphrase_duration
from versesync.timing.locate import text_candidates
from versesync.types import Reference, Word

REPO_ROOT = Path(__file__).resolve().parent.parent
CANON = load_canon()
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
TIMING = TimingConfig()

JOHN_3_16 = (
    "For God so loved the world, that he gave his only begotten Son, that whosoever "
    "believeth in him should not perish, but have everlasting life."
)
JOHN_3_16_WEB = (
    "For God so loved the world, that he gave his one and only Son, that whoever believes "
    "in him should not perish, but have eternal life."
)
ROMANS_8_28 = (
    "We know that all things work together for good for those who love God, to those who "
    "are called according to his purpose."
)
PSALM_91_15 = (
    "He shall call upon me, and I will answer him: I will be with him in trouble; "
    "I will deliver him, and honour him."
)
PSALM_23_1 = "Yahweh is my shepherd: I shall lack nothing."
JAMES_1_2 = (
    "My brethren, count it all joy when ye fall into divers temptations;",
    "Knowing this, that the trying of your faith worketh patience.",
    "But let patience have her perfect work, that ye may be perfect and entire, wanting nothing.",
)
JOHN_11_34 = "And said, Where have ye laid him? They said unto him, Lord, come and see."
JOHN_11_35 = "Jesus wept."

# Words that appear in none of the verses above, even allowing for one wrong letter.
FILLER_WORDS = (
    "welcome coffee parking volunteers brochure lobby nursery sticker banner pamphlet "
    "projector carpet cafeteria bulletin usher"
).split()


def filler(count: int) -> str:
    return " ".join(FILLER_WORDS[i % len(FILLER_WORDS)] for i in range(count))


def speak(*parts: tuple[float, str], pace: float = 0.4) -> list[Word]:
    """Words for each ``(start_s, text)`` part, ``pace`` seconds apart. Parts must not overlap."""
    words: list[Word] = []
    for start, text in parts:
        for i, raw in enumerate(text.split()):
            begin = start + i * pace
            words.append(Word(raw, begin, begin + 0.35, 0.95))
    return words


def export_entries(
    tmp_path: Path, *blocks: tuple[str, tuple[str, ...]]
) -> tuple[list[ExportEntry], list[ExportWarning]]:
    """Write ``(reference line, verse lines)`` blocks as an export file and parse it."""
    text = "\n\n".join("\n".join((header, *lines)) for header, lines in blocks) + "\n"
    path = tmp_path / "export.txt"
    path.write_text(text, encoding="utf-8")
    return parse_scripture_file(path, CANON)


def john(translation: str = "KJV") -> tuple[str, tuple[str, ...]]:
    body = JOHN_3_16 if translation == "KJV" else JOHN_3_16_WEB
    return (f"John 3:16 ({translation})", (f"16 {body}",))


def romans() -> tuple[str, tuple[str, ...]]:
    return ("Romans 8:28 (WEB)", (f"28 {ROMANS_8_28}",))


def psalm_91() -> tuple[str, tuple[str, ...]]:
    return ("Psalm 91:15 (KJV)", (f"15 {PSALM_91_15}",))


def psalm_23() -> tuple[str, tuple[str, ...]]:
    return ("Psalm 23:1 (WEB)", (f"1 {PSALM_23_1}",))


def james() -> tuple[str, tuple[str, ...]]:
    lines = tuple(f"{n} {t}" for n, t in zip((2, 3, 4), JAMES_1_2, strict=True))
    return ("James 1:2-4 (KJV)", lines)


def john_11() -> tuple[str, tuple[str, ...]]:
    return ("John 11:34-35 (KJV)", (f"34 {JOHN_11_34}", f"35 {JOHN_11_35}"))


def run(
    words: list[Word],
    entries: list[ExportEntry] | None,
    *,
    provider: Any = PROVIDER,
    **kwargs: Any,
) -> dict[str, Any]:
    return run_pipeline(
        words,
        translation=TRANSLATION,
        provider=provider,
        job=JOB,
        generated_at=GENERATED_AT,
        scripture_file=entries,
        **kwargs,
    )


def detections_of(words: list[Word]) -> list[Detection]:
    return detect(words, CANON)


def by_entry(doc: dict[str, Any], entry_index: int) -> list[dict[str, Any]]:
    return [c for c in doc["cues"] if c.get("text_source", {}).get("entry_index") == entry_index]


def only(cues: list[dict[str, Any]]) -> dict[str, Any]:
    assert len(cues) == 1, cues
    return cues[0]


class RecordingProvider:
    """The bundled KJV provider, recording every request made to it."""

    id = "recording"

    def __init__(self) -> None:
        self.inner = LocalProvider()
        self.calls: list[tuple[str, Reference]] = []

    def list_translations(self) -> list[Translation]:
        return self.inner.list_translations()

    def check(self) -> None:
        self.inner.check()

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        self.calls.append(("fetch", ref))
        return self.inner.fetch(ref, translation_id)

    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage:
        self.calls.append(("fetch_chapter", Reference(book_osis, book_osis, chapter)))
        return self.inner.fetch_chapter(book_osis, chapter, translation_id)


class DownProvider(RecordingProvider):
    """A provider whose every request fails with the given error."""

    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        self.calls.append(("fetch", ref))
        raise self.error


# --- the table of docs/14 section 5 -------------------------------------------------------------


def test_read_with_a_mention_anchors_on_the_earlier_of_the_two(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    words = speak((20.0, filler(5)), (30.0, "John three, sixteen."), (32.0, JOHN_3_16))
    (detection,) = detections_of(words)
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "read"
    assert cue["read_coverage"] == 1.0
    assert cue["read_start_s"] == 32.0
    assert cue["source_anchor_s"] == 29.5  # the mention, 30.0, less the 0.5 s lead-in
    assert cue["mention_start_s"] == detection.candidate.source_start
    assert cue["mention_end_s"] == detection.candidate.source_end
    assert cue["confidence"] == max(1.0, detection.confidence)
    assert cue["detection"]["pattern"] == detection.candidate.pattern
    assert cue["snippet"] == detection.snippet
    assert cue["flags"] == []
    assert cue["enabled"] is True


def test_read_without_a_mention_is_found_by_its_text(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, romans())
    words = speak((10.0, filler(6)), (40.0, ROMANS_8_28), (70.0, filler(6)))
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "read"
    assert cue["read_coverage"] == 1.0
    assert cue["source_anchor_s"] == 39.5
    assert cue["mention_start_s"] == cue["mention_end_s"] == cue["read_start_s"] == 40.0
    assert "detection" not in cue
    assert cue["snippet"].startswith("…") and "We know that all things" in cue["snippet"]
    assert cue["confidence"] == 1.0  # the coverage, with no corroboration bonus
    assert cue["flags"] == []
    assert cue["enabled"] is True


def test_weak_text_with_no_mention_is_a_low_confidence_paraphrase(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    said = (
        "For God so loved the world, that he gave his own Son, and whoever trusts "
        "in him will be saved and live"
    )
    words = speak((10.0, filler(6)), (30.0, said), (60.0, filler(6)))
    tokens = transcript_tokens(words)
    (candidate,) = text_candidates(entries[0], tokens)
    assert 0.30 <= candidate.coverage < 0.55

    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "paraphrase"
    assert cue["read_coverage"] == candidate.coverage
    assert "read_start_s" not in cue and "read_end_s" not in cue
    assert cue["confidence"] == candidate.coverage
    assert cue["flags"] == ["low_confidence"]
    assert cue["source_anchor_s"] == 29.5  # the first matched word less the lead-in
    assert cue["source_duration_s"] == paraphrase_duration(entries[0].word_count, TIMING)
    assert cue["enabled"] is True


def test_a_mention_alone_is_a_paraphrase_at_eight_tenths_confidence(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    words = speak((10.0, filler(6)), (30.0, "John three, sixteen."), (40.0, filler(6)))
    (detection,) = detections_of(words)
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "paraphrase"
    assert "read_coverage" not in cue
    assert cue["confidence"] == 0.8 * detection.confidence
    assert cue["source_anchor_s"] == 29.5
    assert cue["source_duration_s"] == paraphrase_duration(entries[0].word_count, TIMING)
    assert cue["detection"]["word_span"] == list(detection.candidate.word_span)
    assert cue["flags"] == []
    assert cue["enabled"] is True


def test_an_unplaced_entry_is_disabled_at_confidence_zero(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    cue = only(run(speak((10.0, filler(30))), entries)["cues"])
    assert cue["flags"] == ["not_found_in_audio"]
    assert cue["enabled"] is False
    assert cue["classification"] == "paraphrase"
    assert cue["confidence"] == 0.0
    assert cue["snippet"] == ""
    assert "detection" not in cue and "read_coverage" not in cue
    assert cue["mention_start_s"] == cue["mention_end_s"] == cue["source_anchor_s"]
    assert cue["source_duration_s"] == paraphrase_duration(entries[0].word_count, TIMING)
    assert cue["text_source"] == {"kind": "export", "translation": "KJV", "entry_index": 0}


def two_readings_out_of_file_order(tmp_path: Path) -> tuple[list[ExportEntry], list[Word]]:
    """The file lists Romans first, but the pastor reads John 3:16 well before it."""
    entries, _ = export_entries(tmp_path, romans(), john())
    words = speak((10.0, JOHN_3_16), (60.0, ROMANS_8_28))
    return entries, words


def test_a_reading_out_of_file_order_is_flagged_and_stays_enabled(tmp_path: Path) -> None:
    entries, words = two_readings_out_of_file_order(tmp_path)
    doc = run(words, entries)
    cue = only(by_entry(doc, 0))
    assert cue["flags"] == ["out_of_order"]
    assert cue["enabled"] is True
    assert cue["classification"] == "read"
    assert cue["read_start_s"] == 60.0
    assert cue["confidence"] == cue["read_coverage"]
    assert only(by_entry(doc, 1))["flags"] == []
    assert [c["reference_display"] for c in doc["cues"]] == ["John 3:16 (KJV)", "Romans 8:28 (WEB)"]


def test_a_second_reading_with_no_new_slide_is_a_repeat_read(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, romans())
    words = speak((10.0, ROMANS_8_28), (50.0, filler(6)), (80.0, ROMANS_8_28))
    cues = by_entry(run(words, entries), 0)
    first, again = cues
    assert (first["flags"], again["flags"]) == ([], ["repeat_read"])
    assert again["enabled"] is True
    assert again["classification"] == "read"
    assert again["source_anchor_s"] == 79.5
    assert again["body"] == first["body"] == entries[0].body
    assert again["reference_display"] == "Romans 8:28 (WEB)"
    assert again["confidence"] == again["read_coverage"]


def test_a_second_mention_with_no_new_slide_is_a_disabled_repeat_mention(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, psalm_91())
    words = speak(
        (10.0, "Psalm ninety-one, fifteen."),
        (13.0, PSALM_91_15),
        (50.0, filler(6)),
        (200.0, "Psalm ninety-one, fifteen."),
        (210.0, filler(6)),
    )
    first_detection, repeat_detection = detections_of(words)
    first, repeat = by_entry(run(words, entries), 0)
    assert first["flags"] == [] and first["classification"] == "read"
    assert repeat["flags"] == ["repeat_mention"]
    assert repeat["enabled"] is False
    assert repeat["classification"] == "paraphrase"
    assert repeat["confidence"] == 0.8 * repeat_detection.confidence
    assert repeat["source_anchor_s"] == 199.5
    assert repeat["body"] == entries[0].body
    assert repeat["reference_display"] == "Psalm 91:15 (KJV)"
    assert first["detection"]["word_span"] == list(first_detection.candidate.word_span)


# --- unplaced anchors ---------------------------------------------------------------------------


def placed_and_unplaced(tmp_path: Path, pattern: str) -> dict[str, Any]:
    """Entries John, Romans, Psalm 91:15; each letter of ``pattern`` is P (read) or U (silent)."""
    blocks = (john(), romans(), psalm_91())
    entries, _ = export_entries(tmp_path, *blocks)
    texts = (JOHN_3_16, ROMANS_8_28, PSALM_91_15)
    parts = [(20.0 + 60.0 * i, texts[i]) for i, flag in enumerate(pattern) if flag == "P"]
    words = speak(*parts, (300.0, filler(6))) if parts else speak((10.0, filler(30)))
    return run(words, entries)


def anchors_by_entry(doc: dict[str, Any]) -> dict[int, float]:
    return {c["text_source"]["entry_index"]: c["source_anchor_s"] for c in doc["cues"]}


def test_an_unplaced_anchor_is_the_midpoint_of_its_placed_neighbours(tmp_path: Path) -> None:
    doc = placed_and_unplaced(tmp_path, "PUP")
    anchors = anchors_by_entry(doc)
    assert anchors[0] == 19.5 and anchors[2] == 139.5
    assert anchors[1] == 79.5
    assert only(by_entry(doc, 1))["flags"] == ["not_found_in_audio"]


def test_an_unplaced_anchor_before_the_first_is_the_neighbour_less_its_duration(
    tmp_path: Path,
) -> None:
    doc = placed_and_unplaced(tmp_path, "UPP")
    neighbour = only(by_entry(doc, 1))
    expected = round(neighbour["source_anchor_s"] - neighbour["source_duration_s"], 3)
    assert anchors_by_entry(doc)[0] == expected


def test_an_unplaced_anchor_after_the_last_is_the_neighbour_plus_its_duration(
    tmp_path: Path,
) -> None:
    doc = placed_and_unplaced(tmp_path, "PPU")
    neighbour = only(by_entry(doc, 1))
    expected = round(neighbour["source_anchor_s"] + neighbour["source_duration_s"], 3)
    assert anchors_by_entry(doc)[2] == expected


def test_an_unplaced_anchor_is_never_below_zero(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john(), romans())
    words = speak((3.0, ROMANS_8_28), (60.0, filler(6)))
    doc = run(words, entries)
    neighbour = only(by_entry(doc, 1))
    assert neighbour["source_anchor_s"] - neighbour["source_duration_s"] < 0
    cue = only(by_entry(doc, 0))
    assert cue["source_anchor_s"] == 0.0
    assert cue["mention_start_s"] == 0.0


def test_with_nothing_placed_the_anchors_follow_each_other_by_duration(tmp_path: Path) -> None:
    doc = placed_and_unplaced(tmp_path, "UUU")
    cues = sorted(doc["cues"], key=lambda c: c["text_source"]["entry_index"])
    expected = 0.0
    for cue in cues:
        assert cue["flags"] == ["not_found_in_audio"]
        assert cue["source_anchor_s"] == round(expected, 3)
        expected += cue["source_duration_s"]
    assert [c["id"] for c in doc["cues"]] == ["cue_001", "cue_002", "cue_003"]


def test_unplaced_entries_between_the_same_neighbours_share_an_anchor(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john(), romans(), psalm_91(), psalm_23())
    words = speak((20.0, JOHN_3_16), (200.0, PSALM_23_1), (300.0, filler(6)))
    doc = run(words, entries)
    anchors = anchors_by_entry(doc)
    assert anchors[1] == anchors[2] == round((19.5 + 199.5) / 2, 3)


# --- every entry cue ----------------------------------------------------------------------------


def test_an_entry_cue_carries_the_exports_reference_translation_and_text(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john("WEB"))
    words = speak((20.0, JOHN_3_16_WEB))
    cue = only(run(words, entries)["cues"])
    assert TRANSLATION.abbreviation == "KJV"
    assert cue["reference_display"] == "John 3:16 (WEB)"
    assert cue["reference"] == {"book": "John", "osis": "John", "chapter": 3, "verse": 16}
    assert cue["body"] == entries[0].body
    assert cue["body_word_count"] == entries[0].word_count
    assert cue["body_truncated"] is False
    assert cue["origin"] == "detected"
    assert cue["text_source"] == {"kind": "export", "translation": "WEB", "entry_index": 0}
    assert cue["alternatives"] == []


def test_a_long_passage_is_flagged_but_never_truncated(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, james())
    words = speak((20.0, " ".join(JAMES_1_2)))
    cue = only(run(words, entries, cfg=PipelineConfig(max_verses=2))["cues"])
    assert cue["flags"] == ["long_passage"]
    assert cue["body"] == entries[0].body
    assert cue["body_truncated"] is False
    assert cue["enabled"] is True
    short = only(run(words, entries, cfg=PipelineConfig(max_verses=3))["cues"])
    assert short["flags"] == []


# --- verse_offsets_s ----------------------------------------------------------------------------


def start_of(words: list[Word], first_word: str) -> float:
    return next(w.start for w in words if w.text == first_word)


def test_verse_offsets_are_each_later_verse_start_after_the_anchor(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, james())
    words = speak((20.0, "James one, two through four."), (23.0, " ".join(JAMES_1_2)))
    cue = only(run(words, entries)["cues"])
    assert cue["source_anchor_s"] == 19.5
    assert cue["verse_offsets_s"] == {
        "3": round(start_of(words, "Knowing") - 19.5, 3),
        "4": round(start_of(words, "But") - 19.5, 3),
    }
    assert list(cue["verse_offsets_s"]) == ["3", "4"]


def test_a_verse_with_no_time_and_the_first_verse_have_no_offset(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, james())
    words = speak((20.0, " ".join(JAMES_1_2[:2]) + " " + filler(8)))
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "read"
    assert set(cue["verse_offsets_s"]) == {"3"}


def test_the_offsets_are_left_out_when_no_later_verse_has_a_time(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john_11())
    words = speak((20.0, JOHN_11_34), (40.0, filler(6)))
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "read"
    assert "verse_offsets_s" not in cue


def test_a_single_verse_cue_has_no_offsets(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    cue = only(run(speak((20.0, JOHN_3_16)), entries)["cues"])
    assert "verse_offsets_s" not in cue


def test_a_paraphrase_cue_has_no_offsets(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, james())
    words = speak((20.0, "James one, two through four."), (40.0, filler(8)))
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "paraphrase"
    assert "verse_offsets_s" not in cue


# --- duration -----------------------------------------------------------------------------------


def test_a_multi_verse_reading_is_not_capped_at_the_maximum_read_duration(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, james())
    words = speak((20.0, " ".join(JAMES_1_2)), pace=1.6)
    cue = only(run(words, entries)["cues"])
    assert cue["classification"] == "read"
    assert cue["read_end_s"] - cue["source_anchor_s"] > TIMING.max_read_duration_s
    assert cue["source_duration_s"] == round(
        cue["read_end_s"] - cue["source_anchor_s"] + TIMING.tail_pad_s, 3
    )


def test_a_single_verse_reading_is_still_capped(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    words = speak((20.0, JOHN_3_16), pace=3.5)
    cue = only(run(words, entries)["cues"])
    assert cue["read_end_s"] - cue["source_anchor_s"] > TIMING.max_read_duration_s
    assert cue["source_duration_s"] == TIMING.max_read_duration_s


def sweep(doc: dict[str, Any]) -> dict[str, Any]:
    """The panel's source-to-sequence mapping and overlap sweep (05 section 8) over ``doc``."""
    node = shutil.which("node")
    assert node, "node is needed to run panel/js/timemap.js, as CI does"
    host = REPO_ROOT / "tests" / "fixtures" / "host"
    request = {
        "doc": doc,
        "segments": json.loads((host / "segments-single.json").read_text("utf-8")),
        "seq": json.loads((host / "sequence-2997.json").read_text("utf-8")),
    }
    script = (
        "const T = require(process.argv[1]);"
        "const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "const out = T.mapCueDocument(r.doc, {segments: r.segments, seqInfo: r.seq});"
        "process.stdout.write(JSON.stringify(out.placements));"
    )
    done = subprocess.run(
        [node, "-e", script, str(REPO_ROOT / "panel" / "js" / "timemap.js")],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=True,
    )
    placements: dict[str, Any] = json.loads(done.stdout)
    return placements


def test_the_overlap_sweep_still_shortens_an_uncapped_export_cue(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, james(), john())
    james_words = speak((20.0, " ".join(JAMES_1_2)), pace=1.6)
    john_start = james_words[-1].end + 0.3
    words = james_words + speak((john_start, JOHN_3_16))
    doc = run(words, entries)
    long_cue, next_cue = doc["cues"]
    assert long_cue["source_duration_s"] > TIMING.max_read_duration_s
    assert long_cue["source_anchor_s"] + long_cue["source_duration_s"] > next_cue["source_anchor_s"]

    placements = sweep(doc)
    assert placements[long_cue["id"]]["panelFlags"] == ["truncated"]
    assert placements[next_cue["id"]]["panelFlags"] == []
    natural = long_cue["source_duration_s"] * 254016000000
    assert int(placements[long_cue["id"]]["durationTicks"]) < natural


# --- leftovers, the provider and the cache ------------------------------------------------------


def with_a_stray_mention(tmp_path: Path) -> tuple[list[ExportEntry], list[Word]]:
    entries, _ = export_entries(tmp_path, john())
    words = speak(
        (20.0, "John three, sixteen."),
        (22.0, JOHN_3_16),
        (60.0, "John one, one."),
        (70.0, filler(6)),
    )
    return entries, words


def test_a_detection_no_entry_used_becomes_a_disabled_not_in_export_cue(tmp_path: Path) -> None:
    entries, words = with_a_stray_mention(tmp_path)
    doc = run(words, entries)
    entry_cue, leftover = doc["cues"]
    assert entry_cue["text_source"]["kind"] == "export"
    assert leftover["flags"] == ["not_in_export"]
    assert leftover["enabled"] is False
    assert leftover["origin"] == "detected"
    assert leftover["reference_display"] == "John 1:1 (KJV)"
    assert leftover["body"].startswith("1 In the beginning was the Word")
    assert leftover["text_source"] == {"kind": "provider", "translation": "KJV"}
    assert leftover["snippet"]
    assert "detection" in leftover


def test_a_detection_an_entry_used_makes_no_second_cue(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john(), romans())
    words = speak(
        (20.0, "John three, sixteen."),
        (22.0, JOHN_3_16),
        (60.0, "Romans eight, twenty-eight."),
        (63.0, ROMANS_8_28),
    )
    doc = run(words, entries)
    assert len(detections_of(words)) == 2
    assert [c["text_source"]["entry_index"] for c in doc["cues"]] == [0, 1]


def test_chapter_only_and_suppressed_leftovers_keep_their_own_flags(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john())
    words = speak(
        (20.0, "John three, sixteen."),
        (22.0, JOHN_3_16),
        (60.0, "Take all of Psalm ninety-one home with you."),
        (90.0, filler(6)),
    )
    doc = run(words, entries)
    leftover = doc["cues"][-1]
    assert leftover["flags"] == ["chapter_only", "not_in_export"]
    assert leftover["enabled"] is False
    assert leftover["body"] == ""


def test_the_provider_is_called_only_for_the_leftovers(tmp_path: Path) -> None:
    provider = RecordingProvider()
    entries, words = with_a_stray_mention(tmp_path)
    run(words, entries, provider=provider)
    assert len(provider.calls) == 1
    kind, ref = provider.calls[0]
    assert (kind, ref.osis, ref.chapter, ref.verse) == ("fetch", "John", 1, 1)


def test_the_provider_is_not_called_when_every_detection_is_used(tmp_path: Path) -> None:
    provider = RecordingProvider()
    entries, _ = export_entries(tmp_path, john(), psalm_91())
    words = speak(
        (20.0, "John three, sixteen."),
        (22.0, JOHN_3_16),
        (100.0, "Psalm ninety-one, fifteen."),
        (103.0, PSALM_91_15),
    )
    doc = run(words, entries, provider=provider)
    assert len(doc["cues"]) == 2
    assert provider.calls == []


def test_the_provider_is_not_called_for_an_entry_nor_its_repeats(tmp_path: Path) -> None:
    provider = RecordingProvider()
    entries, _ = export_entries(tmp_path, psalm_91())
    words = speak(
        (10.0, "Psalm ninety-one, fifteen."),
        (13.0, PSALM_91_15),
        (50.0, PSALM_91_15),
        (200.0, "Psalm ninety-one, fifteen."),
    )
    doc = run(words, entries, provider=provider)
    assert [c["flags"] for c in doc["cues"]] == [[], ["repeat_read"], ["repeat_mention"]]
    assert provider.calls == []


def test_entry_text_is_never_written_to_the_bible_cache(tmp_path: Path) -> None:
    db = tmp_path / "verses.sqlite3"
    inner = RecordingProvider()
    cached = CachingProvider(inner, db_path=db)
    entries, words = with_a_stray_mention(tmp_path)

    run(words, entries, provider=cached)
    with closing(sqlite3.connect(db)) as conn:
        stored = conn.execute(
            "SELECT osis_book, chapter, verse_start, verse_end, verses FROM verses"
        ).fetchall()
    assert [row[:4] for row in stored] == [("John", 1, 1, 1)]
    assert all(entries[0].lines[0] not in row[4] for row in stored)

    db.unlink()
    only_entries, _ = export_entries(tmp_path, john())
    run(speak((20.0, JOHN_3_16)), only_entries, provider=CachingProvider(inner, db_path=db))
    assert not db.exists()


# --- a provider that fails ----------------------------------------------------------------------


@pytest.mark.parametrize("error", [ProviderUnavailable(), TranslationNotLicensed()])
def test_a_failing_provider_flags_the_leftovers_and_the_job_still_finishes(
    tmp_path: Path, error: Exception
) -> None:
    entries, words = with_a_stray_mention(tmp_path)
    doc = run(words, entries, provider=DownProvider(error))
    entry_cue, leftover = doc["cues"]
    assert leftover["flags"] == ["text_unavailable", "not_in_export"]
    assert leftover["enabled"] is False
    assert leftover["body"] == ""
    assert leftover["text_source"] == {"kind": "provider", "translation": "KJV"}
    assert entry_cue["body"] == entries[0].body
    assert entry_cue["flags"] == []
    assert doc["warnings"] == [
        {"code": "provider_partial", "message": "1 passages could not be fetched."}
    ]
    validate_document(doc)


def test_without_entries_a_failing_licence_still_fails_the_job() -> None:
    words = speak((20.0, "John three, sixteen."), (30.0, filler(6)))
    with pytest.raises(TranslationNotLicensed):
        run(words, None, provider=DownProvider(TranslationNotLicensed()))


# --- the document -------------------------------------------------------------------------------


def a_document(tmp_path: Path, **kwargs: Any) -> dict[str, Any]:
    entries, words = with_a_stray_mention(tmp_path)
    return run(words, entries, **kwargs)


def test_a_document_built_from_a_scripture_file_is_1_1_and_valid(tmp_path: Path) -> None:
    doc = a_document(tmp_path)
    assert doc["schema_version"] == SCHEMA_VERSION_SCRIPTURE_FILE == "1.1"
    assert "scripture_file" not in doc
    validate_document(doc)


def test_the_scripture_file_block_is_optional_and_valid_when_given(tmp_path: Path) -> None:
    block = {"path": "D:/Sermons/export.txt", "sha256": "ab" * 32, "entry_count": 1}
    doc = a_document(tmp_path, scripture_file_block=block)
    assert doc["schema_version"] == "1.1"
    assert doc["scripture_file"] == block
    assert list(doc)[5:7] == ["scripture_file", "cues"]
    validate_document(doc)


def test_the_parsers_warnings_go_in_the_document(tmp_path: Path) -> None:
    path = tmp_path / "with-warnings.txt"
    header, lines = john()
    path.write_text(
        "A stray line\n\nHezekiah 3:4 (KJV)\n4 Nope.\n\n" + "\n".join((header, *lines)) + "\n",
        encoding="utf-8",
    )
    entries, warnings = parse_scripture_file(path, CANON)
    assert len(warnings) == 2
    doc = run(speak((20.0, JOHN_3_16)), entries, scripture_warnings=warnings)
    assert [(w["code"], w["line"]) for w in doc["warnings"]] == [
        ("export_block_unreferenced", 1),
        ("export_reference_invalid", 3),
    ]
    validate_document(doc)


def test_without_entries_the_document_is_1_0_and_holds_no_1_1_field() -> None:
    words = speak((20.0, "John three, sixteen."), (22.0, JOHN_3_16))
    plain = run_pipeline(
        words, translation=TRANSLATION, provider=PROVIDER, job=JOB, generated_at=GENERATED_AT
    )
    assert plain["schema_version"] == SCHEMA_VERSION == "1.0"
    assert "scripture_file" not in plain
    for cue in plain["cues"]:
        assert "text_source" not in cue and "verse_offsets_s" not in cue
        assert "not_in_export" not in cue["flags"]
    assert run(words, None) == plain
    assert run(words, []) == plain
    assert json.dumps(run(words, None)) == json.dumps(plain)


def test_cues_are_in_time_order_with_sequential_ids(tmp_path: Path) -> None:
    entries, _ = export_entries(tmp_path, john(), romans(), psalm_91())
    words = speak(
        (10.0, "John one, one."),
        (60.0, ROMANS_8_28),
        (120.0, "Psalm ninety-one, fifteen."),
        (123.0, PSALM_91_15),
        (300.0, filler(6)),
    )
    doc = run(words, entries)
    assert [c["id"] for c in doc["cues"]] == [f"cue_{i:03d}" for i in range(1, 5)]
    starts = [c["mention_start_s"] for c in doc["cues"]]
    assert starts == sorted(starts)
    assert [c["reference_display"] for c in doc["cues"]] == [
        "John 1:1 (KJV)",  # a detection no entry used
        "John 3:16 (KJV)",  # unplaced, so interpolated just before Romans
        "Romans 8:28 (WEB)",
        "Psalm 91:15 (KJV)",
    ]
    assert list(doc["cues"][0])[0] == "id"


def test_two_runs_are_byte_identical(tmp_path: Path) -> None:
    entries, words = with_a_stray_mention(tmp_path)
    first = json.dumps(run(words, entries), indent=1)
    assert first == json.dumps(run(words, entries), indent=1)


def test_phases_run_in_order_and_cancelling_stops_the_run(tmp_path: Path) -> None:
    entries, words = with_a_stray_mention(tmp_path)
    events: list[tuple[str, float]] = []
    run(words, entries, on_phase=lambda p, f, m: events.append((p, f)))
    phases: list[str] = []
    for phase, _ in events:
        if not phases or phases[-1] != phase:
            phases.append(phase)
    assert phases == ["detecting", "resolving", "timing"]
    for phase in phases:
        fractions = [f for p, f in events if p == phase]
        assert fractions == sorted(fractions) and fractions[-1] == 1.0

    timing_started: list[bool] = []
    with pytest.raises(Cancelled):
        run(
            words,
            entries,
            on_phase=lambda p, f, m: timing_started.append(p == "timing"),
            is_cancelled=lambda: any(timing_started),
        )


def test_the_golden_export_document_has_a_cue_for_every_row_of_the_table() -> None:
    golden = REPO_ROOT / "tests" / "golden" / "service-export.cues.json"
    doc = json.loads(golden.read_text(encoding="utf-8"))
    validate_document(doc)
    assert doc["schema_version"] == "1.1"
    assert doc["scripture_file"]["entry_count"] == 8
    assert [w["code"] for w in doc["warnings"]] == [
        "export_block_unreferenced",
        "export_reference_invalid",
    ]

    cues = doc["cues"]
    flags = {flag for cue in cues for flag in cue["flags"]}
    assert flags == {
        "low_confidence",
        "not_found_in_audio",
        "out_of_order",
        "repeat_read",
        "repeat_mention",
        "not_in_export",
        "chapter_only",
    }
    export_cues = [c for c in cues if c["text_source"]["kind"] == "export"]
    assert {c["classification"] for c in export_cues} == {"read", "paraphrase"}
    assert any("detection" in c and c["classification"] == "read" for c in export_cues)
    assert any("detection" not in c and c["classification"] == "read" for c in export_cues)
    assert any("detection" in c and c["classification"] == "paraphrase" for c in export_cues)
    assert any("verse_offsets_s" in c for c in export_cues)
    assert all(not c["enabled"] for c in cues if "not_in_export" in c["flags"])
    assert {c["text_source"]["entry_index"] for c in export_cues} == set(range(8))
