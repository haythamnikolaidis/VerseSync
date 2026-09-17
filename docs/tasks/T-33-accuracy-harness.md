# T-33 · Accuracy harness

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 2–3 — **start as soon as T-21 lands** |
| **Estimate** | L |
| **Prereqs** | T-21, T-41, and the full corpus per [11 §3](../11-testing.md) |
| **Unblocks** | T-34 |
| **Spec** | [11-testing.md §3, §4](../11-testing.md) · [00-prd.md §5](../00-prd.md) |

## Goal

One command that measures **M1 recall, M2 precision and M3 anchor accuracy** against the
hand-labelled corpus.

## Context you need

M1–M3 are **release gates** ([11 §7](../11-testing.md)) — a build that regresses them does not
ship. Without this harness there is no way to tune T-34 or to know whether the product works.

This task also owns growing T-41's bootstrap corpus to full size per
[11 §3](../11-testing.md): **≥ 10 sermons, ≥ 3 speakers, ≥ 300 labelled utterances**, every
grammar form ≥ 5 times, ≥ 50 each of read and paraphrase, ≥ 2 degraded-audio sermons, negative
passages, and ≥ 2 recut variants for Journey B.

## Steps

1. Complete the corpus to the [11 §3](../11-testing.md) specification.
2. Follow the **labelling protocol**: one annotator marks the reference and the start frame of
   the first spoken word (or of the reading, when it comes first); a second annotator checks a
   **10% sample**; disagreements over 0.25 s are adjudicated and the resolving rule is written
   down. **Without this, M3's ±0.5 s target is measured against noise.**
3. **Storage:** media stays out of the repository — it is large and it is church property. Check
   in transcripts, labels and expected Cue Documents only. Most tests then run without audio.
4. Build `tools/accuracy_harness.py` computing:
   - **M1 recall** — labelled mentions VerseSync surfaces
   - **M2 precision** — surfaced cues that are genuinely correct
   - **M3 anchor accuracy** — cues within ±0.5 s of the labelled start
5. Report per-sermon **and** aggregate, so a single bad recording is visible rather than averaged
   away.
6. Implement **diff mode** against a previous run — this is what enforces the "no regression in
   any metric" release gate.
7. Build the **golden-file tests** from [11 §4](../11-testing.md): run the pipeline from stored
   word arrays through detection, local-provider resolution and timing; diff against expected Cue
   Documents, ignoring `generated_at` and job ids. Assert byte-identical output across two runs
   (determinism, [05 §10](../05-timing-and-placement.md)).

## Files

- `tools/accuracy_harness.py`
- `tests/fixtures/corpus/`, `tests/golden/`

## Done when

- [ ] One command prints M1, M2 and M3, per sermon and aggregate.
- [ ] Diff mode reports per-metric deltas against a stored previous run.
- [ ] Golden-file tests run with no GPU and no network.
- [ ] Two runs produce byte-identical output.
- [ ] The corpus meets every row of [11 §3](../11-testing.md).

## Traps

- Corpus quality is the ceiling on everything T-34 can do. The 10% double-check is not optional
  — a corpus labelled to ±1 s cannot validate a ±0.5 s target.
- Golden files must be **reviewable diffs**. That is what makes T-34's tuning safe: a threshold
  change shows up as a visible change in expected output rather than a silent behaviour shift.
- **Do not commit sermon media** (risk R-12, and repo size).
