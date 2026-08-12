# T-17 · Read-span alignment

| | |
|---|---|
| **Workstream** | E — Timing |
| **Wave** | 1 |
| **Estimate** | L |
| **Prereqs** | T-12, T-14, T-41 |
| **Unblocks** | T-18 |
| **Spec** | [05-timing-and-placement.md §4](../05-timing-and-placement.md) |

## Goal

Decide **READ vs PARAPHRASE**, find where a reading starts and ends, and produce a corroboration
signal for confidence.

## Context you need

**Both classes get a graphic** — that is a product requirement ([00 §4](../00-prd.md), goal G4).
Classification changes *duration* and *confidence*, never whether the cue exists. Do not use
this to filter.

Alignment needs the verse text, so it runs **after** resolution. If a passage could not be
fetched (FR-4.5), skip alignment, classify PARAPHRASE, and fall back to the **fixed** default
duration — not the word-count model, because there are no words to count
([05 §4.3](../05-timing-and-placement.md)).

## Steps

1. Implement the **alignment normalisation**, which is deliberately different from T-10's:
   lowercase, strip punctuation, **remove verse numbers** from the verse text, and drop the
   stop-list (`the a an and of to in that`) from **both** sides. Content words carry the signal.
2. Implement the window: `T[m - (0.6·|V| + 20) … m + (1.8·|V| + 30)]`, where `m` is the mention's
   token index. The lookbehind catches reading-before-naming; the lookahead is generous because
   preachers interject while reading.
3. Implement the **monotonic greedy matcher with a skip budget** exactly as
   [05 §4.1](../05-timing-and-placement.md) pseudocode specifies. Equality is exact, or
   Levenshtein ≤ 1 for tokens of length ≥ 5. On exceeding `max_skip` (6), advance `i` — assume
   the speaker skipped a verse word.
4. Implement **multi-start search**: run the aligner from each of the first `K` (default 12)
   plausible starts — positions where the window token equals `V[0]` or `V[1]` — and keep the
   best coverage.
5. Classify: `READ` if `coverage >= read_coverage_threshold` (default **0.55**), else
   `PARAPHRASE`. Emit `read_start_s`, `read_end_s` (READ only) and `read_coverage` (**always**).
6. Make every threshold a named constant — T-34 tunes them.

## Files

- `sidecar/versesync/timing/align.py`
- `tests/test_align.py`

## Done when

- [ ] On the fixture corpus, hand-labelled readings score **≥ 0.6** and paraphrases **≤ 0.35**,
      with **no overlap** between the two distributions.
- [ ] If they do overlap, the threshold is tuned and the overlap is documented with the data.
- [ ] `read_coverage` is reported for every cue, including paraphrases.
- [ ] A cue whose passage failed to resolve classifies PARAPHRASE without crashing.
- [ ] Runtime is acceptable on the ~7,000-word fixture — this is O(K · window), not O(n²).

## Traps

- `read_coverage` is surfaced in the expanded review row so an editor can see **why** a cue was
  classified as it was. That is a goal-G3 trustworthiness requirement, not a debug field — emit
  it always.
- Chosen over LCS deliberately: linear-ish, tolerates ad-libs, and naturally yields the first
  and last matched timestamps. Do not "improve" it into a full alignment algorithm.
- The stop-list is dropped from **both** sides. Dropping from one skews coverage badly.
