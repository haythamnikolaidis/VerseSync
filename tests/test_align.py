from versesync.timing.align import (
    AlignConfig,
    AToken,
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
