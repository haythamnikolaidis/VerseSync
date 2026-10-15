# T-17 · Read-span alignment

| | |
|---|---|
| **Workstream** | E — Timing |
| **Unblocks** | T-18 |
| **Spec** | [05-timing-and-placement.md §4](../05-timing-and-placement.md) |

## Goal

Decide **READ vs PARAPHRASE**, find where a reading starts and ends, and report
`read_coverage` for every cue.

## Context

**Both classes get a graphic** (G4). Classification changes the *duration* and the
*confidence*, never whether the cue exists. Alignment needs the verse text, so it runs after
resolution. If no passage was resolved, skip alignment and classify as PARAPHRASE.

```python
# timing/align.py
@dataclass(frozen=True)
class AlignConfig:
    read_coverage_threshold: float = 0.55
    max_skip: int = 6
    k_starts: int = 12
    fuzzy_min_len: int = 5            # Levenshtein ≤ 1 only for tokens of length ≥ 5
    lookbehind_mult: float = 0.6; lookbehind_add: int = 20
    lookahead_mult: float = 1.8;  lookahead_add: int = 30
STOP_WORDS = frozenset({"the", "a", "an", "and", "of", "to", "in", "that"})

@dataclass(frozen=True)
class AToken:                         # alignment token, over the TRANSCRIPT
    text: str; word_index: int; start: float; end: float

@dataclass(frozen=True)
class Alignment:
    classification: str               # 'read' | 'paraphrase'  (the schema enum values)
    coverage: float
    read_start_s: float | None; read_end_s: float | None
    read_word_span: tuple[int, int] | None    # inclusive; for the panel's underline

def align(verse_texts: Sequence[str], words: Sequence[Word], mention_word_index: int,
          cfg: AlignConfig = AlignConfig()) -> Alignment
```

`verse_texts` is `[v.text for v in passage.verses]`. Those texts are clean and contain no verse
numbers.

## Subtasks

### T-17.1 · Alignment normalisation, window and token equality

**Executor** agent · **Size** XS · **Prereqs** T-14.3, T-13.3 · **Status** in-progress

- **Read:** [05 §4.1](../05-timing-and-placement.md) (the "window" line and the normalisation
  paragraph)
- **Touches:** `sidecar/versesync/timing/align.py` (new) · `tests/test_align.py` (new)
- **Steps:**
  1. Write `AlignConfig`, `STOP_WORDS` and `AToken`, plus these functions:
     - `normalise_verse(verse_texts) -> list[str]`: lowercase, strip punctuation, drop stop
       words, and drop any token made only of digits;
     - `transcript_tokens(words) -> list[AToken]`: the same normalisation, keeping the word
       index;
     - `window_bounds(m, n_verse_tokens, n_tokens, cfg) -> (lo, hi)`, clamped;
     - `tokens_equal(a, b, cfg)`: exact match, or Levenshtein ≤ 1 when both tokens have length
       ≥ `fuzzy_min_len`. Use `jellyfish` (added by T-11.3).

     Test each function. Commit.
- **Verify:** `pytest tests/test_align.py -q`
- **Done when:**
  - [ ] The stop list is applied to **both** sides, with a test that proves it.
  - [ ] The window is clamped to the transcript at both ends.

### T-17.2 · Greedy aligner, multi-start, classification

**Executor** agent · **Size** S · **Prereqs** T-17.1 · **Status** todo

- **Read:** [05 §4.1, §4.2, §4.3](../05-timing-and-placement.md) (the pseudocode)
- **Touches:** `sidecar/versesync/timing/align.py` · `tests/test_align.py`
- **Steps:**
  1. Implement `align_from(start_j)` exactly as the pseudocode says, including the skip budget.
     Then the multi-start search: from the first `k_starts` positions in the window where the
     token equals `V[0]` or `V[1]`, keep the best coverage. Break ties on the earliest start.
     Then `align()`, with classification and outputs. If `verse_texts` is empty, the result is
     paraphrase with coverage 0.0. Commit.
  2. Write the [11 §1](../11-testing.md) "Alignment" cases using inline word arrays:
     - a verbatim reading gives coverage ≥ 0.9;
     - a reading with an interjection is still READ;
     - a paraphrase gives ≤ 0.35;
     - when the reading comes before the reference is named, `read_start_s` is before the
       mention;
     - empty verse text gives paraphrase.

     Commit.
- **Verify:** `pytest tests/test_align.py -q`
- **Done when:**
  - [ ] Every [11 §1] alignment case passes.
  - [ ] `coverage` is always reported, including for paraphrases.

### T-17.3 · Calibration against the bootstrap corpus

**Executor** agent · **Size** S · **Prereqs** T-17.2 · **Status** todo

- **Read:** `tests/fixtures/README.md` (the label format) · [05 §4.2](../05-timing-and-placement.md)
  ("Why 0.55")
- **Touches:** `tests/test_align_corpus.py` (new) · `docs/qa/alignment-calibration.md` (new)
- **Steps:**
  1. For every T-41 label with `expected_classification` set to `read` or `paraphrase`:
     - run `detect()` and match the detection to the label by its mention span;
     - resolve it with `LocalProvider`;
     - run `align()`;
     - collect the coverage for each class.

     Write the two distributions as a table in `docs/qa/alignment-calibration.md`. Assert that
     the classification matches the label, except for an explicit `KNOWN_MISCLASSIFIED` dict
     with a reason per entry. Commit.
  2. **Performance.** `align()` called on every detection in `long-sermon-filler` must finish
     in under 1 s in total. Commit.
- **Verify:** `pytest tests/test_align_corpus.py -q`
- **Done when:**
  - [ ] The distributions are documented, and any overlap between them is stated with the data.
        Don't move the threshold here. v1 ships 0.55 as specified (D24); the table is the
        evidence for a future tuning pass.
  - [ ] The performance bound holds.

## Traps

- Don't use alignment as a filter.
- This algorithm was chosen over LCS on purpose. Don't "improve" it into full alignment.
- `classification` uses the schema enum values `read` and `paraphrase`, in lowercase.
