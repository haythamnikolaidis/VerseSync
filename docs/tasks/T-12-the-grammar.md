# T-12 · The grammar

| | |
|---|---|
| **Workstream** | C — Detection |
| **Unblocks** | T-13, T-17, T-48 |
| **Spec** | [04-reference-detection.md §4](../04-reference-detection.md) |

## Goal

Match patterns **P1–P12** over the normalised tokens, and emit `Candidate` references with
their token spans, word spans and source seconds.

## Context

Patterns are tried **in priority order**. The first match wins and **consumes its span**, so a
looser pattern later in the list can't re-match the same words. That ordering is why
`1 corinthians 6 : 19 - 20` gives one range (P1), not a bare chapter (P9) plus noise.

**The C→E seam is fixed by this card.** `Candidate` below is the output shape that the timing
stream (T-17) consumes. The old plan had a mid-wave meeting to agree it. Writing it down here
replaces that meeting. Changing it later means changing this card first.

### The technique: book pre-pass, then regexes over a "grammar view"

1. **Book pre-pass.** Walk the tokens from left to right. At each index, call
   `match_book(tokens, i, canon, fuzzy_gate=gate)`, where `gate(j)` is the number-follows
   predicate described in [T-11](T-11-book-matching.md). Record the matches; they don't
   overlap, and the scan skips past each one.
2. **Grammar view.** Build a list of view tokens. Each book match becomes **one** view token
   with text `§b<k>`, where `k` is the match's index. Every other token keeps its text. Numbers
   are already digits. Keep a `view_index → (first_token, last_token)` map.
3. **Patterns** are compiled regexes over `build_search_text(view)` (T-10.3), with named groups.
   For example, P1 is
   `§b(?P<b>\d+) (?P<c>\d+) : (?P<v>\d+) - (?P<ve>\d+)`.
   A match's character span → view span → token span → word span and seconds.
4. **Consumption.** Patterns are tried in priority order. When a pattern matches, the view
   tokens it covered are marked consumed. A later pattern's match is rejected if it overlaps
   any consumed view token. Use `regex.finditer` and filter; don't do in-place rewriting.

```python
# detect/grammar.py
@dataclass(frozen=True)
class GrammarConfig:
    context_window_s: float = 120.0
    context_window_tokens: int = 400

@dataclass(frozen=True)
class Candidate:
    book: Book
    chapter: int
    verse: int | None
    verse_end: int | None
    pattern: str                    # "P1".."P12"
    contextual: bool                # True only for P11/P12
    book_match: BookMatch           # for P11/P12: the match of the reference carried from
    token_span: tuple[int, int]     # inclusive, into normalize() tokens
    word_span: tuple[int, int]      # inclusive, into the Word array
    source_start: float             # start of the FIRST token of the match (04 §7)
    source_end: float
    asr_prob: float                 # mean Token.prob over token_span
    alternatives: tuple["Candidate", ...] = ()
    alternative_reason: str | None = None

def find_candidates(tokens: Sequence[Token], canon: Canon,
                    cfg: GrammarConfig = GrammarConfig()) -> list[Candidate]   # sorted by source_start
```

The grammar does **no** canon validation, except for the Psalms rule in T-12.4. That's T-13's
job.

## Subtasks

### T-12.1 · Pre-pass, grammar view, framework and P1/P2/P9

**Executor** agent · **Size** S · **Prereqs** T-11.3 · **Status** done

- **Read:** [04 §4](../04-reference-detection.md) (the table, P1, P2 and P9 rows)
- **Touches:** `sidecar/versesync/detect/grammar.py` (new) · `tests/test_grammar.py` (new)
- **Steps:**
  1. Write `GrammarConfig`, `Candidate`, the pre-pass, the view and its span maps. Commit.
  2. Write the pattern registry (an ordered list of `(name, compiled_regex, builder)`), span
     consumption, and P1, P2 and P9. Test each one with the example tabulated in §4, built
     into `Word` arrays by a small `words("john 3 : 16", start=10.0)` helper in the test file.
     Add a test that `john 3 : 16 - 18` gives one P1 match and no stray P9. Commit.
- **Verify:** `pytest tests/test_grammar.py -q`
- **Done when:**
  - [x] P1, P2 and P9 pass with their tabulated examples.
  - [x] Consumption is tested.
  - [x] `source_start` is the start of the ordinal for "first corinthians…".

### T-12.2 · P3–P8: keyword and comma forms

**Executor** agent · **Size** S · **Prereqs** T-12.1 · **Status** todo

