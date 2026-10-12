import random
import re
from dataclasses import dataclass

import pytest
from transcript_fixtures import FIXTURE_NAMES, load_words

from versesync.detect.normalize import Normalized, Token, normalize_words


@dataclass
class W:
    text: str
    start: float = 0.0
    end: float = 0.0
    probability: float = 1.0


def words(text: str) -> list[W]:
    """Words with distinct, increasing timings: word i spans [i, i + 0.5]."""
    return [W(t, float(i), i + 0.5, 0.9) for i, t in enumerate(text.split())]


def norm(text: str) -> Normalized:
    return normalize_words(words(text))


def search(text: str) -> str:
    return norm(text).search


# --- spoken numbers -------------------------------------------------------------------------

_UNIT_WORDS = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen"
).split()
_TENS_WORDS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def spoken(n: int) -> str:
    if n < 20:
        return _UNIT_WORDS[n]
    if n < 100:
        tens, unit = divmod(n, 10)
        return _TENS_WORDS[tens] + (f" {_UNIT_WORDS[unit]}" if unit else "")
    hundreds, rest = divmod(n, 100)
    out = f"{_UNIT_WORDS[hundreds]} hundred"
    return out + (f" and {spoken(rest)}" if rest else "")


@pytest.mark.parametrize("n", range(1, 177))
def test_every_number_to_176_spoken_and_digit(n: int) -> None:
    for form in (spoken(n), spoken(n).replace(" and ", " "), spoken(n).replace(" ", "-")):
        # a leading "john" keeps 1-3 from being read as anything but a plain number
        result = norm(f"romans {form}")
        assert [t.text for t in result.tokens] == ["romans", str(n)], form
        assert result.tokens[1].kind == "number" and result.tokens[1].value == n
    digit = norm(f"romans {n}")
    assert [(t.text, t.kind, t.value) for t in digit.tokens[1:]] == [(str(n), "number", n)]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("one hundred and nineteen", "119"),
        ("one hundred nineteen", "119"),
        ("a hundred and ten", "110"),
        ("twenty eight", "28"),
        ("twenty-eight", "28"),
        ("forty two", "42"),
        ("one hundred", "100"),
        ("one hundred and seventy six", "176"),
        ("one hundred and fifty", "150"),
    ],
)
def test_spec_table_numbers(text: str, expected: str) -> None:
    result = norm(text)
    assert result.search == expected
    assert result.tokens[0].kind == "number"


def test_numbers_that_do_not_combine_stay_separate() -> None:
    assert search("psalm one nineteen") == "psalm 1 19"
    assert search("john twenty one") == "john 21"
    assert search("nineteen twenty") == "19 20"
    assert search("six nineteen and twenty") == "6 19 and 20"
    assert search("one hundred and") == "100 and"


def test_hundred_alone_is_a_word() -> None:
    assert norm("hundred").tokens[0].kind == "word"


def test_hyphenated_numerals_are_one_token_with_one_word() -> None:
    result = norm("verse twenty-eight")
    assert result.search == "verse 28"
    assert result.tokens[1].word_ids == [1]


def test_hyphen_between_non_combining_numbers_is_a_range() -> None:
    assert search("verses nineteen-twenty") == "verses 19 - 20"


def test_hyphen_inside_ordinary_word_is_dropped() -> None:
    assert search("a well-known verse") == "a well known verse"


# --- ordinals -------------------------------------------------------------------------------


@pytest.mark.parametrize("form", ["first", "First", "1st", "1", "one", "I"])
def test_ordinal_prefix_forms_before_numbered_book(form: str) -> None:
    result = norm(f"{form} Corinthians six")
    assert [t.text for t in result.tokens] == ["1", "corinthians", "6"]
    assert result.tokens[0].kind == "ordinal" and result.tokens[0].value == 1


@pytest.mark.parametrize(
    ("form", "value"),
    [("second", 2), ("2nd", 2), ("two", 2), ("2", 2), ("II", 2), ("third", 3), ("three", 3),
     ("III", 3)],
)  # fmt: skip
def test_other_ordinals(form: str, value: int) -> None:
    book = "John" if value == 3 else "Timothy"
    result = norm(f"{form} {book} one")
    assert (result.tokens[0].text, result.tokens[0].kind) == (str(value), "ordinal")
    assert result.tokens[0].value == value


