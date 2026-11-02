"""Tests for versesync.timing.locate (docs/14 sections 4.1 to 4.7).

Every transcript here is synthetic and every verse is King James text (public domain): the
repo is public, so no real sermon text is used.
"""

from __future__ import annotations

import itertools
import random
import time
from dataclasses import replace
from pathlib import Path

import pytest
from transcript_fixtures import FIXTURES_DIR

from versesync.bible.local import LocalProvider
from versesync.config import load_config
from versesync.detect.canon import load_canon
from versesync.detect.detector import Detection, detect
from versesync.detect.parse import parse_reference
from versesync.scripture_file import ExportEntry
from versesync.timing.align import AToken, normalise_verse, tokens_equal, transcript_tokens
from versesync.timing.locate import (
    LocateConfig,
    LocatedCue,
    LocateResult,
    MentionCandidate,
    Placement,
    TextCandidate,
    TokenIndex,
    assign,
    build_candidates,
    locate,
    mention_candidates,
    merge,
    text_candidates,
)
from versesync.types import Word, load_words

CANON = load_canon()
CFG = LocateConfig()

JOHN_3_16 = (
    "For God so loved the world, that he gave his only begotten Son, that whosoever "
    "believeth in him should not perish, but have everlasting life."
)
JAMES_1_4 = (
    "But let patience have her perfect work, that ye may be perfect and entire, wanting nothing."
)
ROMANS_8_28 = (
    "And we know that all things work together for good to them that love God, to them who "
    "are the called according to his purpose."
)
PSALM_91_15 = (
    "He shall call upon me, and I will answer him: I will be with him in trouble; "
    "I will deliver him, and honour him."
)
PSALM_27_1 = (
    "The LORD is my light and my salvation; whom shall I fear? the LORD is the strength "
    "of my life; of whom shall I be afraid?"
)
CHARITY = (
    "Charity suffereth long, and is kind; charity envieth not; charity vaunteth not itself, "
    "is not puffed up,"
)

# Words that appear in none of the verses above, even allowing for one wrong letter.
FILLER_WORDS = (
    "welcome coffee parking volunteers brochure lobby nursery sticker banner pamphlet "
    "projector carpet cafeteria bulletin usher"
).split()


def filler(count: int, offset: int = 0) -> str:
    return " ".join(FILLER_WORDS[(offset + i) % len(FILLER_WORDS)] for i in range(count))


def speak(*parts: tuple[float, str]) -> list[Word]:
    """Words for each ``(start_s, text)`` part, 0.4 s apart. Parts must not overlap in time."""
    words: list[Word] = []
    for start, text in parts:
        for i, raw in enumerate(text.split()):
            begin = start + i * 0.4
            words.append(Word(raw, begin, begin + 0.35, 0.95))
    return words


def make_entry(index: int, reference: str, translation: str, text: str) -> ExportEntry:
    line = f"{reference.rsplit(':', 1)[1].split('-')[0]} {text}"
    return ExportEntry(
        index=index,
        reference_line=f"{reference} ({translation})",
        reference=parse_reference(reference, CANON),
        translation=translation,
        lines=(line,),
        body=line,
        word_count=len(line.split()),
    )


def john_entry(index: int = 0) -> ExportEntry:
    return make_entry(index, "John 3:16", "KJV", JOHN_3_16)


def james_entry(index: int = 0) -> ExportEntry:
    return make_entry(index, "James 1:4", "KJV", JAMES_1_4)


def tokens_in(words: list[Word]) -> list[AToken]:
    return transcript_tokens(words)


def detections_in(words: list[Word]) -> list[Detection]:
    return detect(words, CANON)


# --- configuration -----------------------------------------------------------------------------


def test_config_defaults_match_the_spec(bare_home: Path) -> None:
    assert load_config().scripture_file == {
        "text_min_coverage": 0.30,
        "candidates_per_entry": 5,
        "merge_before_s": 120,
        "merge_after_s": 20,
        "merge_bonus": 0.25,
        "mention_weight": 0.5,
        "repeat_min_matched_tokens": 5,
    }
    assert LocateConfig.from_config(load_config()) == LocateConfig()


def test_config_file_overrides_scripture_file_keys(bare_home: Path) -> None:
    bare_home.mkdir(parents=True)
    (bare_home / "config.yaml").write_text(
        "scripture_file:\n  text_min_coverage: 0.4\n  merge_after_s: 5\n  unknown_key: 1\n",
        encoding="utf-8",
    )
    cfg = LocateConfig.from_config(load_config())
    assert cfg == replace(LocateConfig(), text_min_coverage=0.4, merge_after_s=5)


# --- text candidates (14 section 4.1) ----------------------------------------------------------


def test_clean_reading_is_found_at_full_coverage() -> None:
    words = speak((0.0, filler(30)), (50.0, JOHN_3_16), (80.0, filler(20)))
    tokens = tokens_in(words)
    found = text_candidates(john_entry(), tokens, CFG)
    last_word = 30 + len(JOHN_3_16.split()) - 1
    assert found == [
        TextCandidate(
            entry_index=0,
            coverage=1.0,
            matched=len(normalise_verse([JOHN_3_16])),
            read_start_s=words[30].start,
            read_end_s=words[last_word].end,
            word_span=(30, last_word),
            start_token=30,
        )
    ]


