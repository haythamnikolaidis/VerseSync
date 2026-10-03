# T-25 · Host: `VS.insertCues` + `VS.validateTrack`

| | |
|---|---|
| **Workstream** | G — Host (ExtendScript) |
| **Wave** | 1 |
| **Estimate** | L |
| **Prereqs** | **T-03 (hard gate)**, T-23 |
| **Unblocks** | T-30 |
| **Spec** | [08-premiere-host-api.md §6, §8](../08-premiere-host-api.md) |

## Goal

Place one MOGRT instance per cue at its own **absolute** time, with both text fields filled, all
inside a single undo group.

## Context you need

**This is the function VerseSync exists to call**, and it replaces VerseFlow's `insertBatch`.
The behavioural difference is the whole product: VerseFlow laid clips contiguously from the
playhead; VerseSync places each cue at an independent absolute time in the middle of a populated
timeline.

✅ **T-03 has reported** — see
[`spikes/absolute_insert/RESULTS.md`](../../spikes/absolute_insert/RESULTS.md).
**Overwrite confirmed, proceed as specified in [08 §6](../08-premiere-host-api.md) as written —
no fallback needed.** `importMGT` trims whichever existing clip it overlaps, from whichever edge
is encroached on, order-independently; verified on a single overlap, an empty track, past the
sequence end, and a 20-cue overlap stress test in two insertion orders plus a repeated
double-overlap pass. No ripple was observed on the target track or any other track in any case.

T-03 also surfaced two risks that are **not** about overwrite-vs-ripple and need handling here
regardless:

1. `_setClipDuration` does **not** self-resolve overlaps the way `importMGT` does — setting
   `clip.end` past the next clip's start silently produces overlapping, corrupted track items,
   with no error and no trim. See step 4 and the Traps section below.
2. A fatal ExtendScript exception (confirmed trigger: an out-of-range track index) skips
   `try`/`catch` entirely and aborts the whole script, which would leave `app.endUndoGroup()`
   uncalled if it happens inside the undo group. See step 3.

Note that `VF.insertOne` — which already takes an `atTicks` — is a closer starting point than
`insertBatch`.

## Steps

1. Implement `VS.insertCues` per [08 §6](../08-premiere-host-api.md), taking `mogrtPath`,
   `trackIndex`, `mapping` and a sorted `cues[]`.
2. **Assert the input contract** — cues sorted ascending by `atTicks` — and return the
   [08 §9](../08-premiere-host-api.md) error rather than silently misbehaving. The panel sorts;
   the host verifies.
3. **Validate everything that can be validated — trackIndex against
   `seq.videoTracks.numTracks`, every cue's `atTicks`/`durationTicks` are well-formed digit
   strings — *before* `app.beginUndoGroup()` is called.** A fatal (uncatchable) ExtendScript
   exception from an invalid argument will skip the per-cue `try`/`catch` and abort the whole
   script, leaving `endUndoGroup()` never called and the undo group stuck open for the rest of
   the Premiere session. Only once inputs are known-valid, wrap the batch in **one** undo group:
   `app.beginUndoGroup("VerseSync: Insert scriptures")` … `endUndoGroup()`, with each call
   individually try-wrapped as VerseFlow does.
4. Per cue, reuse VerseFlow's proven sequence:
   ```javascript
   var clip = seq.importMGT(mogrtPath, cue.atTicks, trackIndex, 0);
   var mgt  = clip.getMGTComponent();
   _setTextField(mgt, mapping.referenceIndex, cue.reference);
   _setTextField(mgt, mapping.bodyIndex,      cue.body);
   _setClipDuration(clip, cue.durationTicks);
   ```
   `_setTextField` and `_setClipDuration` come from `VerseFlow.jsx` **unchanged**, including the
   `fontTextRunLength` write.
5. **Isolate failures.** A failing cue is recorded and the loop continues. Unlike VerseFlow
   there is no running cursor to advance, so one failure cannot shift anything else — do not
   copy `insertBatch`'s cursor-advance pattern.
6. Read back `actualStartTicks` from each inserted clip. If Premiere placed it elsewhere, the
   panel finds out rather than assuming.
7. Dispatch per-cue progress via `CSXSEvent` type **`com.versesync.progress`**.
8. Implement `VS.validateTrack` ([08 §8](../08-premiere-host-api.md)): given ranges, report
   existing clips that would be overwritten, so the panel can warn *"3 of your cues will
   overwrite existing clips on V3"* before anything happens.

## Files

- `panel/jsx/VerseSync.jsx` (extended)

## Done when

- [ ] 20 cues land at **20 distinct absolute times**, with correct text in both fields and
      correct durations.
- [ ] **One Ctrl+Z removes all of them.**
- [ ] A deliberately broken cue is reported in `results` and the rest still land.
- [ ] Unsorted input is rejected with the specified message.
- [ ] `actualStartTicks` is read back and matches the request (or the mismatch is reported).
- [ ] `validateTrack` correctly reports conflicts on a populated track.

## Traps

- **Omitting `fontTextRunLength` is the single most common cause of silent failure** in the
  MOGRT text write — documented in VerseFlow's research. It must be written alongside
  `textEditValue`.
- The host does **not** re-snap times. `atTicks` and `durationTicks` arrive already
  frame-snapped from `timemap.js` ([08 §6](../08-premiere-host-api.md)).
- `_setClipDuration` writes `clip.end` without moving `clip.start`, and — confirmed by T-03 —
  **does not trim or resolve a collision the way `importMGT` does.** If a cue's `durationTicks`
  would push `end` past the next clip's start (another VerseSync cue, or an unrelated
  pre-existing clip), the result is two silently overlapping, corrupted track items with no
  error raised. `durationTicks` must already be clamped to fit before the next clip by the
  overlap-resolution logic in `timemap.js` ([08 §10](../08-premiere-host-api.md)) — this cannot
  be caught or fixed on the host side, so the guarantee has to hold before `VS.insertCues` is
  ever called.
- No time math, no scripture knowledge, no HTTP, no persistence in the host
  ([08 §10](../08-premiere-host-api.md)).
