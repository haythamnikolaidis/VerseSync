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

⚠️ **Do not start until T-03 has reported.** If `importMGT` ripples rather than overwrites, this
task is written against a fallback instead ([08 §6.1](../08-premiere-host-api.md)): require an
empty track, insert descending, or use VerseFlow's Option B (pre-render +
`overwriteClip`). **Read T-03's `RESULTS.md` first and implement what it found.**

Note that `VF.insertOne` — which already takes an `atTicks` — is a closer starting point than
`insertBatch`.

## Steps

1. Implement `VS.insertCues` per [08 §6](../08-premiere-host-api.md), taking `mogrtPath`,
   `trackIndex`, `mapping` and a sorted `cues[]`.
2. **Assert the input contract** — cues sorted ascending by `atTicks` — and return the
   [08 §9](../08-premiere-host-api.md) error rather than silently misbehaving. The panel sorts;
   the host verifies.
3. Wrap the whole batch in **one** undo group: `app.beginUndoGroup("VerseSync: Insert
   scriptures")` … `endUndoGroup()`, with each call individually try-wrapped as VerseFlow does.
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
- `_setClipDuration` writes `clip.end` without moving `clip.start` — when placing sparsely,
  extending `end` may collide with the next existing clip
  ([02 §1.3](../02-source-project-audit.md)). T-03 characterises this; handle what it found.
- No time math, no scripture knowledge, no HTTP, no persistence in the host
  ([08 §10](../08-premiere-host-api.md)).