def test_two_readings_21_seconds_apart_stay_two_candidates() -> None:
    # Psalm 27:1 read twice, the second reading starting 21 s after the first.
    words = speak(
        (100.0, PSALM_27_1), (110.8, filler(25)), (121.0, PSALM_27_1), (140.0, filler(10))
    )
    entry = make_entry(0, "Psalm 27:1", "KJV", PSALM_27_1)
    found = text_candidates(entry, tokens_in(words), CFG)
    assert [c.coverage for c in found] == [1.0, 1.0]
    # "The" is a stop word, so each reading starts at "LORD", its second word.
    second = len(PSALM_27_1.split()) + 25
    assert [c.read_start_s for c in found] == [words[1].start, words[second + 1].start]
    assert found[1].read_start_s - found[0].read_start_s == pytest.approx(21.0)
    assert found[0].word_span[1] < found[1].word_span[0]


def test_candidates_are_sorted_by_coverage_then_earliest() -> None:
    partial = " ".join(JOHN_3_16.split()[:14])  # about two thirds of the verse
    # The gap is wider than the span cap, so the partial reading can't pick up the later ones.
    words = speak((50.0, partial), (100.0, filler(100)), (200.0, JOHN_3_16), (300.0, JOHN_3_16))
    found = text_candidates(john_entry(), tokens_in(words), CFG)
    assert [c.read_start_s for c in found] == [200.0, 300.0, 50.0]
    assert found[0].coverage == found[1].coverage == 1.0
    assert 0.5 < found[2].coverage < 1.0


def test_candidates_per_entry_keeps_the_earliest_of_equal_readings() -> None:
    words = speak((10.0, JOHN_3_16), (100.0, JOHN_3_16), (200.0, JOHN_3_16))
    found = text_candidates(john_entry(), tokens_in(words), replace(CFG, candidates_per_entry=2))
    assert [c.read_start_s for c in found] == [10.0, 100.0]


def test_runs_below_the_minimum_coverage_are_dropped() -> None:
    five_of_twenty_one = "For God so loved the world"
    seven_of_twenty_one = "For God so loved the world he gave"
    low = tokens_in(speak((10.0, five_of_twenty_one), (30.0, filler(20))))
    high = tokens_in(speak((10.0, seven_of_twenty_one), (30.0, filler(20))))
    assert text_candidates(john_entry(), low, CFG) == []
    (found,) = text_candidates(john_entry(), high, CFG)
    assert found.matched == 7
    assert found.coverage == pytest.approx(7 / 21)


def test_span_cap_stops_a_run_collecting_scattered_matches() -> None:
    # Each verse word is six tokens after the last, within the skip budget, so an uncapped run
    # would match all of them. The cap, 3|V| + 30 tokens, stops it part of the way.
    entry = make_entry(0, "Romans 8:28", "KJV", ROMANS_8_28)
    verse = normalise_verse(entry.lines)
    scattered = " ".join(f"{word} {filler(5, offset=i)}" for i, word in enumerate(verse))
    cap = 3 * len(verse) + 30
    reachable = len([k for k in range(len(verse)) if 6 * k < cap])
    assert reachable < len(verse)
    (found,) = text_candidates(entry, tokens_in(speak((0.0, scattered))), CFG)
    assert found.matched == reachable


def test_verse_that_normalises_to_nothing_has_no_candidates() -> None:
    tokens = tokens_in(speak((0.0, "the and of 12 that " + filler(10))))
    for lines in ((), ("12",), ("3 the and of", "4 to in that")):
        entry = replace(john_entry(), lines=lines)
        assert text_candidates(entry, tokens, CFG) == []


def test_empty_transcript_has_no_candidates() -> None:
    assert text_candidates(john_entry(), [], CFG) == []


def test_one_token_verse_gives_separate_candidates() -> None:
    entry = replace(john_entry(), lines=("1 Selah.",))
    words = speak((0.0, f"selah {filler(5)} selah {filler(5)} selah"))
    found = text_candidates(entry, tokens_in(words), CFG)
    assert [c.coverage for c in found] == [1.0, 1.0, 1.0]
    assert [c.read_start_s for c in found] == [words[0].start, words[6].start, words[12].start]


def test_a_misheard_opening_is_still_a_start() -> None:
    # "charitty" and "sufferth" are one letter off, and "long" is too short to match loosely, so
    # the start of this reading is only found through the loose match.
    spoken = (
        "charitty sufferth long and is kind charity envieth not charity vaunteth not itself "
        "is not puffed up"
    )
    entry = make_entry(0, "1 Corinthians 13:4", "KJV", CHARITY)
    words = speak((5.0, spoken))
    (found,) = text_candidates(entry, tokens_in(words), CFG)
    assert found.word_span[0] == 0
    assert found.coverage == 1.0


def test_token_index_agrees_with_testing_every_token() -> None:
    words = speak((0.0, CHARITY.lower() + " charitty sufferth sufferethh begining " + filler(14)))
    words += speak((100.0, JOHN_3_16 + " " + ROMANS_8_28))
    tokens = tokens_in(words)
    index = TokenIndex(tokens)
    probes = {t.text for t in tokens} | {"charity", "sufferth", "begining", "beginning", "godd"}
    probes |= {t[:-1] for t in probes if len(t) > 4} | {t + "s" for t in probes if len(t) > 3}
    for probe in sorted(probes):
        expected = [i for i, t in enumerate(tokens) if tokens_equal(t.text, probe)]
        assert index.positions_equal_to(probe) == expected, probe


def test_a_shared_index_gives_the_same_candidates() -> None:
    words = speak((10.0, JOHN_3_16), (100.0, filler(10)), (200.0, JOHN_3_16))
    tokens = tokens_in(words)
    index = TokenIndex(tokens)
    assert text_candidates(john_entry(), tokens, CFG, index) == text_candidates(
        john_entry(), tokens, CFG
    )
    with pytest.raises(ValueError):
        text_candidates(john_entry(), tokens_in(words), CFG, index)


