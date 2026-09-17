# T-10 · Token normalisation and spoken-number parsing

| | |
|---|---|
| **Workstream** | C — Detection |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-09, T-41 |
| **Unblocks** | T-12 |
| **Spec** | [04-reference-detection.md §3, §3.1](../04-reference-detection.md) |

## Goal

Turn a word array into a normalised token array plus a searchable string, **without losing the
link back to timestamps**.

## Context you need

Preachers speak numbers, they do not read digits: *"turn with me to First Corinthians six,
nineteen and twenty"*. The grammar (T-12) needs `1 corinthians 6 : 19 - 20`.

The critical design point from [04 §3](../04-reference-detection.md): every `Token` keeps
`word_ids` back-references into the original `Word` array. **Losing that back-reference is the
single easiest way to get this module wrong** — it is how a regex match at the end becomes a
timestamp.

## Steps

1. Implement the `Token` dataclass exactly as [04 §3](../04-reference-detection.md) specifies —
   `text`, `kind`, `value`, `word_ids`, `start`, `end`, `prob`. `prob` is the **min** across
   source words; `start`/`end` come from the first and last.
2. Implement the six normalisation steps in order. Keep `:` and `-` as their own tokens — they
   are structural, not punctuation to strip.
3. Implement the spoken-number parser covering units, tens, compounds and hundreds, up to
   **176** (Psalm 119:176). "one hundred and nineteen" → 119. "twenty eight" → 28.
4. Implement the ordinal rule: a unit number immediately before a book that *has* a numbered
   form (Samuel, Kings, Chronicles, Corinthians, Thessalonians, Timothy, Peter, John) is an
   **ordinal prefix, never a chapter**. "one Corinthians" is the book.
5. Build the **search string** — token texts joined by single spaces — with a
   `char_offset → token_index` map, so the grammar can use regexes and still convert a match
   span back to tokens, and from there to `(start, end)` and probabilities.
6. Implement and test the round-trip: token span → word span → source seconds.

## Files

- `sidecar/versesync/detect/normalize.py`
- `tests/test_normalize.py`

## Done when

- [ ] Every row of the [04 §3.1](../04-reference-detection.md) table passes, including
      "one hundred and nineteen", "twenty eight", "first Corinthians", "twenty-eight".
- [ ] Timestamps round-trip: a token span converts back to the correct source seconds.
- [ ] Digits already in the transcript (`3`) normalise identically to spoken forms ("three").
- [ ] The offset map is exact — a fuzz test over random token arrays confirms every character
      offset maps to the right token.

## Traps

- One token can span several words ("twenty eight" → one token, two `word_ids`), and one word
  can produce several tokens. `word_ids` is a **list** for exactly this reason.
- Do not resolve the "Psalm one nineteen" ambiguity here — this module emits both number
  tokens; [04 §3.1](../04-reference-detection.md)'s concatenation rule belongs to the grammar
  (T-12), which knows the book.
