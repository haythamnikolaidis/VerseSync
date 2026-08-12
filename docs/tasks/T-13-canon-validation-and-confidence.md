# T-13 · Canon validation and confidence

| | |
|---|---|
| **Workstream** | C — Detection |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-12 |
| **Unblocks** | T-20 |
| **Spec** | [04-reference-detection.md §5, §6](../04-reference-detection.md) |

## Goal

Reject impossible references, score every survivor in `[0,1]`, and collapse duplicates.

## Context you need

Number mishearings usually produce *impossible* references rather than merely wrong ones —
"Jude 5:1" when Jude has one chapter. So validation removes a large share of false positives at
effectively zero cost. It is the cheapest quality win in the pipeline.

Confidence drives **flagging only**. **No cue is ever auto-discarded on confidence** — D4 puts a
human in the loop, and a low-confidence true positive is far cheaper to surface than to lose.

## Steps

1. Implement the [04 §5](../04-reference-detection.md) rejection rules against T-09's canon
   data:
   - book not in canon → discard
   - `chapter > book.chapter_count` → discard
   - `verse > verse_counts[chapter]` → discard, **unless** a plausible concatenation exists, in
     which case try the alternative reading
   - `verse_end < verse_start` → swap if the swap validates, else drop the end
   - `verse_end - verse_start > max_range` (default 30) → drop the end as a mis-parse
2. Implement the [04 §6](../04-reference-detection.md) confidence formula. **Weights are named
   constants** in `detector.py` — T-34 tunes them, and they must be findable and changeable in
   one place.
3. Implement duplicate suppression: identical references within the cooldown (default 60 s)
   collapse to the first; the rest are retained as `suppressed: true` rows (FR-3.6), not
   deleted. A speaker circling back three times wants one graphic — but the editor should still
   see that it happened.
4. Leave a hook for the **corroboration bonus (+0.10)**, applied later by the timing stage
   (T-18) when a read span is found.
5. Make it deterministic — same input, same scores, every time
   ([05 §10](../05-timing-and-placement.md)).

## Files

- `sidecar/versesync/detect/detector.py`
- `tests/test_validation.py`, `tests/test_confidence.py`

## Done when

- [ ] "Jude 5:1", "Psalm 151:1" and "John 3:100" are all rejected.
- [ ] A reversed range swaps when valid and drops the end when not.
- [ ] Confidence is deterministic and every weight is a named constant.
- [ ] Duplicate suppression collapses repeats within the window and retains them flagged.
- [ ] Structure scores match [04 §6](../04-reference-detection.md): 1.0 book+ch+verse ·
      0.75 range · 0.55 chapter-only · 0.45 context-carried.

## Traps

- Do not discard low-confidence cues. Flag at 0.55 (the tuned default) and let the review list
  decide — that is the entire point of D4.
- Suppression must survive into the Cue Document as flagged rows, not vanish.
- The tuning pass is **T-34**, not T-31. (Doc [04 §6](../04-reference-detection.md) previously
  cited the wrong ID.)