# --- mention candidates (14 section 4.2) -------------------------------------------------------


SPOKEN_REFERENCES = (
    (10.0, "turn to James chapter 1 verse 4"),
    (200.0, "back in James chapter 1"),
    (300.0, "James chapter 2 verse 4"),
    (400.0, "Psalm 91 verse 15"),
    (500.0, "James chapter 1 verse 2"),
    (600.0, "James chapter 1 verses 3 to 5"),
    (700.0, "James chapter 1 verse 4 to 6"),
)


def test_mentions_are_the_detections_that_match_the_entry() -> None:
    detections = detections_in(speak(*SPOKEN_REFERENCES))
    found = mention_candidates(james_entry(), detections, CFG)
    # James 1:4, "James 1" (chapter-only), James 1:3-5 and James 1:4-6; not James 2:4, Psalm
    # 91:15 or James 1:2.
    assert [m.mention_start_s for m in found] == [10.8, 200.8, 600.0, 700.0]
    assert [m.detection.reference.verse for m in found] == [4, None, 3, 4]
    assert all(m.entry_index == 0 for m in found)


def test_mention_score_is_half_the_confidence_and_chapter_only_counts() -> None:
    detections = detections_in(speak((10.0, "back in James chapter 1")))
    (found,) = mention_candidates(james_entry(), detections, CFG)
    assert "chapter_only" in found.detection.flags
    assert found.score == 0.5 * found.detection.confidence
    (heavier,) = mention_candidates(james_entry(), detections, replace(CFG, mention_weight=0.8))
    assert heavier.score == 0.8 * found.detection.confidence


def test_mention_start_is_the_first_spoken_word_of_the_reference() -> None:
    detections = detections_in(speak((10.0, "turn to James chapter 1 verse 4")))
    (found,) = mention_candidates(james_entry(), detections, CFG)
    assert found.mention_start_s == detections[0].candidate.source_start


def test_a_suppressed_duplicate_is_still_a_mention() -> None:
    detections = detections_in(
        speak((10.0, "James chapter 1 verse 4"), (30.0, "again James chapter 1 verse 4"))
    )
    assert "suppressed_duplicate" in detections[1].flags
    assert len(mention_candidates(james_entry(), detections, CFG)) == 2


def test_no_detection_means_no_mention() -> None:
    assert mention_candidates(james_entry(), [], CFG) == []


# --- merging (14 section 4.3) ------------------------------------------------------------------


DETECTION = detections_in(speak((0.0, "James chapter 1 verse 4")))[0]


def text_at(
    read_start_s: float, coverage: float = 0.8, span: tuple[int, int] = (50, 80)
) -> TextCandidate:
    return TextCandidate(0, coverage, 10, read_start_s, read_start_s + 10.0, span, 40)


def mention_at(start_s: float, score: float = 0.4) -> MentionCandidate:
    return MentionCandidate(0, DETECTION, score, start_s)


def test_a_mention_before_the_read_merges_with_the_text() -> None:
    text = text_at(500.0)
    mention = mention_at(450.0)
    (placement,) = merge([text], [mention], CFG)
    assert placement.score == pytest.approx(0.8 + 0.25)
    assert placement.time_s == 450.0
    assert placement.word_span == (50, 80)
    assert placement.text is text
    assert placement.mention is mention
    assert placement.entry_index == 0


def test_merge_window_is_120_s_before_and_20_s_after_the_read_start() -> None:
    text = text_at(500.0)
    for start, merged in ((380.0, True), (379.0, False), (520.0, True), (521.0, False)):
        placements = merge([text], [mention_at(start)], CFG)
        kinds = sorted((p.text is not None, p.mention is not None) for p in placements)
        assert kinds == ([(True, True)] if merged else [(False, True), (True, False)]), start


def test_merge_window_follows_the_config() -> None:
    text = text_at(500.0)
    narrow = replace(CFG, merge_before_s=10, merge_after_s=0, merge_bonus=0.5)
    assert len(merge([text], [mention_at(485.0)], narrow)) == 2
    (placement,) = merge([text], [mention_at(495.0)], narrow)
    assert placement.score == pytest.approx(0.8 + 0.5)


def test_unmerged_text_and_mentions_stay_separate_placements_in_time_order() -> None:
    text = text_at(500.0, coverage=0.9)
    far = mention_at(100.0, score=0.45)
    later = mention_at(900.0, score=0.3)
    placements = merge([text], [later, far], CFG)
    assert [p.time_s for p in placements] == [100.0, 500.0, 900.0]
    assert [p.score for p in placements] == [0.45, 0.9, 0.3]
    assert [p.mention is not None for p in placements] == [True, False, True]
    assert [p.text is not None for p in placements] == [False, True, False]


def test_a_text_candidate_takes_the_nearest_mention_and_the_rest_stay_mentions() -> None:
    text = text_at(500.0)
    near, early, tie_a, tie_b = (
        mention_at(490.0),
        mention_at(420.0),
        mention_at(480.0),
        mention_at(520.0),
    )
    placements = merge([text], [early, tie_a, near, tie_b], CFG)
    merged = [p for p in placements if p.text is not None]
    assert [p.mention for p in merged] == [near]
    assert sorted(p.time_s for p in placements if p.text is None) == [420.0, 480.0, 520.0]
    # Equal distance (20 s either side) goes to the earlier mention.
    (tied,) = [p for p in merge([text], [tie_b, tie_a], CFG) if p.text is not None]
    assert tied.mention is tie_a


