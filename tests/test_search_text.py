"""Tests for the search string, offset map and span round-trip (04 section 3)."""

from __future__ import annotations

import random
import re

import pytest

from versesync.detect.canon import load_canon
from versesync.detect.normalize import (
    build_search_text,
    normalize,
    seconds,
    word_span,
)
from versesync.detect.types import Token
from versesync.types import Word

ALPHABET = "abcdefghij0123456789,:-"


def random_tokens(rng: random.Random) -> list[Token]:
    tokens = []
    for i in range(rng.randint(1, 12)):
        text = "".join(rng.choice(ALPHABET) for _ in range(rng.randint(1, 8)))
        tokens.append(Token(text, "word", None, (i,), float(i), i + 0.5, 1.0))
    return tokens


def brute_force(tokens: list[Token], offset: int) -> int:
    pos = 0
    for i, token in enumerate(tokens):
        if pos <= offset < pos + len(token.text) + 1:  # the token plus its trailing space
            return i
        pos += len(token.text) + 1
    raise AssertionError("offset outside text")


def test_offset_map_matches_brute_force():
    rng = random.Random(1234)
    for _ in range(200):
        tokens = random_tokens(rng)
        st = build_search_text(tokens)
        assert st.text == " ".join(t.text for t in tokens)
        for offset in range(len(st.text)):
            assert st.token_at(offset) == brute_force(tokens, offset)


def test_out_of_range_offsets_raise():
    st = build_search_text(random_tokens(random.Random(1)))
    with pytest.raises(IndexError):
        st.token_at(-1)
    with pytest.raises(IndexError):
        st.token_at(len(st.text))
    with pytest.raises(ValueError):
        st.token_span(2, 2)


def test_regex_match_round_trips_to_source_seconds():
    words = [
        Word(text=t, start=10.0 + i, end=10.5 + i, probability=0.9)
        for i, t in enumerate(
            "Turn with me to First Corinthians six, nineteen and twenty today".split()
        )
    ]
    tokens = normalize(words, load_canon())
    st = build_search_text(tokens)
    match = re.search(r"corinthians 6 , 19 and 20", st.text)
    assert match is not None
    first, last = st.token_span(*match.span())
    assert [t.text for t in tokens[first : last + 1]] == [
        "corinthians",
        "6",
        ",",
        "19",
        "and",
        "20",
    ]
    # "Corinthians" is word 5, "twenty" is word 9.
    assert word_span(tokens, first, last) == (5, 9)
    assert seconds(tokens, first, last) == (15.0, 19.5)


def test_multi_word_token_spans_all_its_words():
    words = [
        Word(text=t, start=float(i), end=i + 0.5, probability=1.0)
        for i, t in enumerate("see twenty eight now".split())
    ]
    tokens = normalize(words, load_canon())
    st = build_search_text(tokens)
    match = re.search(r"28", st.text)
    assert match is not None
    first, last = st.token_span(*match.span())
    assert word_span(tokens, first, last) == (1, 2)
    assert seconds(tokens, first, last) == (1.0, 2.5)
