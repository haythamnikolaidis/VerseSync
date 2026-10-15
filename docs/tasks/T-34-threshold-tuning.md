# T-34 · Threshold tuning

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | release |
| **Spec** | [04 §6](../04-reference-detection.md) · [05 §4.2](../05-timing-and-placement.md) · [00-prd.md §5](../00-prd.md) |
| **Gate** | Needs the full corpus from **T-33.H**, a human task. |

> **Deferred past v1 (D24, 2026-10-15).** There's no corpus to tune against, so v1 ships the
> constants **as specified** in [04 §6](../04-reference-detection.md) and
> [05 §2](../05-timing-and-placement.md). They stay named module-level constants (T-13.2,
> T-17.1), so reinstating this epic later needs no redesign. Don't start it.

## Goal

Replace every guessed constant with a measured one, and hit the release metrics:
**M1 ≥ 90%, M2 ≥ 85%, M3 ≥ 90%**, measured on the **holdout** sermons.

## Subtasks

### T-34.1 · Sweep tooling and report

**Executor** agent · **Size** S · **Prereqs** T-33.2, T-33.H · **Status** deferred

- **Read:** [04 §6](../04-reference-detection.md) · [05 §4.2](../05-timing-and-placement.md) ·
  the constants in `detect/confidence.py`, `detect/detector.py` and `timing/align.py` (grep for
  UPPER_CASE names)
- **Touches:** `tools/tune.py` (new) · `docs/qa/tuning-results.md` (new)
- **Steps:**
  1. Write `tools/tune.py`. It does a grid or coordinate-descent sweep over:
     - the confidence weights;
     - the amber threshold;
     - `read_coverage_threshold`;
     - the fuzzy distance bounds;
     - the context window;
     - the duplicate cooldown.

     It evaluates on the **tuning** sermons only, with the holdout excluded, by calling the
     harness API. Commit.
  2. Run it. Write `docs/qa/tuning-results.md` with:
     - the best values;
     - a table of the read and paraphrase coverage distributions, with any overlap stated;
     - every mishearing observed in the corpus that tier 1 missed. Those are candidates for
       `confusions.json`.

     Commit.
- **Verify:** `python tools/tune.py --dry-run`
- **Done when:**
  - [ ] The report exists and the holdout was never used for selection.

### T-34.2 · Apply the tuned constants

**Executor** agent · **Size** S · **Prereqs** T-34.1 · **Status** deferred

- **Read:** `docs/qa/tuning-results.md`
- **Touches:** `sidecar/versesync/detect/{confidence,detector,fuzzy}.py` ·
  `sidecar/versesync/timing/align.py` · `sidecar/versesync/detect/data/confusions.json` ·
  `tests/golden/*` · [12](../12-decisions-and-risks.md) (close Q-E)
- **Steps:**
  1. Apply the values. **Every changed constant gets a comment citing the measurement**, for
     example `# 0.52: tuning-results.md §2, best M1/M2 on 8 tuning sermons`. Add the confusion
     entries. Commit.
  2. Regenerate the golden files and review the diff in the PR body. Run the harness with
     `--holdout`, and report the holdout M1, M2 and M3 in the PR. Close Q-E in 12. Commit.
- **Verify:** `python tools/accuracy_harness.py --holdout $(cat tests/fixtures/corpus/HOLDOUT)`
- **Done when:**
  - [ ] Holdout metrics meet the targets, **or** the gap is reported with data and the task is
        marked blocked for a product decision. Never move the targets.

## Traps

- **Don't tune on the test set.**
- M2 is targeted *lower* than M1 on purpose. When in doubt, favour recall.