def test_each_mention_joins_at_most_one_text_candidate() -> None:
    # Two readings 21 s apart share one mention before both; the first listed takes it.
    first, second = text_at(100.0, 0.9, (10, 40)), text_at(121.0, 0.8, (60, 90))
    mention = mention_at(95.0)
    placements = merge([second, first], [mention], CFG)
    by_text = {p.text: p for p in placements if p.text is not None}
    assert by_text[second].mention is mention
    assert by_text[first].mention is None
    assert sum(p.mention is not None for p in placements) == 1
    assert [p.time_s for p in placements] == [95.0, 100.0]


def test_merge_with_nothing_gives_nothing() -> None:
    assert merge([], [], CFG) == []


# --- assignment (14 section 4.4) ---------------------------------------------------------------


def candidates_for(
    entries: list[ExportEntry], words: list[Word], cfg: LocateConfig = CFG
) -> list[list[Placement]]:
    return build_candidates(entries, tokens_in(words), detections_in(words), cfg)


def psalm_entry(index: int = 0) -> ExportEntry:
    return make_entry(index, "Psalm 91:15", "KJV", PSALM_91_15)


def romans_entry(index: int = 0) -> ExportEntry:
    return make_entry(index, "Romans 8:28", "KJV", ROMANS_8_28)


def repeat_sermon() -> list[Word]:
    """James 1:4 introduced and read, Psalm 91:15 introduced and read, then "James 1" again."""
    return speak(
        (100.0, "turn to James chapter 1 verse 4"),
        (106.0, JAMES_1_4),
        (300.0, "Psalm 91 verse 15"),
        (306.0, PSALM_91_15),
        (600.0, "back to James chapter 1"),
    )


def test_a_clean_read_is_placed_at_full_coverage_with_its_mention() -> None:
    words = speak((0.0, filler(20)), (40.0, "turn to John chapter 3 verse 16"))
    words += speak((46.0, JOHN_3_16), (80.0, filler(20)))
    entries = [john_entry()]
    (placed,) = assign(entries, candidates_for(entries, words))
    assert placed is not None
    assert placed.text is not None and placed.mention is not None
    assert placed.text.coverage == 1.0
    assert placed.score == pytest.approx(1.25)
    assert placed.time_s == placed.mention.mention_start_s
    assert placed.text.read_start_s == 46.0


def test_a_repeat_takes_its_later_mention() -> None:
    # James 1:4 is shown twice with Psalm 91:15 between. The reading sits before the psalm, so
    # the second slide can't use it and takes the later mention of "James 1".
    entries = [james_entry(0), psalm_entry(1), james_entry(2)]
    first, middle, repeat = assign(entries, candidates_for(entries, repeat_sermon()))
    assert first is not None and middle is not None and repeat is not None
    assert first.text is not None and first.text.coverage == 1.0
    assert middle.text is not None and middle.text.coverage == 1.0
    assert repeat.text is None and repeat.mention is not None
    assert repeat.mention.detection.reference.verse is None  # "James 1", chapter-only
    assert first.time_s < middle.time_s < repeat.time_s
    assert repeat.time_s == repeat.mention.mention_start_s > 600.0


def test_with_two_entries_out_of_order_the_larger_total_is_kept() -> None:
    entries = [psalm_entry(0), romans_entry(1)]
    # File order is the psalm, then Romans. Romans is read in full early, the psalm only in part
    # and later, so the two can't both be placed in order, and the full reading wins.
    words = speak((100.0, ROMANS_8_28), (300.0, " ".join(PSALM_91_15.split()[:14])))
    candidates = candidates_for(entries, words)
    assert candidates[0][0].score < candidates[1][0].score
    placed = assign(entries, candidates)
    assert placed[0] is None
    assert placed[1] is not None and placed[1].text is not None
    assert placed[1].text.coverage == 1.0
    # The other way round, the psalm is read in full and Romans in part: now Romans loses.
    words = speak((100.0, " ".join(ROMANS_8_28.split()[:14])), (300.0, PSALM_91_15))
    placed = assign(entries, candidates_for(entries, words))
    assert placed[1] is None
    assert placed[0] is not None and placed[0].text is not None
    assert placed[0].text.coverage == 1.0


def test_an_entry_with_no_candidate_is_left_unplaced() -> None:
    words = speak((100.0, JOHN_3_16), (200.0, filler(20)))
    entries = [john_entry(0), james_entry(1), romans_entry(2)]
    candidates = candidates_for(entries, words)
    assert candidates[1] == [] and candidates[2] == []
    placed = assign(entries, candidates)
    assert placed[0] is not None
    assert placed[1:] == [None, None]


def test_identical_input_gives_identical_output() -> None:
    entries = [james_entry(0), psalm_entry(1), james_entry(2)]
    first = assign(entries, candidates_for(entries, repeat_sermon()))
    assert assign(entries, candidates_for(entries, repeat_sermon())) == first
    # Neither the order of an entry's candidates nor of the detections changes the answer.
    candidates = candidates_for(entries, repeat_sermon())
    assert assign(entries, [list(reversed(options)) for options in candidates]) == first
    tokens = tokens_in(repeat_sermon())
    detections = list(reversed(detections_in(repeat_sermon())))
    again = [
        merge(text_candidates(e, tokens, CFG), mention_candidates(e, detections, CFG), CFG)
        for e in entries
    ]
    assert assign(entries, again) == first


def test_placements_are_strictly_increasing_in_file_order() -> None:
    entries = [james_entry(0), psalm_entry(1), james_entry(2), john_entry(3)]
    placed = assign(entries, candidates_for(entries, repeat_sermon()))
    times = [p.time_s for p in placed if p is not None]
    assert placed[3] is None and len(times) == 3
    assert all(a < b for a, b in itertools.pairwise(times))


