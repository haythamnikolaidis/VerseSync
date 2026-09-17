# T-34 · Threshold tuning

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 3 |
| **Estimate** | M |
| **Prereqs** | T-33 |
| **Unblocks** | release |
| **Spec** | [04 §6](../04-reference-detection.md) · [05 §4.2](../05-timing-and-placement.md) · [00-prd.md §5](../00-prd.md) |

## Goal

Replace every guessed constant with a measured one, and hit the release metrics: **M1 ≥ 90%,
M2 ≥ 85%, M3 ≥ 90%**.

## Context you need

Every threshold in the pipeline was specified as a *starting point to be tuned*, not as an
answer. This task is where they become real. It is also open question **Q-E**'s resolution — the
amber confidence flag threshold is decided by the corpus, not by anyone's opinion.

## Steps

Tune against the corpus, using the harness's diff mode to check each change:

1. **Confidence weights** ([04 §6](../04-reference-detection.md)) — the 0.40/0.25/0.25/0.10
   split across book, ASR, structure and validation scores, and the tier scores within
   `book_score`.
2. **Amber flag threshold** — specified at 0.55 (Q-E).
3. **Read-coverage threshold** ([05 §4.2](../05-timing-and-placement.md)) — specified at 0.55,
   sitting in the gap between readings (0.6–0.9) and paraphrase (≤ 0.35). **Confirm that gap
   actually exists in the corpus.** If the distributions overlap, say so, pick the best split,
   and document the overlap rather than hiding it.
4. **Fuzzy distance bounds** ([04 §4.1](../04-reference-detection.md)) — the ≤ 2 / ≤ 1 bounds and
   the short-name exclusion list.
5. **Context window** ([04 §4](../04-reference-detection.md)) — 120 s / 400 tokens.
6. **Duplicate cooldown** — 60 s.
7. Grow the **curated confusion table** (T-11) from mishearings the corpus reveals. This is
   usually the cheapest recall win available, and it carries no precision cost because of the
   number-follows gate.
8. **Document every chosen value with the measurement that chose it** — a comment on the
   constant citing the number. This is a Definition-of-Done requirement
   ([13 §8](../13-technical-plan.md)).

## Files

- `sidecar/versesync/detect/detector.py`, `sidecar/versesync/timing/align.py`
- `sidecar/versesync/detect/data/confusions.json`
- `docs/qa/tuning-results.md`

## Done when

- [ ] **M1 ≥ 90%, M2 ≥ 85%, M3 ≥ 90%** on the corpus.
- [ ] Every tuned constant carries a comment citing the measurement that chose it.
- [ ] The read/paraphrase distributions are plotted or tabulated, and the chosen threshold is
      justified against them.
- [ ] Golden files are regenerated and the diffs reviewed.
- [ ] Q-E is closed in [12-decisions-and-risks.md](../12-decisions-and-risks.md).

## Traps

- **Do not tune on the test set.** Hold out at least two sermons and report final metrics on
  those, or you will ship numbers that do not survive contact with sermon eleven.
- Recall and precision trade against each other. M2 is targeted *lower* than M1 deliberately —
  a false positive costs one click to uncheck; a miss costs a full manual add. When in doubt,
  favour recall.
- If a metric cannot be reached, report the gap with data rather than moving the target. That is
  a product conversation ([13 §9](../13-technical-plan.md)).

> Docs [04 §6](../04-reference-detection.md) and [05 §4.2](../05-timing-and-placement.md)
> previously cited T-31 for this tuning pass. **T-34 is the owner.**