@pytest.mark.parametrize("book", ["Samuel", "Kings", "Chronicles", "Corinthians",
                                  "Thessalonians", "Timothy", "Peter", "John"])  # fmt: skip
def test_every_numbered_book_family_takes_ordinal(book: str) -> None:
    assert norm(f"one {book}").tokens[0].kind == "ordinal"


def test_unit_number_before_unnumbered_book_is_a_number() -> None:
    result = norm("one romans")
    assert result.tokens[0].kind == "number"


def test_number_not_before_a_book_stays_a_number() -> None:
    assert [t.kind for t in norm("john three sixteen").tokens] == ["word", "number", "number"]
    assert [t.kind for t in norm("I think so").tokens] == ["word", "word", "word"]


def test_i_pronoun_before_john_only_when_capitalised_numeral() -> None:
    assert norm("I John").tokens[0].kind == "ordinal"
    assert norm("i john").tokens[0].kind == "word"


def test_ordinal_before_chapter_word() -> None:
    result = norm("the third chapter of john")
    assert result.search == "the 3 chapter of john"
    assert result.tokens[1].kind == "ordinal"


def test_compound_number_is_never_an_ordinal() -> None:
    assert norm("twenty one corinthians").tokens[0].kind == "number"


# --- punctuation and digits -----------------------------------------------------------------


def test_spoken_reference_from_task() -> None:
    result = norm("Turn with me to First Corinthians six, nineteen and twenty")
    assert result.search == "turn with me to 1 corinthians 6 , 19 and 20"


def test_colon_and_range_stay_structural() -> None:
    result = norm("1 Corinthians 6:19-20.")
    assert result.search == "1 corinthians 6 : 19 - 20"
    assert [t.kind for t in result.tokens] == [
        "ordinal", "word", "number", "punct", "number", "punct", "number",
    ]  # fmt: skip
    assert all(t.word_ids == [2] for t in result.tokens[2:])


def test_standalone_structural_tokens() -> None:
    assert search("john 3 : 16 - 18") == "john 3 : 16 - 18"
    assert search("john 3 – 4") == "john 3 - 4"


def test_other_punctuation_is_stripped_and_case_folded() -> None:
    assert search('"Behold!" said the Lord; (amen)') == "behold said the lord amen"
    assert search("Titus’s") == "titus's"


def test_digits_and_spoken_forms_normalise_identically() -> None:
    for spoken_form, digit_form in [
        ("John three sixteen", "John 3 16"),
        ("First Corinthians six nineteen", "1 Corinthians 6 19"),
        ("Psalm one hundred and nineteen", "Psalm 119"),
        ("Romans eight twenty eight", "Romans 8 28"),
        ("second Timothy two fifteen", "2nd Timothy 2 15"),
    ]:
        a, b = norm(spoken_form), norm(digit_form)
        assert a.search == b.search
        assert [(t.kind, t.value) for t in a.tokens] == [(t.kind, t.value) for t in b.tokens]


def test_empty_and_punctuation_only_words() -> None:
    assert norm("").tokens == []
    assert norm("... ?!").tokens == []
    assert norm("").search == ""


# --- timestamps and back-references ---------------------------------------------------------


def test_token_fields_come_from_first_and_last_word_and_min_prob() -> None:
    ws = [W("twenty", 1.0, 1.4, 0.9), W("eight", 1.5, 2.0, 0.6)]
    (tok,) = normalize_words(ws).tokens
    assert tok == Token("28", "number", 28, [0, 1], 1.0, 2.0, 0.6)


def test_one_word_many_tokens_and_many_words_one_token() -> None:
    ws = [W("Corinthians", 0, 1, 0.9), W("6:19-20", 1, 2, 0.5), W("one", 2, 3, 0.8),
          W("hundred", 3, 4, 0.7), W("and", 4, 5, 0.95), W("nineteen", 5, 6, 0.99)]  # fmt: skip
    result = normalize_words(ws)
    assert [t.text for t in result.tokens] == ["corinthians", "6", ":", "19", "-", "20", "119"]
    assert [t.word_ids for t in result.tokens] == [[0], [1], [1], [1], [1], [1], [2, 3, 4, 5]]
    assert result.tokens[-1].prob == 0.7
    assert (result.tokens[-1].start, result.tokens[-1].end) == (2, 6)