def option(entry_index: int, time_s: float, score: float) -> Placement:
    return Placement(entry_index, score, time_s, mention=mention_at(time_s, score))


def blank(count: int) -> list[ExportEntry]:
    return [james_entry(i) for i in range(count)]


def test_ties_go_to_the_earlier_placement() -> None:
    # Either entry alone scores 0.8; the one that places earlier in the sermon wins.
    candidates = [[option(0, 10.0, 0.8)], [option(1, 5.0, 0.8)]]
    assert assign(blank(2), candidates) == [None, candidates[1][0]]
    # At the same time, the earlier entry wins.
    candidates = [[option(0, 10.0, 0.8)], [option(1, 10.0, 0.8)]]
    assert assign(blank(2), candidates) == [candidates[0][0], None]
    # Within one entry, equal totals go to the earlier time.
    candidates = [[option(0, 30.0, 0.8), option(0, 20.0, 0.8)]]
    assert assign(blank(1), candidates) == [candidates[0][1]]


def test_two_entries_cannot_share_a_time() -> None:
    candidates = [[option(0, 10.0, 0.5)], [option(1, 10.0, 0.7)]]
    assert assign(blank(2), candidates) == [None, candidates[1][0]]


def test_the_best_chain_beats_the_best_single_candidate() -> None:
    late, early, second = option(0, 50.0, 0.5), option(0, 10.0, 0.4), option(1, 20.0, 0.45)
    assert assign(blank(2), [[late, early], [second]]) == [early, second]


def test_an_entry_can_be_skipped_to_keep_a_longer_chain() -> None:
    # The middle entry's only candidate sits before the first's, so it can't follow it. Placing
    # it instead of the first scores less.
    a, b, c = option(0, 100.0, 0.6), option(1, 50.0, 0.5), option(2, 200.0, 0.6)
    assert assign(blank(3), [[a], [b], [c]]) == [a, None, c]


def test_a_candidate_scoring_zero_is_not_placed() -> None:
    assert assign(blank(1), [[option(0, 10.0, 0.0)]]) == [None]
    assert assign([], []) == []


def test_one_list_of_candidates_per_entry_is_required() -> None:
    with pytest.raises(ValueError):
        assign(blank(2), [[option(0, 10.0, 0.5)]])


def test_the_assignment_is_the_best_of_every_possible_one() -> None:
    rng = random.Random(51)
    for _ in range(200):
        count = rng.randint(1, 5)
        candidates = [
            [
                option(k, float(rng.randint(0, 12)), rng.randint(1, 10) / 10)
                for _ in range(rng.randint(0, 3))
            ]
            for k in range(count)
        ]
        best = 0.0
        for pick in itertools.product(*[[None, *options] for options in candidates]):
            chosen = [p for p in pick if p is not None]
            if all(a.time_s < b.time_s for a, b in itertools.pairwise(chosen)):
                best = max(best, sum(p.score for p in chosen))
        placed = [p for p in assign(blank(count), candidates) if p is not None]
        assert all(a.time_s < b.time_s for a, b in itertools.pairwise(placed))
        assert sum(p.score for p in placed) == pytest.approx(best)


# --- out-of-order pass (14 section 4.5) --------------------------------------------------------


def locate_in(
    entries: list[ExportEntry], words: list[Word], cfg: LocateConfig = CFG
) -> LocateResult:
    return locate(entries, candidates_for(entries, words, cfg), detections_in(words), cfg)


def kinds_of(result: LocateResult) -> list[tuple[int, str]]:
    return [(cue.entry_index, cue.kind) for cue in result.cues]


def cue_of(result: LocateResult, entry_index: int, kind: str) -> LocatedCue:
    (cue,) = [c for c in result.cues if c.entry_index == entry_index and c.kind == kind]
    return cue


def span_of(cue: LocatedCue) -> tuple[int, int]:
    assert cue.placement is not None and cue.placement.word_span is not None
    return cue.placement.word_span


def mention_ids(result: LocateResult) -> list[str]:
    return [
        c.placement.mention.detection.id
        for c in result.cues
        if c.placement is not None and c.placement.mention is not None
    ]


def test_an_unplaced_entry_with_a_strong_reading_elsewhere_moves() -> None:
    # File order is the psalm, then Romans, but Romans is read first. Both readings are perfect, so
    # the assignment keeps the earlier one and leaves the psalm unplaced.
    entries = [psalm_entry(0), romans_entry(1)]
    words = speak((100.0, ROMANS_8_28), (300.0, PSALM_91_15))
    candidates = candidates_for(entries, words)
    assert assign(entries, candidates)[0] is None
    result = locate_in(entries, words)
    assert kinds_of(result) == [(1, "assigned"), (0, "out_of_order")]
    moved = cue_of(result, 0, "out_of_order").placement
    assert moved is not None and moved.text is not None
    assert moved.text.coverage == 1.0
    assert moved.time_s == moved.text.read_start_s == 300.0


def test_a_partial_reading_above_the_threshold_moves_an_entry() -> None:
    # James is read in full at 50, John only in part (about 0.62) at 200; the assignment keeps the
    # better of the two, which is James, and the pass moves John to its reading.
    entries = [john_entry(0), james_entry(1)]
    partial = " ".join(JOHN_3_16.split()[:15])
    words = speak((50.0, JAMES_1_4), (200.0, partial))
    result = locate_in(entries, words)
    assert kinds_of(result) == [(1, "assigned"), (0, "out_of_order")]
    moved = cue_of(result, 0, "out_of_order").placement
    assert moved is not None and moved.text is not None
    assert CFG.align.read_coverage_threshold <= moved.text.coverage < 1.0


