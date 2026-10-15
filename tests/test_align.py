from versesync.timing.align import (
    AlignConfig,
    Alignment,
    AToken,
    align,
    align_from,
    normalise_verse,
    tokens_equal,
    transcript_tokens,
    window_bounds,
)
from versesync.types import Word

CFG = AlignConfig()


def _w(text: str, i: int) -> Word:
    return Word(text, float(i), i + 0.5, 0.9)


def test_normalise_verse_lowercase_punct_digits_stop_words():
    out = normalise_verse(["16 For God so loved the world,", "17 that He gave his only Son."])
    assert out == ["for", "god", "so", "loved", "world", "he", "gave", "his", "only", "son"]


def test_stop_list_applied_to_both_sides():
    verse = normalise_verse(["In the beginning God created the heaven and the earth"])
    spoken = "In the beginning, God created the heaven and the earth".split()
    words = [_w(t, i) for i, t in enumerate(spoken)]
    trans = [t.text for t in transcript_tokens(words)]
    assert verse == trans == ["beginning", "god", "created", "heaven", "earth"]
    assert not {"the", "and", "in"} & set(verse + trans)


def test_transcript_tokens_keep_word_index_and_times():
    words = [_w("So", 0), _w("the", 1), _w("Lord's", 2), _w("12", 3), _w("said.", 4)]
    assert transcript_tokens(words) == [
        AToken("so", 0, 0.0, 0.5),
        AToken("lords", 2, 2.0, 2.5),
        AToken("said", 4, 4.0, 4.5),
    ]


def test_window_bounds_values():
    assert window_bounds(100, 10, 1000, CFG) == (100 - 26, 100 + 48 + 1)


def test_window_clamped_both_ends():
    lo, hi = window_bounds(3, 10, 40, CFG)
    assert lo == 0
    assert hi == 40
    lo, hi = window_bounds(500, 10, 40, CFG)
    assert lo <= hi <= 40


def test_tokens_equal_exact_and_fuzzy():
    assert tokens_equal("god", "god", CFG)
    assert tokens_equal("loved", "lovad", CFG)
    assert not tokens_equal("loved", "lovad2x", CFG)
    assert not tokens_equal("sons", "song", CFG)  # short: exact only
    assert not tokens_equal("loved", "love", CFG)  # one side too short


JOHN_3_16 = [
    "16 For God so loved the world, that he gave his only begotten Son, "
    "that whosoever believeth in him should not perish, but have everlasting life."
]


def _words(text: str, start: int = 0) -> list[Word]:
    return [_w(t, start + i) for i, t in enumerate(text.split())]


def test_align_from_counts_in_order_matches():
    verse = ["god", "loved", "world"]
    window = transcript_tokens(_words("god um loved the world"))
    run = align_from(verse, window, 0)
    assert (run.matched, run.first_match, run.last_match) == (3, 0, 3)


def test_align_from_skip_budget_advances_verse_pointer():
    verse = ["alpha", "bravo", "charlie"]
    filler = " ".join(["zzz"] * 7)
    window = transcript_tokens(_words(f"alpha {filler} charlie"))
    run = align_from(verse, window, 0)
    # 7 misses exceed max_skip=6, so "bravo" is abandoned and "charlie" still matches.
    assert run.matched == 2
    assert run.last_match == 8
    tight = AlignConfig(max_skip=10)
    assert align_from(verse, window, 0, tight).matched == 1


def test_verbatim_reading_is_read_with_high_coverage():
    spoken = "turn with me to john chapter three sixteen " + JOHN_3_16[0].split(" ", 1)[1] + " amen"
    words = _words(spoken)
    result = align(JOHN_3_16, words, mention_word_index=7)
    assert result.classification == "read"
    assert result.coverage >= 0.9
    assert result.read_start_s == words[8].start  # "For", right after the mention
    assert result.read_end_s == words[-2].end  # "life." (before "amen")
    assert result.read_word_span == (8, len(words) - 2)


def test_reading_with_interjection_is_still_read():
    spoken = (
        "john three sixteen for god so loved and church hear this the world "
        "that he gave his only begotten son that whosoever believeth in him "
        "should not perish but have everlasting life"
    )
    result = align(JOHN_3_16, _words(spoken), mention_word_index=0)
    assert result.classification == "read"
    assert result.coverage >= 0.9


def test_paraphrase_has_low_coverage_and_no_read_span():
    spoken = (
        "john three sixteen basically tells us that because of how much he cares "
        "about everyone the Father sent Jesus so that anyone who trusts him can "
        "live forever instead of being lost"
    )
    result = align(JOHN_3_16, _words(spoken), mention_word_index=0)
    assert result.classification == "paraphrase"
    assert 0.0 <= result.coverage <= 0.35
    assert result.read_start_s is None
    assert result.read_end_s is None
    assert result.read_word_span is None


def test_reading_before_reference_is_named_starts_before_mention():
    reading = JOHN_3_16[0].split(" ", 1)[1]
    spoken = f"{reading} that is john three sixteen friends"
    words = _words(spoken)
    mention = spoken.split().index("john")
    result = align(JOHN_3_16, words, mention_word_index=mention)
    assert result.classification == "read"
    assert result.read_start_s is not None
    assert result.read_start_s < words[mention].start


def test_empty_verse_text_is_paraphrase_with_zero_coverage():
    words = _words("and then john three sixteen was read")
    expected = Alignment("paraphrase", 0.0, None, None, None)
    assert align([], words, 2) == expected
    assert align(["", "12"], words, 2) == expected


def test_empty_transcript_is_paraphrase():
    assert align(JOHN_3_16, [], 0) == Alignment("paraphrase", 0.0, None, None, None)


def test_no_candidate_start_reports_zero_coverage():
    result = align(JOHN_3_16, _words("nothing relevant is said here at all"), 0)
    assert result == Alignment("paraphrase", 0.0, None, None, None)


def test_multi_start_beats_misleading_early_match():
    verse = ["grace", "mercy", "peace", "love", "joy", "hope", "faith"]
    filler = "one two three four five six seven eight nine ten"
    spoken = f"grace {filler} grace mercy peace love joy hope faith"
    result = align(verse, _words(spoken), mention_word_index=0)
    assert result.classification == "read"
    assert result.coverage == 1.0
    assert result.read_word_span == (11, 17)


def test_ties_break_on_earliest_start():
    verse = ["grace", "mercy", "peace"]
    spoken = "grace mercy peace and grace mercy peace"
    result = align(verse, _words(spoken), mention_word_index=0)
    assert result.read_word_span == (0, 2)


def test_fuzzy_match_tolerates_transcription_errors():
    verse = ["beginning", "created", "heaven", "earth"]
    spoken = "in the beginning god created the heavan and the earth"
    result = align(verse, _words(spoken), mention_word_index=0)
    assert result.coverage == 1.0
