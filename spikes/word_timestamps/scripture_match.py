#!/usr/bin/env python3
"""
scripture_match.py — T-02 support: match a ground-truth scripture-mention
label against a faster-whisper word list.

Why this is non-trivial (confirmed from a real smoke test on this sermon):
a label's hand-confirmed timestamp is the ANCHOR per docs/05-timing-and-
placement.md §3 — min(mention_start, read_start) — and in real sermon audio
the preacher often ANNOUNCES the reference ("Micah 7:8") verbally before
reading a paraphrased/shortened version of the verse body, not the verbatim
"Title Main" quote text. So matching on the quote body text alone misses the
actual anchor point. This module tries BOTH:
  (a) the spoken reference (book name + chapter/verse numbers, digit or
      spelled-out), and
  (b) the quote body's opening words,
within a time window around the label, and uses whichever occurs earlier —
same "earlier of mention/read" logic as the anchor definition itself.

This is a deliberately simple heuristic, not the production reference-
detection grammar in docs/04-reference-detection.md (which handles far more
phrasing variation). It is good enough to score "does Whisper's word
timestamp land near the true anchor" for T-02, not to build the real
detector — flagged in RESULTS.md.
"""

import re

_NUM_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
    "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}


def normalize_token(s):
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def tokenize_words(words, t_lo, t_hi):
    """words: list of {word,start,end,...}. Returns [(norm_token, start, end), ...]
    for tokens whose start falls within [t_lo, t_hi), splitting on internal
    punctuation-only boundaries (faster-whisper's word strings are already
    mostly single-word with a leading space)."""
    out = []
    for w in words:
        if w["start"] < t_lo or w["start"] >= t_hi:
            continue
        norm = normalize_token(w["word"])
        if norm:
            out.append((norm, w["start"], w["end"]))
    return out


def spoken_number_value(tok):
    """int or None — tok is a normalized token (digits or a number word)."""
    if tok.isdigit():
        return int(tok)
    return _NUM_WORDS.get(tok)


def parse_reference(reference):
    """'Micah 7:8 (NKJV)' -> {'book_tokens': ['micah'], 'numbers': [7, 8]}
    '2 Corinthians 4:6-9 (NKJV)' -> {'book_tokens': ['corinthians'], 'numbers': [4,6,9]}
    Strips translation abbreviation in parens and leading book-number
    (1/2/3 Corinthians etc.) since that's spoken as "First/Second" as often
    as the digit, and the book name itself is distinctive enough.
    """
    ref = re.sub(r"\([^)]*\)", "", reference)  # drop "(NKJV)" etc.
    numbers = [int(n) for n in re.findall(r"\d+", ref)]
    # Separate the leading book-number (1/2/3) from chapter:verse numbers.
    # e.g. "2 Corinthians 4:6-9" -> numbers=[2,4,6,9]; the book-number (2) is
    # the first one IFF the ref starts with a digit.
    starts_with_book_number = bool(re.match(r"^\s*\d", ref))
    if starts_with_book_number and numbers:
        numbers = numbers[1:]
    words = re.findall(r"[A-Za-z]+", ref)
    book_tokens = [normalize_token(w) for w in words if w]
    return {"book_tokens": book_tokens, "numbers": numbers}


def find_reference_match(tokens, parsed_ref, max_gap_tokens=8):
    """tokens: [(norm, start, end), ...] in time order.
    Looks for a book-name token hit, then checks that at least one of the
    reference's numbers appears (digit or spelled-out) within the next
    max_gap_tokens tokens. Returns (start_time, matched_snippet) or None.
    Picks the EARLIEST such hit in the token list.
    """
    book_tokens = set(parsed_ref["book_tokens"])
    if not book_tokens:
        return None
    needed_numbers = set(parsed_ref["numbers"])

    for i, (tok, start, end) in enumerate(tokens):
        if tok not in book_tokens:
            continue
        window = tokens[i:i + 1 + max_gap_tokens]
        found_numbers = set()
        for wtok, _, _ in window:
            v = spoken_number_value(wtok)
            if v is not None:
                found_numbers.add(v)
        if needed_numbers & found_numbers:
            snippet = " ".join(t[0] for t in window)
            return (start, snippet)
    return None