def test_a_weak_in_order_placement_gives_way_to_a_strong_reading_elsewhere() -> None:
    # Romans is read in part (0.44) at 100, before the psalm, and in full at 400, after it. The
    # assignment can only use the first, since the file puts Romans before the psalm.
    entries = [romans_entry(0), psalm_entry(1)]
    partial = " ".join(ROMANS_8_28.split()[:10])
    words = speak(
        (100.0, partial), (200.0, PSALM_91_15), (260.0, filler(120)), (400.0, ROMANS_8_28)
    )
    weak = assign(entries, candidates_for(entries, words))[0]
    assert weak is not None and weak.text is not None
    assert CFG.text_min_coverage <= weak.text.coverage < CFG.align.read_coverage_threshold
    assert weak.text.read_start_s == words[1].start  # "And" is a stop word

    result = locate_in(entries, words)
    assert kinds_of(result) == [(1, "assigned"), (0, "out_of_order")]
    moved = cue_of(result, 0, "out_of_order").placement
    assert moved is not None and moved.text is not None
    assert moved.text.coverage == 1.0
    assert moved.time_s == moved.text.read_start_s > 400.0


def test_a_mention_alone_never_moves_an_entry() -> None:
    # Romans is only named, at 400, while the psalm is read at 200: file order is Romans first, so
    # the assignment can't place both. The mention doesn't prove the slide was shown then.
    entries = [romans_entry(0), psalm_entry(1)]
    words = speak((200.0, PSALM_91_15), (400.0, "now Romans chapter 8 verse 28"))
    candidates = candidates_for(entries, words)
    assert [p.text is None for p in candidates[0]] == [True]
    result = locate_in(entries, words)
    assert kinds_of(result) == [(1, "assigned"), (0, "unplaced")]
    assert cue_of(result, 0, "unplaced").placement is None
    assert result.cues[-1].entry_index == 0  # unplaced cues come last


def test_a_weak_reading_never_moves_an_entry() -> None:
    entries = [romans_entry(0), psalm_entry(1)]
    partial = " ".join(ROMANS_8_28.split()[:10])
    words = speak((200.0, PSALM_91_15), (400.0, partial))
    result = locate_in(entries, words)
    assert kinds_of(result) == [(1, "assigned"), (0, "unplaced")]


def test_a_reading_used_by_another_entry_is_never_taken() -> None:
    # James 1:4 is shown twice with Psalm 91:15 between, and read once. The repeat has no reading
    # of its own, and the one there belongs to the first slide, so it keeps its later mention.
    entries = [james_entry(0), psalm_entry(1), james_entry(2)]
    words = repeat_sermon()
    candidates = candidates_for(entries, words)
    assert any(p.text is not None for p in candidates[2])
    result = locate_in(entries, words)
    assert kinds_of(result) == [(0, "assigned"), (1, "assigned"), (2, "assigned")]
    repeat = cue_of(result, 2, "assigned").placement
    assert repeat is not None and repeat.text is None and repeat.mention is not None
    assert repeat.time_s > 600.0
    first = cue_of(result, 0, "assigned").placement
    assert first is not None and first.text is not None and first.text.coverage == 1.0


def test_two_entries_that_share_a_reading_leave_it_to_the_first() -> None:
    # Two slides of the same scripture, one reading. The second can't be placed in order, and its
    # only reading is the first's.
    entries = [james_entry(0), james_entry(1)]
    words = speak((100.0, JAMES_1_4), (200.0, filler(20)))
    result = locate_in(entries, words)
    assert kinds_of(result) == [(0, "assigned"), (1, "unplaced")]


def text_placement(
    entry_index: int,
    coverage: float,
    start_s: float,
    span: tuple[int, int],
    mention: MentionCandidate | None = None,
) -> Placement:
    text = TextCandidate(entry_index, coverage, 10, start_s, start_s + 10.0, span, span[0])
    if mention is None:
        return Placement(entry_index, coverage, start_s, text=text)
    return Placement(
        entry_index, coverage + 0.25, mention.mention_start_s, text=text, mention=mention
    )


def test_of_two_placements_on_the_same_words_the_stronger_reading_keeps_them() -> None:
    # Entry 0 reads John 3:16-17 and entry 1 John 3:17, which lies inside it. assign only checks
    # times, so it places both; the higher coverage keeps the words.
    weaker = text_placement(0, 0.40, 100.0, (10, 50))
    stronger = text_placement(1, 0.90, 130.0, (30, 50))
    candidates = [[weaker], [stronger]]
    assert assign(blank(2), candidates) == [weaker, stronger]
    result = locate(blank(2), candidates, [], CFG)
    assert kinds_of(result) == [(1, "assigned"), (0, "unplaced")]
    # On equal coverage the lower entry index keeps them.
    a, b = text_placement(0, 0.80, 100.0, (10, 50)), text_placement(1, 0.80, 130.0, (30, 50))
    assert kinds_of(locate(blank(2), [[a], [b]], [], CFG)) == [(0, "assigned"), (1, "unplaced")]


def test_the_placement_that_loses_its_words_keeps_its_mention() -> None:
    mention = mention_at(95.0, score=0.4)
    merged = text_placement(0, 0.40, 100.0, (10, 50), mention)
    stronger = text_placement(1, 0.90, 130.0, (30, 50))
    result = locate(blank(2), [[merged], [stronger]], [DETECTION], CFG)
    assert kinds_of(result) == [(0, "assigned"), (1, "assigned")]
    assert result.cues[0].placement == Placement(0, 0.4, 95.0, mention=mention)  # still first
    assert result.consumed_detection_ids == (DETECTION.id,)