def test_round_trip_regex_match_to_seconds() -> None:
    text = "so please turn with me to First Corinthians six nineteen and twenty tonight"
    ws = words(text)
    result = normalize_words(ws)
    m = re.search(r"\b1 corinthians 6 19 and 20\b", result.search)
    assert m is not None
    first, last = result.token_span(m.start(), m.end())
    assert result.tokens[first].text == "1" and result.tokens[last].text == "20"
    w0, w1 = result.word_span(first, last)
    assert (ws[w0].text, ws[w1].text) == ("First", "twenty")
    # "First" is word 6 and "twenty" word 11 in the source
    assert result.seconds(first, last) == (ws[6].start, ws[11].end) == (6.0, 11.5)
    assert result.min_prob(first, last) == 0.9


def test_round_trip_through_compound_number() -> None:
    ws = words("see psalm one hundred and nineteen verse twenty eight")
    result = normalize_words(ws)
    m = re.search(r"119 verse 28", result.search)
    assert m is not None
    first, last = result.token_span(m.start(), m.end())
    assert result.word_span(first, last) == (2, 8)
    assert result.seconds(first, last) == (2.0, 8.5)


def test_token_span_ignores_separator_spaces_and_rejects_empty() -> None:
    result = norm("john 3 16")
    assert result.token_span(5, 6) == (1, 1)
    assert result.token_span(4, 6) == (1, 1)
    with pytest.raises(ValueError):
        result.token_span(4, 5)
    with pytest.raises(ValueError):
        result.token_span(0, 0)


# --- offset map -----------------------------------------------------------------------------

_VOCAB = [
    "turn", "to", "john", "first", "one", "two", "twenty", "eight", "hundred", "and", "nineteen",
    "corinthians", "6:19-20", "3", "119", "verse", "chapter", ":", "-", ",", "Psalm", "twenty-one",
    "the", "III", "timothy", "of",
]  # fmt: skip


def test_offset_map_fuzz() -> None:
    rng = random.Random(1234)
    for _ in range(400):
        text = " ".join(rng.choice(_VOCAB) for _ in range(rng.randint(0, 25)))
        result = norm(text)
        s = result.search
        assert s == " ".join(t.text for t in result.tokens)
        assert len(result.char_to_token) == len(s)
        for i, tok in enumerate(result.tokens):
            start = result.token_starts[i]
            assert s[start : start + len(tok.text)] == tok.text
            for off in range(start, start + len(tok.text)):
                assert result.char_to_token[off] == i
        for off, ch in enumerate(s):
            owner = result.char_to_token[off]
            if ch == " ":
                assert owner == -1
            else:
                tok = result.tokens[owner]
                begin = result.token_starts[owner]
                assert begin <= off < begin + len(tok.text)
        # every token-aligned regex match round-trips to the same token texts
        for m in re.finditer(r"\S+", s):
            first, last = result.token_span(m.start(), m.end())
            assert " ".join(t.text for t in result.tokens[first : last + 1]) == m.group(0)


# --- fixture corpus -------------------------------------------------------------------------


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_transcripts_keep_valid_back_references(name: str) -> None:
    ws = [W(d["text"], d["start"], d["end"], d["probability"]) for d in load_words(name)]
    result = normalize_words(ws)
    assert result.tokens
    for tok in result.tokens:
        assert tok.word_ids == sorted(set(tok.word_ids)) and tok.word_ids
        assert tok.start == ws[tok.word_ids[0]].start
        assert tok.end == ws[tok.word_ids[-1]].end
        assert tok.prob == min(ws[i].probability for i in tok.word_ids)
        assert tok.start <= tok.end


def test_numbers_fixture_first_corinthians() -> None:
    ws = [W(d["text"], d["start"], d["end"], d["probability"]) for d in load_words(
        "numbers-and-ordinals")]  # fmt: skip
    result = normalize_words(ws)
    m = re.search(r"1 corinthians 6 , 19 and 20", result.search)
    assert m is not None
    first, last = result.token_span(m.start(), m.end())
    start, end = result.seconds(first, last)
    assert start == 11.6 and end <= 14.4