def _clause_candidates(body_text, n_words=6, min_words=4):
    """A read-aloud mention often paraphrases or skips ahead — confirmed on
    this sermon: the preacher jumped straight to a later clause of the
    verse, never saying the opening words at all. So rather than anchoring
    only on the body text's opening n_words, generate a SLIDING n-gram of
    length n_words over the whole normalized body text, so wherever the
    actually-read portion starts, some n-gram covers it.

    min_words enforces a length floor (default 4) — a candidate shorter
    than this (e.g. the verse's last clause being a single word) is prone
    to matching an unrelated word elsewhere that merely happens to share
    that one token; confirmed empirically ('darkness' alone matched a wrong,
    much earlier 'darkness' in the transcript before this floor was added).
    """
    whole = [normalize_token(w) for w in re.findall(r"[A-Za-z0-9']+", body_text)]
    whole = [t for t in whole if t]
    if len(whole) <= n_words:
        return [whole] if len(whole) >= min_words else []

    candidates = []
    for i in range(0, len(whole) - n_words + 1):
        candidates.append(whole[i:i + n_words])
    return candidates


def find_body_match(tokens, body_text, n_words=6, min_ratio=0.7):
    """Sliding-window fuzzy match of each clause candidate (see
    _clause_candidates) against every matching-length window of tokens.
    Returns (start_time, score, matched_snippet) for whichever candidate's
    best-scoring window — above min_ratio — starts EARLIEST in time, or
    None if nothing clears the threshold.
    """
    import difflib

    best = None
    for expected in _clause_candidates(body_text, n_words=n_words):
        if not expected:
            continue
        candidate_best = None
        for i in range(0, max(0, len(tokens) - len(expected) + 1)):
            window = tokens[i:i + len(expected)]
            if len(window) < len(expected):
                break
            window_toks = [t[0] for t in window]
            ratio = difflib.SequenceMatcher(None, expected, window_toks).ratio()
            if ratio >= min_ratio and (candidate_best is None or ratio > candidate_best[1]):
                candidate_best = (window[0][1], ratio, " ".join(window_toks))
        if candidate_best and (best is None or candidate_best[0] < best[0]):
            best = candidate_best

    return best


def match_label(words, label_start_s, reference, body_text, window_s=10.0,
                 ref_gap_tokens=8, body_n_words=6, body_min_ratio=0.7):
    """
    Top-level entry point. Returns a dict:
      { matched: bool, matched_via: 'reference'|'body'|None,
        matched_start: float|None, error_s: float|None,
        snippet: str|None, score: float|None, reason: str|None }
    """
    t_lo = label_start_s - window_s
    t_hi = label_start_s + window_s
    tokens = tokenize_words(words, t_lo, t_hi)
    if not tokens:
        return {"matched": False, "matched_via": None, "matched_start": None,
                "error_s": None, "snippet": None, "score": None,
                "reason": f"no transcript words in window [{t_lo:.1f},{t_hi:.1f}]"}

    parsed_ref = parse_reference(reference)
    ref_hit = find_reference_match(tokens, parsed_ref, max_gap_tokens=ref_gap_tokens)
    body_hit = find_body_match(tokens, body_text, n_words=body_n_words,
                                min_ratio=body_min_ratio) if body_text else None

    candidates = []
    if ref_hit:
        candidates.append(("reference", ref_hit[0], None, ref_hit[1]))
    if body_hit:
        candidates.append(("body", body_hit[0], body_hit[1], body_hit[2]))

    if not candidates:
        return {"matched": False, "matched_via": None, "matched_start": None,
                "error_s": None, "snippet": None, "score": None,
                "reason": "neither reference nor body text found in window"}

    # Earlier of mention/read, per docs/05 §3's own anchor definition.
    candidates.sort(key=lambda c: c[1])
    via, start, score, snippet = candidates[0]

    return {
        "matched": True,
        "matched_via": via,
        "matched_start": start,
        "error_s": start - label_start_s,
        "snippet": snippet,
        "score": score,
        "reason": None,
    }
