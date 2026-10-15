# T-31 · Journey B: the re-run

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | T-32, release |
| **Spec** | [00-prd.md §6](../00-prd.md) · [03 §4](../03-architecture.md) · [05 §5](../05-timing-and-placement.md) |

## Goal

Re-analysing a file that's already been transcribed, after the sequence has been recut, returns
in seconds with correctly updated anchors. This is **half the product's value**.

## Context

The Cue Document stores **source time only**, so a recut invalidates the *mapping* and never the
*analysis*. Most of this epic is proving that the existing pieces compose correctly.

## Subtasks

### T-31.1 · Recut scenarios, automated

**Executor** agent · **Size** S · **Prereqs** T-30.2, T-20.4 · **Status** todo

- **Read:** [05 §5.2](../05-timing-and-placement.md) · [11 §6](../11-testing.md) (step 31)
- **Touches:** `tests/panel/journey-b.test.js` (new) · `tests/fixtures/host/recut-*.json` (new;
  these are **new** fixtures, not edits to frozen ones)
- **Steps:**
  1. Add two recut segment fixtures, consistent with `segments-split.json`:
     - `recut-delete`, where a middle section is removed;
     - `recut-move`, where two sections swap order.

     Commit.
  2. Write a panel-level test with the stub bridge and the fake client, running Analyse twice:
     - the second run reports `cache_hit` and the progress view shows *Using cached transcript*;
     - in between, the stub scenario switches to each recut fixture;
     - every anchor is **re-derived**, with no stale ticks: cues in the deleted section get
       `cut_from_edit` and are disabled, and cues in moved sections shift by exactly the move
       delta;
     - a saved document loaded after the recut re-maps the same way;
     - progress still ends at exactly 1.0.

     Commit.
- **Verify:** `node --test tests/panel/journey-b.test.js`
- **Done when:**
  - [ ] The delete and move recuts both behave as [05 §5.2] says.
  - [ ] Nothing in the Cue Document stores ticks.

### T-31.H · Journey B on a real workstation

**Executor** human · **Size** — · **Prereqs** T-31.1, T-30.H · **Status** todo

- Run [11 §6](../11-testing.md) steps 12 and 31 on a real recut. The re-analysis must take
  **under 5 s**, and the anchors must be correct.
- Record the results in `docs/qa/journey-b.md`.

## Traps

- If storing ticks in the Cue Document starts to look necessary, something upstream is wrong.
