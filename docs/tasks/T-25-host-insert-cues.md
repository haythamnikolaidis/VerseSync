# T-25 · Host: `VS.insertCues` + `VS.validateTrack`

| | |
|---|---|
| **Workstream** | G — Host (ExtendScript) |
| **Unblocks** | T-30 |
| **Spec** | [08-premiere-host-api.md §6, §8, §9](../08-premiere-host-api.md) · [`spikes/absolute_insert/RESULTS.md`](../../spikes/absolute_insert/RESULTS.md) |

## Goal

Place one MOGRT instance per cue, each at its own **absolute** time, with both text fields
filled, all inside a **single undo group**. This is the function VerseSync exists to call.

## Context

✅ T-03 confirmed that `importMGT` **overwrites** rather than ripples, so the design in 08 §6
stands as written. T-03 also found two hazards that this epic must design around:

1. **`_setClipDuration` doesn't resolve overlaps.** Setting `clip.end` past the next clip's
   start silently corrupts the track. The panel's `timemap.js` (T-28.3) guarantees the duration
   fits *before* the host is called. The host can't fix this.
2. **Fatal ExtendScript errors skip `try`/`catch`.** One confirmed trigger is a track index out
   of range. If that happens inside the undo group, `endUndoGroup()` never runs. So **every
   validation happens before `beginUndoGroup()`**.

`VF.insertOne`, which already takes an `atTicks`, is a closer starting point than `insertBatch`.

## Subtasks

### T-25.1 · `insertCues` input validation (everything before the undo group)

**Executor** agent · **Size** S · **Prereqs** T-23.2 · **Status** in-progress

- **Read:** [08 §6](../08-premiere-host-api.md) (the "Contract" bullets) · [08 §9](../08-premiere-host-api.md) ·
  the T-03 risks section
- **Touches:** `panel/jsx/VerseSync.jsx` · `tests/host/insert-validation.test.js` (new)
- **Steps:**
  1. Write `_validateInsertArgs(args, seq)`, which returns an error string or `null`. It checks:
     - `sequenceId` matches (D20);
     - `trackIndex` is an integer in `[0, seq.videoTracks.numTracks)`; if not, return
       `Track V{n} no longer exists in this sequence. Click Refresh.`;
     - `mogrtPath` is non-empty;
     - `mapping.referenceIndex` and `mapping.bodyIndex` are integers and are different;
     - every cue's `atTicks` and `durationTicks` match `/^\d+$/`, and `durationTicks > 0`;
     - the cues are sorted ascending by `atTicks`; if not, return the §9 "unsorted" message.

     `VS.insertCues` calls this function and returns `_err` **before** any undo group is
     opened. Commit.
  2. Tests, one per rule. Each asserts the exact message **and** that `fake.undoLog` is empty.
     Include an out-of-range track, which must be rejected *before* any `videoTracks[n]` access,
     so the fake's `FatalHostError` is never triggered. Commit.
- **Verify:** `node --test tests/host/insert-validation.test.js`
- **Done when:**
  - [ ] Every invalid input is rejected with no undo group opened and no DOM write made.

### T-25.2 · `insertCues` placement loop

**Executor** agent · **Size** S · **Prereqs** T-25.1 · **Status** todo

- **Read:** [08 §6](../08-premiere-host-api.md) (the per-cue body) ·
  `reference/verseflow/jsx/VerseFlow.jsx` (`_setTextField`, `_setClipDuration`, and the CSXS
  progress dispatch)
- **Touches:** `panel/jsx/VerseSync.jsx` · `tests/host/insert-cues.test.js` (new)
- **Steps:**
  1. Port `_setTextField`, including the `fontTextRunLength` write, and `_setClipDuration`,
     both **unchanged**. Write the loop:
     - open `app.beginUndoGroup("VerseSync: Insert scriptures")`;
     - for each cue, run `importMGT`, `getMGTComponent`, both `_setTextField` calls and
       `_setClipDuration`, each inside its own try block;
     - read `actualStartTicks` back from `clip.start.ticks`;
     - dispatch a `CSXSEvent` of type `com.versesync.progress`, with
       `{index, total, id, ok}`;
     - close the undo group in a `finally`-equivalent: ES3 has try/finally, so use it.

     Return `{results, insertedCount, failedCount}`. A failing cue gets
     `{id, ok:false, error}`, and the loop **carries on**. Don't advance any cursor. Use the §9
     messages for a null `importMGT` result and a null `getMGTComponent` result. Commit.
  2. Tests on the fake:
     - 20 cues land at 20 distinct absolute times, with both fields' `textEditValue` and
       `fontTextRunLength` correct and the durations right;
     - the undo log is exactly one begin/end pair;
     - a cue with a `mogrtPath` that fails import is reported, and the others still land;
     - `actualStartTicks` is echoed back;
     - there are 20 progress events;
     - `track.overlaps()` stays empty when the durations come in pre-clamped.

     Commit.
- **Verify:** `node --test tests/host/insert-cues.test.js`
- **Done when:**
  - [ ] Exactly one undo group, which always closes.
  - [ ] Failures are isolated per cue.
  - [ ] `fontTextRunLength` is written.

### T-25.3 · `VS.validateTrack`

**Executor** agent · **Size** XS · **Prereqs** T-25.1 · **Status** todo

- **Read:** [08 §8](../08-premiere-host-api.md)
- **Touches:** `panel/jsx/VerseSync.jsx` · `tests/host/validate-track.test.js` (new)
- **Steps:**
  1. Write `VS.validateTrack({sequenceId, trackIndex, ranges})`. It runs the same `sequenceId`
     and `trackIndex` checks as T-25.1, before touching the track. For each range, it reports
     every existing clip that overlaps it, as `{rangeIndex, existingClipName}`. Ranges that only
     touch a clip at the boundary don't conflict. Tests: an empty track, a populated track with
     3 conflicts, a clip that only touches a range, and an invalid track. Commit.
- **Verify:** `node --test tests/host/validate-track.test.js`
- **Done when:**
  - [ ] Conflicts are reported correctly on a populated fake track.

### T-25.H · Host verification on real Premiere (covers T-23, T-24, T-25 and D20)

**Executor** human · **Size** — · **Prereqs** T-25.2, T-25.3, T-24, T-22.H · **Status** todo

On the reference workstation, with `AV_Quote_04.mogrt` and the real sermon project, run each
check and record the results in `docs/qa/host-verification.md`:

1. `VS.getSequenceInfo` returns the real `timebase`, and `sequenceId` stays **stable across
   separate `evalScript` calls** (D20's assumption). If it doesn't, raise a contract task.
2. `VS.getMogrtFields` returns both `Text` fields with distinct indices and group-qualified
   labels.
3. `VS.getMediaSegments` reproduces every T-04 case on the real edit, and the walk time is
   recorded.
4. `VS.insertCues` places 20 cues at 20 absolute times with correct text and durations, and
   **one Ctrl+Z** removes all of them.
5. A deliberately broken cue is reported, and the rest still land.
6. Switching sequence tabs between Analyse and Insert produces the D20 message, and nothing is
   inserted.
7. `VS.validateTrack` reports conflicts on a populated track.

## Traps

- **Leaving out `fontTextRunLength` is the most common cause of silent failure** in the MOGRT
  text write.
- The host does **not** re-snap times.
- No time math, no scripture knowledge, no HTTP and no persistence in the host (08 §10).