- **Read:** [04 §4](../04-reference-detection.md) (the P3–P8 rows)
- **Touches:** `sidecar/versesync/detect/grammar.py` · `tests/test_grammar.py`
- **Steps:**
  1. Add P3, P4 and P5 (the `chapter`/`verse(s)` keyword forms, with ranges using
     `through|to|-|and`). Commit.
  2. Add P6, P7 and P8 (the comma and bare-number forms). P8 here is the **non-Psalms**
     behaviour only: a split reading `ch, v`. P5 has `verse=None`. Write three phrasings per
     pattern, as [11 §1](../11-testing.md) asks. Commit.
- **Verify:** `pytest tests/test_grammar.py -q`
- **Done when:**
  - [ ] Every P3–P8 row has tests with three phrasings each, including its tabulated example.
  - [ ] The final priority order is P1 > P2 > … > P9, and a test proves it on an input where
        two patterns could both match.

### T-12.3 · P10, and P11/P12 context carry

**Executor** agent · **Size** S · **Prereqs** T-12.2 · **Status** todo

- **Read:** [04 §4](../04-reference-detection.md) (the P10–P12 rows and the "Context carry"
  paragraph)
- **Touches:** `sidecar/versesync/detect/grammar.py` · `tests/test_grammar.py`
- **Steps:**
  1. Add P10, `the ORD chapter of B (, verse[s] N)?`. The chapter is the ordinal's value, and
     the verse is optional. Commit.
  2. Add P11 and P12. A bare verse fragment inherits book and chapter from the **most recent**
     non-contextual candidate, but only if **both** bounds hold: fragment `source_start` minus
     that candidate's `source_end` ≤ `context_window_s`, **and** the token distance ≤
     `context_window_tokens`. Otherwise drop the fragment. Carried candidates have
     `contextual=True`, `pattern` P11/P12, and the carried `book_match`. Commit.
  3. Tests:
     - carry works inside the window;
     - it's dropped at 121 s;
     - it's dropped at 401 tokens even when that's within 120 s;
     - it carries from the most recent book, not an earlier one ("Romans 8 … John 3 … verse
       16" gives John 3:16).

     Commit.
- **Verify:** `pytest tests/test_grammar.py -q`
- **Done when:**
  - [ ] P10–P12 pass their tabulated examples.
  - [ ] Both window bounds are tested independently.

### T-12.4 · Psalms concatenation, chapter-only, and the bootstrap corpus check

**Executor** agent · **Size** S · **Prereqs** T-12.3 · **Status** todo

- **Read:** [04 §3.1](../04-reference-detection.md) (the first bullet) ·
  `tests/fixtures/README.md` (the label format only) · `tests/fixtures/cue-documents/alternatives.json`
  (print the first cue's `reference` and `alternatives[0].reference` with `python -c`; don't
  cat the file)
- **Touches:** `sidecar/versesync/detect/grammar.py` · `tests/test_grammar.py` ·
  `tests/test_grammar_corpus.py` (new)
- **Steps:**
  1. **The Psalms rule.** When P8 matches with book Psalms, and `int(f"{n1}{n2}")` is a valid
     chapter, and `n1:n2` is *also* a valid chapter and verse (check both with `canon`), emit
     the concatenated reading as a chapter-only candidate. Attach the split reading as
     `alternatives[0]`, with `alternative_reason="Split chapter:verse reading — 'Psalm N N' is
     ambiguous"`. If only one reading is valid, emit just that one. For a book other than
     Psalms, P8 stays split-only. Commit.
  2. Check that every chapter-only form (P5, P9, and P10 without a verse) produces
     `verse=None`. Add any tests that are missing. Commit.
  3. **The bootstrap corpus check** (`test_grammar_corpus.py`). For every T-41 label with a
     non-null `reference` and a `mention_span_s`, check that some candidate overlaps that span
     with the same book and chapter. Every negative label must have **zero** candidates inside
     its `span_s`. Labels the grammar can't find yet go in an explicit `KNOWN_MISSES` dict in
     the test, mapping the label to a one-line reason. Keep that dict short and honest. Commit.
- **Verify:** `pytest tests/test_grammar.py tests/test_grammar_corpus.py -q`
- **Done when:**
  - [ ] "psalm twelve two" gives Psalm 122 with an alternative of Psalm 12:2, matching
        `alternatives.json`.
  - [ ] "psalm one nineteen" gives only Psalm 119, because 1:19 is invalid.
  - [ ] Zero candidates in any negative label span.
  - [ ] Every miss is listed with a reason.

## Traps

- The context window is *"120 seconds **or** 400 tokens, whichever is shorter"*. That means
  both bounds have to hold, not just one of them.
- Emit alternatives; don't pick a winner. Ranking is T-13's job, and the final call is the
  editor's (D4).
- Don't widen the context window to catch more P11/P12 fragments. They're the patterns most
  likely to attach to the wrong passage.
