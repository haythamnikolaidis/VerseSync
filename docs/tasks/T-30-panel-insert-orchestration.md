# T-30 · Panel: insert orchestration

| | |
|---|---|
| **Workstream** | F — Panel |
| **Wave** | 2 |
| **Estimate** | M |
| **Prereqs** | T-25, T-29 |
| **Unblocks** | T-31 |
| **Spec** | [09-ui-spec.md §6](../09-ui-spec.md) · [03 §4](../03-architecture.md) · [08 §6, §8](../08-premiere-host-api.md) |

## Goal

Turn an approved review list into a single `VS.insertCues` call, and report honestly what
landed. **This is where Journey A completes.**

## Steps

1. **Validate before anything happens** ([03 §4](../03-architecture.md)): sequence open, both
   fields mapped and distinct, ≥ 1 enabled cue, target track selected, no enabled cue still
   carrying a blocking flag.
2. Call **`VS.validateTrack`** with the ranges about to be written. If existing clips would be
   overwritten, confirm first: *"3 of your cues will overwrite existing clips on V3. Continue?"*
3. Build the payload — `{atTicks, durationTicks, reference, body}` per enabled cue — and **sort
   ascending by `atTicks`**. The host asserts this; the panel guarantees it.
4. Call **`VS.insertCues` once**. Not once per cue — the single call is what keeps the whole
   batch inside one undo group.
5. Render progress from `com.versesync.progress` CSXS events; disable setup and review controls
   during the run; show `Inserting… 7 / 16` on the button.
6. Summary: `Placed 16 of 16.` or `Placed 14 of 16 — 2 failed, see details.`, with per-cue
   failures expandable. **Retain review state** so a partial failure can be fixed and re-run on
   only the affected cues.
7. Say **"One Ctrl+Z reverts the whole batch"** in the summary the first time it happens.
8. Handle the edge states in [09 §7](../09-ui-spec.md): all cues disabled, job failed, provider
   down.

## Files

- `panel/js/main.js` (extended), `panel/js/review.js` (extended)

## Done when

- [ ] **Journey A completes end to end on a real sermon**: select media → Analyse → review →
      Insert → graphics on the timeline at the right moments.
- [ ] One Ctrl+Z removes the whole batch.
- [ ] A deliberately failing cue produces a partial summary and the rest still land.
- [ ] `validateTrack` confirmation appears when a populated track is targeted.
- [ ] Every validation refusal states its reason.

## Traps

- Sort before sending. An unsorted payload is rejected by the host with *"Internal error: cues
  must be sorted by time"* — which is a bug in this task, not in the host.
- Times must already be frame-snapped by `timemap.js` (T-28). The host does not re-snap.
- Do not disable the review list after a failed insert — retaining state is what makes a partial
  failure recoverable.