def test_a_moved_entry_leaves_out_a_mention_that_another_placement_holds() -> None:
    # Entry 1's strong reading was merged with a mention that entry 0 holds, and a mention joins
    # one cue only. Entry 0 scores more, so it keeps the mention and entry 1 moves without it.
    shared = mention_at(100.0, score=0.4)
    holder = Placement(0, 1.2, 100.0, mention=shared)
    reading = text_placement(1, 0.80, 130.0, (30, 50), shared)
    assert reading.time_s == holder.time_s
    result = locate(blank(2), [[holder], [reading]], [DETECTION], CFG)
    assert kinds_of(result) == [(0, "assigned"), (1, "out_of_order")]
    assert result.cues[0].placement is holder
    assert result.cues[1].placement == Placement(1, 0.80, 130.0, text=reading.text)
    assert result.consumed_detection_ids == (DETECTION.id,)


def test_an_entry_gives_up_a_mention_to_move() -> None:
    mention = mention_at(50.0, score=0.4)
    held = Placement(0, 0.4, 50.0, mention=mention)
    strong = text_placement(0, 0.90, 400.0, (30, 60))
    other = text_placement(1, 1.0, 200.0, (80, 100))
    result = locate(blank(2), [[held, strong], [other]], [DETECTION], CFG)
    assert kinds_of(result) == [(1, "assigned"), (0, "out_of_order")]
    assert result.cues[1].placement is strong
    assert result.consumed_detection_ids == ()  # the mention is free for the later passes


def test_the_best_reading_wins_and_ties_go_to_the_earliest() -> None:
    entries = blank(2)
    best = text_placement(0, 0.95, 300.0, (30, 60))
    twin, same, later = (
        text_placement(0, 0.90, 400.0, (120, 150)),
        text_placement(0, 0.90, 200.0, (80, 100)),
        text_placement(0, 0.70, 100.0, (110, 140)),
    )
    blocker = text_placement(1, 1.0, 50.0, (0, 5))
    result = locate(entries, [[later, twin, best, same], [blocker]], [], CFG)
    assert kinds_of(result) == [(1, "assigned"), (0, "out_of_order")]
    assert result.cues[1].placement is best
    # Without the best, the two of equal coverage tie and the earlier one is taken.
    result = locate(entries, [[later, twin, same], [blocker]], [], CFG)
    assert cue_of(result, 0, "out_of_order").placement is same
    # A reading another entry holds is skipped even when it is the best.
    taken = text_placement(1, 1.0, 50.0, (40, 70))
    result = locate(entries, [[later, twin, best, same], [taken]], [], CFG)
    assert cue_of(result, 0, "out_of_order").placement is same


def test_the_threshold_is_the_configured_read_coverage() -> None:
    entries = blank(2)
    reading = text_placement(0, 0.60, 300.0, (30, 60))
    pool = [[reading], [text_placement(1, 1.0, 100.0, (80, 100))]]
    assert kinds_of(locate(entries, pool, [], CFG)) == [(1, "assigned"), (0, "out_of_order")]
    strict = replace(CFG, align=replace(CFG.align, read_coverage_threshold=0.65))
    assert kinds_of(locate(entries, pool, [], strict)) == [(1, "assigned"), (0, "unplaced")]


def test_the_consumed_detections_are_those_the_cues_hold() -> None:
    entries = [james_entry(0), psalm_entry(1), james_entry(2)]
    words = repeat_sermon()
    detections = detections_in(words)
    result = locate_in(entries, words)
    # The detector also finds "Psalm 91" alone at 300.0, just before "Psalm 91 verse 15": a
    # chapter-only mention that no cue holds.
    assert [d.id for d in detections if "chapter_only" in d.flags] == ["det_002", "det_004"]
    assert result.consumed_detection_ids == ("det_001", "det_003", "det_004")
    assert sorted(mention_ids(result)) == sorted(result.consumed_detection_ids)
    # With no entries there is nothing to consume.
    assert locate([], [], detections, CFG) == LocateResult([], ())


def test_locate_needs_one_list_of_candidates_per_entry() -> None:
    with pytest.raises(ValueError):
        locate(blank(2), [[]], [], CFG)


# A random sermon: scriptures introduced, read in full or in part, named again, in any order.
SCRIPTURES = (
    ("John 3:16", JOHN_3_16, "John chapter 3 verse 16", "John chapter 3"),
    ("James 1:4", JAMES_1_4, "James chapter 1 verse 4", "James chapter 1"),
    ("Romans 8:28", ROMANS_8_28, "Romans chapter 8 verse 28", "Romans chapter 8"),
    ("Psalm 91:15", PSALM_91_15, "Psalm 91 verse 15", "Psalm 91"),
    ("Psalm 27:1", PSALM_27_1, "Psalm 27 verse 1", "Psalm 27"),
)


