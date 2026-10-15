# T-13 · Canon validation, confidence and the `detect()` entry point

| | |
|---|---|
| **Workstream** | C — Detection |
| **Unblocks** | T-17, T-19, T-21.1, T-48 |
| **Spec** | [04-reference-detection.md §5, §6, §7](../04-reference-detection.md) |

## Goal

Reject impossible references, score every survivor between 0 and 1, collapse duplicates, and
expose a single `detect(words) -> list[Detection]` function. That function is everything the
detection stream promises downstream.

## Context

Number mishearings usually produce *impossible* references, such as "Jude 5:1", so validation
is the cheapest quality win in the pipeline. **No cue is ever discarded because of low
confidence.** Confidence only drives flagging (D4).

```python
# detect/detector.py
@dataclass(frozen=True)
class DetectConfig:
    grammar: GrammarConfig = GrammarConfig()
    max_range: int = 30
    duplicate_cooldown_s: float = 60.0

@dataclass(frozen=True)
class Detection:
    id: str                          # "det_001", numbered in source_start order
    candidate: Candidate
    reference: Reference             # validated
    confidence: float                # before the timing stage's corroboration bonus
    validation_score: float          # 1.0, or 0.5 if valid only after an alternative reading
    flags: tuple[str, ...]           # only 'chapter_only' and/or 'suppressed_duplicate'
    snippet: str
    alternatives: tuple[tuple[Reference, float, str], ...]   # (reference, confidence, reason)
    def to_json(self, canon: Canon) -> dict                  # the 04 §7 shape

def detect(words: Sequence[Word], canon: Canon | None = None,
           cfg: DetectConfig = DetectConfig()) -> list[Detection]
```

`low_confidence` is **not** decided here. It depends on confidence *after* the corroboration
bonus, so the cue builder (T-19.1) assigns it.

## Subtasks

### T-13.1 · Canon validation rules

**Executor** agent · **Size** S · **Prereqs** T-12.4 · **Status** done

- **Read:** [04 §5](../04-reference-detection.md)
- **Touches:** `sidecar/versesync/detect/validate.py` (new) · `tests/test_validation.py` (new)
- **Interface:**
  `def validate(c: Candidate, canon: Canon, max_range: int = 30) -> tuple[Candidate, float] | None`
  It returns the candidate, possibly adjusted, with its `validation_score`, or `None` to
  discard it.
- **Steps:**
  1. Implement the five §5 rules in order:
     - unknown book → discard;
     - chapter > chapter count → discard;
     - verse > verse count: if the candidate has an alternative that validates, promote that
       alternative with score 0.5; otherwise discard;
     - `verse_end < verse` → swap if the swapped range validates, otherwise drop the end;
     - `verse_end - verse > max_range` → drop the end.

     Validate the alternatives as well, and drop any that are invalid. Commit.
  2. Write tests for every rule: `Jude 5:1`, `Psalm 151:1` and `John 3:100` are rejected;
     `Psalm 119:176` and `Obadiah 1:21` are accepted and `Obadiah 1:22` is rejected; a
     reversed range swaps; a range over 30 drops its end. Commit.
- **Verify:** `pytest tests/test_validation.py -q`
- **Done when:**
  - [x] Every rule has at least one passing and one failing case.

### T-13.2 · Confidence scoring

**Executor** agent · **Size** XS · **Prereqs** T-13.1 · **Status** done

- **Read:** [04 §6](../04-reference-detection.md)
- **Touches:** `sidecar/versesync/detect/confidence.py` (new) · `tests/test_confidence.py` (new)
- **Interface:**
  `def score(c: Candidate, validation_score: float) -> float`. Every weight is a module-level
  constant.
- **Constants** (named exactly like this, so a future tuning pass can find them; tuning is deferred by D24): `W_BOOK=0.40`,
  `W_ASR=0.25`, `W_STRUCTURE=0.25`, `W_VALIDATION=0.10`; `BOOK_EXACT=1.0`, `BOOK_ALIAS=0.85`,
  `BOOK_FUZZY_D1=0.65`, `BOOK_FUZZY_D2=0.55`; `STRUCT_VERSE=1.0`, `STRUCT_RANGE=0.75`,
  `STRUCT_CHAPTER=0.55`, `STRUCT_CONTEXT=0.45`. A contextual candidate scores `STRUCT_CONTEXT`
  regardless of its shape. Clamp the result to [0, 1].
- **Steps:**
  1. Implement and test. Cover each structure class, each book tier, the clamp, and the fact
     that the same input always gives the same output. Commit.
- **Verify:** `pytest tests/test_confidence.py -q`
- **Done when:**
  - [x] The structure scores match §6: 1.0, 0.75, 0.55 and 0.45.
  - [x] Every weight is a named constant.

### T-13.3 · Duplicate suppression, snippets and `detect()`

**Executor** agent · **Size** S · **Prereqs** T-13.2 · **Status** in-progress

- **Read:** [04 §6](../04-reference-detection.md) (the "Duplicate suppression" bullet) ·
  [04 §7](../04-reference-detection.md)
- **Touches:** `sidecar/versesync/detect/detector.py` (new) · `tests/test_detector.py` (new)
- **Steps:**
  1. Write `DetectConfig`, `Detection` and `detect()`. The pipeline is: normalize →
     find_candidates → validate → score → suppress → number the results.
     - **Suppression:** a candidate whose reference equals that of a *kept* detection whose
       `source_start` is within `duplicate_cooldown_s` gets `suppressed_duplicate` and is still
       returned.
     - **`chapter_only`** is set when `verse is None`.
     - **`snippet`** is the raw `Word.text` from 5 words before `word_span[0]` to 5 words after
       `word_span[1]`, joined with spaces, with a leading or trailing `…` wherever it was cut.

     Commit.
  2. Write `to_json`, matching the 04 §7 example's keys. Write tests:
     - three mentions of John 3:16 in 50 s give 1 kept and 2 suppressed, all returned;
     - a fourth mention at 70 s is kept;
     - `detect()` on `long-sermon-filler.words.json` runs in under 1 s and is deterministic
       (two runs give equal JSON).

     Commit.
- **Verify:** `pytest tests/test_detector.py -q`
- **Done when:**
  - [ ] Suppressed rows survive, with their flag set.
  - [ ] `detect()` is deterministic, and its `to_json` matches the 04 §7 keys.

## Traps

- Don't discard low-confidence cues. The review list exists to decide those.
- The +0.10 corroboration bonus belongs to T-18, not here.
- There's no tuning pass in v1 (D24). The constants ship as specified, so copy them exactly.
