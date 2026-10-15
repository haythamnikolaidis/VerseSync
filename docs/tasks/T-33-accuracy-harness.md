# T-33 · Accuracy harness and golden files

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | release (T-33.1 is the detection regression guard) |
| **Spec** | [11-testing.md §3, §4](../11-testing.md) · [00-prd.md §5](../00-prd.md) |

> **Rescoped 2026-10-15 (D24).** Accuracy measurement is **deferred past v1**: there is no
> capacity to build the labelled corpus, and stakeholders accepted the detection-accuracy risk.
> **T-33.2 and T-33.H are deferred.** **T-33.1 stays in scope.** It needs no corpus, because it
> runs on the existing T-41 fixtures, and it's the only regression guard left for detection
> output once measurement is gone.

## Goal

One command measures **M1 recall, M2 precision and M3 anchor accuracy** against the
hand-labelled corpus, with a diff mode for catching regressions. Golden-file tests pin down the
pipeline's output.

## Context

The **tooling** is agent work. The **corpus** isn't: at least 10 sermons, at least 3 speakers,
at least 300 labelled utterances, and double-annotated labels. That needs real sermon media and
human annotators, so it's T-33.H. The harness is built and tested on the T-41 bootstrap corpus
and scales unchanged to the full one.

## Subtasks

### T-33.1 · Golden-file tests

**Executor** agent · **Size** S · **Prereqs** T-21.1 · **Status** todo

- **Read:** [11 §4](../11-testing.md)
- **Touches:** `tests/golden/*.cues.json` (new) · `tests/test_golden.py` (new) ·
  `tools/regen_golden.py` (new)
- **Steps:**
  1. Write `tools/regen_golden.py`. For every T-41 `*.words.json`, it runs `run_pipeline` with
     `LocalProvider`, a fixed `job.id` (`job_golden_<name>`) and a fixed `generated_at`, and
     writes `tests/golden/<name>.cues.json`. Commit the tool and its output.
  2. Write `test_golden.py`. It re-runs the pipeline and compares to the golden files, ignoring
     `generated_at` and `job.id`. On a mismatch it prints a **unified diff**. It runs everything
     twice and asserts byte-identical output. Commit.
- **Verify:** `pytest tests/test_golden.py -q`
- **Done when:**
  - [ ] The golden files are checked in and the tests pass with no GPU and no network.
  - [ ] Output is byte-identical across runs.

### T-33.2 · `accuracy_harness.py`: M1, M2, M3, plus diff mode

**Executor** agent · **Size** S · **Prereqs** T-33.1 · **Status** deferred

- **Read:** [00-prd.md §5](../00-prd.md) (the M1–M3 definitions) · `tests/fixtures/README.md`
  (the label format)
- **Touches:** `tools/accuracy_harness.py` (new) · `tests/test_accuracy_harness.py` (new)
- **Steps:**
  1. Write `python tools/accuracy_harness.py [--corpus DIR] [--out run.json] [--diff prev.json]
     [--holdout name,name]`. For each sermon, it pairs `*.words.json` with `*.labels.json` and
     runs the pipeline. It matches cues to labels when they have the **same reference** and
     their mentions are within 10 s. Then:
     - **M1** = labelled references that were surfaced ÷ labelled references (excluding
       negatives and suppressed duplicates);
     - **M2** = surfaced cues matching a label ÷ surfaced, non-suppressed cues;
     - **M3** = matched cues with |`source_anchor_s` − `expected_anchor_s`| ≤ 0.5 ÷ matched cues
       that have an `expected_anchor_s`.

     It reports each sermon **and** the aggregate, and for the aggregate it splits holdout
     sermons from tuning sermons. Commit.
  2. **Diff mode** prints per-metric deltas and exits 1 if any aggregate metric regressed. Test
     on a tiny synthetic corpus written in the test, with a known 2/3 recall, a known precision,
     and one anchor off by 0.6 s, then check the diff exit code. Commit.
- **Verify:** `pytest tests/test_accuracy_harness.py -q && python tools/accuracy_harness.py`
- **Done when:**
  - [ ] One command prints M1, M2 and M3 for each sermon and in aggregate.
  - [ ] Diff mode gates on any regression.

### T-33.H · Build the full corpus

**Executor** human · **Size** — · **Prereqs** T-33.2, T-07.H · **Status** deferred

- Grow T-41's corpus to the [11 §3](../11-testing.md) specification. Transcribe each sermon
  with the CLI on the GPU workstation. Label every reference following the labelling protocol,
  with a second annotator checking a 10% sample and adjudicating disagreements over 0.25 s.
- Commit **transcripts and labels only**, never media (R-12).
- Name at least 2 sermons as the **holdout** in `tests/fixtures/corpus/HOLDOUT`.

## Traps

- The quality of the corpus is the ceiling on everything T-34 can do.
- Golden files have to be **reviewable diffs**.
