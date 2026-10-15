# T-10 · Token normalisation and spoken-number parsing

| | |
|---|---|
| **Workstream** | C — Detection |
| **Unblocks** | T-11, T-12 |
| **Spec** | [04-reference-detection.md §3, §3.1](../04-reference-detection.md) |

## Goal

Turn a `Word` array into a normalised `Token` array, and a regex-searchable string, **without
losing the link back to timestamps**.

## Context

Preachers speak numbers; they don't read digits. *"Turn with me to First Corinthians six,
nineteen and twenty"* has to become `1 corinthians 6 , 19 and 20`. Every `Token` keeps
`word_ids` back-references into the `Word` array. **Losing that back-reference is the easiest
way to get this module wrong**, because it's how a regex match ends up as a timestamp.

## Subtasks

### T-10.1 · Spoken-number and ordinal parser

**Executor** agent · **Size** S · **Prereqs** T-09.3 · **Status** done

- **Read:** [04 §3.1](../04-reference-detection.md)
- **Touches:** `sidecar/versesync/detect/numbers.py` (new) · `tests/test_numbers.py` (new)
- **Interface:**
  ```python
  def parse_cardinal(words: Sequence[str], i: int) -> tuple[int, int] | None:
      """Parse a cardinal number starting at words[i] (already lowercased, punctuation-stripped).
      Returns (value, words_consumed), or None. Covers digits ("119"), units/teens, tens,
      hyphenated and spaced compounds ("twenty-eight", "twenty eight"), and hundreds with an
      optional "and" ("one hundred and nineteen"). Range 1..176."""
  def parse_ordinal(words: Sequence[str], i: int) -> tuple[int, int] | None:
      """first..thirty-first in words, and digit forms "1st", "2nd", "3rd", "23rd", "119th".
      Also the roman numerals "i", "ii", "iii" (book prefixes only). Returns (value, consumed)."""
  ```
- **Steps:**
  1. Implement `parse_cardinal`, greedy and longest-match. Test every row of [04 §3.1]: 1–19,
     20–90, `twenty eight`, `twenty-eight`, `forty two`, `one hundred`,
     `one hundred and nineteen`, `one hundred nineteen`, `176`. Also test that "one hundred and"
     consumes 2 words and leaves "and" behind when nothing follows it. Commit.
  2. Implement `parse_ordinal` and test it. Commit.
- **Verify:** `pytest tests/test_numbers.py -q`
- **Done when:**
  - [x] Every number from 1 to 176 round-trips from its spelled-out form. Generate the inputs
        in the test from a small number-to-words helper written in the test file.
  - [x] `parse_cardinal(["and"], 0)` is `None`.

### T-10.2 · `Token` and the normalisation pass

**Executor** agent · **Size** S · **Prereqs** T-10.1 · **Status** todo

- **Read:** [04 §3](../04-reference-detection.md) (the `Token` dataclass and steps 1–6)
- **Touches:** `sidecar/versesync/detect/types.py` (new) · `sidecar/versesync/detect/normalize.py`
  (new) · `tests/test_normalize.py` (new)
- **Interface:**
  ```python
  # detect/types.py
  @dataclass(frozen=True)
  class Token:
      text: str                 # normalised surface; numbers render as digits, e.g. "28"
      kind: str                 # 'word' | 'number' | 'ordinal' | 'punct'
      value: int | None
      word_ids: tuple[int, ...] # indices into the Word array; never empty
      start: float; end: float  # first/last source word
      prob: float               # min probability across source words
  # detect/normalize.py
  def normalize(words: Sequence[Word], canon: Canon) -> list[Token]
  ```
- **Rules** (the order matters):
  1. Lowercase, then split each word's text into a core and attached punctuation. `:` and `-`
     between digits (`3:16`, `19-20`) become separate `punct` tokens. A trailing `,` becomes a
     `punct` token `,`. Every other punctuation character is dropped.
  2. Number words collapse into one `number` token, using `parse_cardinal` across word
     boundaries (`twenty` + `eight` gives 28, with `word_ids` (i, i+1)).
  3. Ordinal words become `ordinal` tokens.
  4. A bare unit number from 1 to 3 (digit or word, including "one") that comes **immediately
     before a numbered-book base** from `canon.numbered_bases()` becomes an `ordinal`. "one
     corinthians" is the book, not chapter 1.
  5. Everything else becomes a `word` token.
- **Steps:**
  1. Write the `Token` type and rules 1, 2 and 5. Commit.
  2. Write rules 3 and 4, with tests built from the
     `tests/fixtures/transcripts/numbers-and-ordinals.words.json` fixture. Load it; don't paste
     it into the test. Commit.
- **Verify:** `pytest tests/test_normalize.py -q`
- **Done when:**
  - [ ] "First Corinthians six, nineteen and twenty" gives
        `[ordinal 1, word corinthians, number 6, punct ',', number 19, word and, number 20]`.
  - [ ] Digits and spelled-out forms of the same number produce equal `text` and `value`.
  - [ ] Every token's `word_ids` is non-empty and ascending, and the union over all tokens
        covers every word that produced a token.

### T-10.3 · Search string, offset map and span round-trip

**Executor** agent · **Size** S · **Prereqs** T-10.2 · **Status** todo

- **Read:** [04 §3](../04-reference-detection.md) (the last paragraph, on the search string)
- **Touches:** `sidecar/versesync/detect/normalize.py` · `tests/test_search_text.py` (new)
- **Interface:**
  ```python
  @dataclass(frozen=True)
  class SearchText:
      text: str                                   # token texts joined by single spaces
      def token_at(self, char_offset: int) -> int
      def token_span(self, char_start: int, char_end: int) -> tuple[int, int]  # inclusive [first,last]
  def build_search_text(tokens: Sequence[Token]) -> SearchText
  def word_span(tokens: Sequence[Token], first: int, last: int) -> tuple[int, int]   # inclusive
  def seconds(tokens: Sequence[Token], first: int, last: int) -> tuple[float, float]
  ```
- **Steps:**
  1. Implement these, using a sorted array of token start offsets and bisection, so there's no
     per-character dict. Commit.
  2. Write a **fuzz test**: 200 random token arrays from a seeded RNG. For every character
     offset, `token_at` has to agree with a brute-force reference implementation. Then a
     round-trip test on a fixture: a regex match for `corinthians 6 , 19 and 20` converts back
     to the right source seconds. Commit.
- **Verify:** `pytest tests/test_search_text.py -q`
- **Done when:**
  - [ ] The fuzz test passes. The offset map is exact, including for spaces, which map to the
        token before them.
  - [ ] A token span converts back to the correct word span and source seconds.

## Traps

- One token can span several words ("twenty eight"), and one word can produce several tokens
  ("3:16" gives `3`, `:` and `16`). That's why `word_ids` is a tuple.
- Don't resolve "Psalm one nineteen" here. Emit both number tokens; the concatenation rule
  belongs to the grammar (T-12.4).