def random_case(rng: random.Random) -> tuple[list[ExportEntry], list[Word]]:
    entries = []
    for index in range(rng.randint(2, 6)):
        reference, text, _, _ = rng.choice(SCRIPTURES)
        entries.append(make_entry(index, reference, "KJV", text))
    parts: list[tuple[float, str]] = []
    now = 10.0
    for _ in range(rng.randint(2, 9)):
        _, text, spoken, chapter = rng.choice(SCRIPTURES)
        if rng.random() < 0.7:
            parts.append((now, rng.choice((spoken, chapter, "turn to " + spoken))))
            now += 8.0
        if rng.random() < 0.8:
            read = text.split()
            parts.append((now, " ".join(read[: rng.randint(max(3, len(read) // 2), len(read))])))
            now += 14.0
        if rng.random() < 0.4:
            parts.append((now, "so " + filler(rng.randint(3, 40))))
            now += 20.0
        now += rng.choice((5.0, 30.0, 90.0, 400.0))
    return entries, speak(*parts)


def test_random_sermons_keep_every_guarantee() -> None:
    rng = random.Random(514)
    for case in range(60):
        entries, words = random_case(rng)
        detections = detections_in(words)
        candidates = candidates_for(entries, words)
        result = locate(entries, candidates, detections, CFG)

        # Same input, same output; the order of the candidates and detections doesn't matter.
        assert locate(entries, candidates, detections, CFG) == result, case
        shuffled = [rng.sample(pool, len(pool)) for pool in candidates]
        again = locate(entries, shuffled, rng.sample(detections, len(detections)), CFG)
        assert again.cues == result.cues, case
        assert sorted(again.consumed_detection_ids) == sorted(result.consumed_detection_ids)

        placed = [c for c in result.cues if c.placement is not None]
        unplaced = len(result.cues) - len(placed)
        assert [c.kind == "unplaced" for c in result.cues] == [False] * len(placed) + [True] * (
            unplaced
        ), case
        times = [c.placement.time_s for c in placed if c.placement is not None]
        assert times == sorted(times), case
        # One in-order, out-of-order or unplaced cue per entry.
        entry_cues = [c for c in result.cues if c.kind in ("assigned", "out_of_order", "unplaced")]
        assert sorted(c.entry_index for c in entry_cues) == [e.index for e in entries], case
        # No two cues hold the same words, and no detection joins two cues.
        spans = [span_of(c) for c in placed if c.placement and c.placement.text]
        for a, b in itertools.combinations(spans, 2):
            assert not (a[0] <= b[1] and b[0] <= a[1]), case
        held = mention_ids(result)
        assert len(held) == len(set(held)), case
        assert set(held) <= set(result.consumed_detection_ids), case


# --- performance -------------------------------------------------------------------------------

LOCATE_BUDGET_S = 1.0  # the T-51.3 card: 30 entries against long-sermon-filler
KJV = LocalProvider()
# Thirty passages, the first of them read in the fixture. Several open with words the fixture
# says constantly ("for", "he", "my"), so many places in it start a run.
PERF_REFERENCES = (
    "John 3:16",
    "Genesis 1:1-3",
    "Psalm 23:1-3",
    "Romans 8:28-29",
    "James 1:2-4",
    "Matthew 5:3-6",
    "Isaiah 40:28-31",
    "Proverbs 3:5-6",
    "Philippians 4:6-8",
    "Ephesians 2:8-10",
    "Genesis 2:1-2",
    "Exodus 20:1-4",
    "Psalm 91:1-4",
    "Psalm 91:15-16",
    "1 Corinthians 13:4-7",
    "Hebrews 11:1-3",
    "Revelation 21:1-4",
    "Luke 2:8-11",
    "Mark 1:14-15",
    "Acts 2:1-4",
    "Romans 12:1-2",
    "Galatians 5:22-23",
    "Colossians 3:12-14",
    "1 John 4:7-10",
    "Psalm 1:1-3",
    "Psalm 46:1-3",
    "Isaiah 53:4-6",
    "Jeremiah 29:11-13",
    "Lamentations 3:22-24",
    "Matthew 6:9-13",
)


def kjv_entry(index: int, reference: str) -> ExportEntry:
    ref = parse_reference(reference, CANON)
    passage = KJV.fetch(ref, "kjv")
    lines = tuple(f"{verse.verse} {verse.text}" for verse in passage.verses)
    body = " ".join(lines)
    return ExportEntry(
        index=index,
        reference_line=f"{reference} (KJV)",
        reference=ref,
        translation="KJV",
        lines=lines,
        body=body,
        word_count=len(body.split()),
    )


@pytest.mark.perf
def test_thirty_entries_are_located_in_a_long_sermon_within_a_second() -> None:
    words = load_words(FIXTURES_DIR / "long-sermon-filler.words.json")
    tokens = transcript_tokens(words)
    detections = detect(words, CANON)
    entries = [kjv_entry(i, reference) for i, reference in enumerate(PERF_REFERENCES)]
    assert len(tokens) > 5000

    started = time.perf_counter()
    candidates = build_candidates(entries, tokens, detections, CFG)
    placed = assign(entries, candidates)
    elapsed = time.perf_counter() - started

    assert elapsed < LOCATE_BUDGET_S, f"locating 30 entries took {elapsed:.2f}s"
    assert len(placed) == 30
    john = placed[0]
    assert john is not None and john.text is not None and john.text.coverage == 1.0
    times = [p.time_s for p in placed if p is not None]
    assert all(a < b for a, b in itertools.pairwise(times))


@pytest.mark.perf
def test_assigning_thousands_of_candidates_takes_milliseconds() -> None:
    rng = random.Random(30)
    entries = blank(30)
    candidates = [
        [option(k, rng.uniform(0.0, 3000.0), rng.uniform(0.1, 1.25)) for _ in range(100)]
        for k in range(30)
    ]
    started = time.perf_counter()
    placed = assign(entries, candidates)
    elapsed = time.perf_counter() - started
    assert elapsed < LOCATE_BUDGET_S, f"assigning 3000 candidates took {elapsed:.2f}s"
    times = [p.time_s for p in placed if p is not None]
    assert len(times) > 5
    assert all(a < b for a, b in itertools.pairwise(times))
