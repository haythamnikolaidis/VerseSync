# T-45 · Fake Premiere DOM for host unit tests

| | |
|---|---|
| **Workstream** | 0 — Agent enablement |
| **Unblocks** | T-23, T-24, T-25 |
| **Spec** | [08-premiere-host-api.md](../08-premiere-host-api.md) · `spikes/absolute_insert/RESULTS.md` · `spikes/media_segments/RESULTS.md` |

## Goal

Run `panel/jsx/VerseSync.jsx` under Node against a scriptable fake of the slice of Premiere's
ExtendScript DOM that VerseSync touches. That way, an agent can build and test the host layer
with no Premiere at all.

## Context

[11 §5](../11-testing.md) says the host layer "cannot be automated". That's true for *Premiere*,
but it isn't true for *our logic*. The input validation, the sorted-cue assertion, the
null-`projectItem` guard, the speed routing, path normalisation and undo-group balance are all
plain ES3. A fake DOM, built from the behaviour the spikes **measured**, catches the bugs those
spikes were run to find. Real-Premiere confirmation stays with T-25.H.

The fake has to reproduce the **spike findings**, not ideal behaviour:

| Finding (source) | Fake behaviour |
|------------------|----------------|
| `importMGT` overwrites and trims overlapped clips from the encroached edge, regardless of order (T-03) | `track.importMGT` trims neighbours the same way |
| `_setClipDuration` (`clip.end = …`) does **not** resolve overlaps (T-03) | Setting `end` can leave overlapping items. The fake exposes `track.overlaps()` so tests can assert this never happens. |
| An out-of-range track index is a *fatal* error that skips `try`/`catch` (T-03) | Accessing `videoTracks[n]` out of range throws a `FatalHostError`, which the loader rethrows past the script's own `catch`, and the fake records that the undo group was left open |
| `clip.projectItem === null` on some real clips (T-04) | Supported per clip. Chaining off it throws. |
| Nested and multicam clips: `projectItem` present, `getMediaPath()` returns `""` (T-04) | Supported per clip |
| Speed-changed clips: `getSpeed()` returns the real multiplier and in/out are garbage (T-04) | Supported per clip |
| `activeSequence` follows UI focus between calls (R-13) | `fake.focusSequence(id)` changes `app.project.activeSequence` |

## Subtasks

### T-45.1 · JSX loader, sequence/track/clip model

**Executor** agent · **Size** S · **Prereqs** T-43 · **Status** done

- **Read:** [08 §1, §3, §4](../08-premiere-host-api.md) · `spikes/media_segments/RESULTS.md`
  (the results table only) · `reference/verseflow/jsx/VerseFlow.jsx` (grep for the
  `app.project`, `activeSequence`, `getPlayerPosition` and `setPlayerPosition` call sites only)
- **Touches:** `tests/lib/load-jsx.js` (new) · `tests/lib/fake-premiere.js` (new) ·
  `tests/host/fake-premiere.test.js` (new)
- **Interface:**
  ```javascript
  // load-jsx.js
  loadJsx(jsxPath, fake) -> { VS, context }   // vm.runInNewContext with globals app, $, CSXSEvent, File
  // fake-premiere.js
  createFakePremiere() -> fake
  fake.addSequence({ id, name, timebase, zeroPointTicks, endTicks, videoTracks, audioTracks }) -> seq
  fake.addClip(seq, 'video'|'audio', trackIndex, { name, startTicks, endTicks, inPointTicks,
               mediaPath, projectItem: true|false, speed }) -> clip
  fake.focusSequence(id); fake.undoLog  // ['begin:<name>', 'end', ...]
  ```
- **Steps:**
  1. Write `load-jsx.js`. It reads the file, checks that it's ASCII-only (and throws a clear
     error if not), and evaluates it in a fresh `vm` context. The context hides the `JSON`
     global, to match the engine, so the script's polyfill is what gets exercised. Commit.
  2. Write `fake-premiere.js` with the sequence, track, clip and projectItem model:
     `sequence.sequenceID`, `name`, `timebase`, `zeroPoint`, `end`, `getPlayerPosition()` and
     `setPlayerPosition(ticks)`; tracks with `clips[]` and `numTracks`; clips with `start`,
     `end` and `inPoint` as `{ticks: string}`, `name`, `projectItem`, and `getSpeed()`. Add
     every row of the table above that concerns these objects. Commit.
  3. Write tests that pin each table row down. Commit.
- **Verify:** `node --test tests/host/fake-premiere.test.js`
- **Done when:**
  - [x] A trivial JSX file (written inline in the test) loads, and it sees `app`, `$` and no
        native `JSON`.
  - [x] The null-projectItem, nested/multicam and speed-change behaviours each have a test.
  - [x] `focusSequence` changes what `app.project.activeSequence` returns.

### T-45.2 · `importMGT`, MGT components, undo groups, CSXS events

**Executor** agent · **Size** S · **Prereqs** T-45.1 · **Status** in-progress

- **Read:** [08 §5, §6](../08-premiere-host-api.md) · `spikes/absolute_insert/RESULTS.md`
  (the results and risks sections) · `reference/verseflow/jsx/VerseFlow.jsx` (the
  `getMogrtFields`, `_setTextField` and `_setClipDuration` bodies only)
- **Touches:** `tests/lib/fake-premiere.js` · `tests/host/fake-premiere.test.js`
- **Steps:**
  1. Add `sequence.importMGT(path, ticks, vTrackIndex, aTrackIndex)`. It returns a clip, or
     `null` when `fake.failImportFor(path)` is set. It trims overlapped clips the way T-03
     measured. Add `clip.getMGTComponent()`, which returns `{properties}` built from a template
     registered with `fake.registerMogrt(path, fields)`. Give the `AV_Quote_04` template two
     `Text` fields in groups `Title Main` and `Description`, with property types and group
     nodes matching what VerseFlow's `getMogrtFields` walks (types 10/4 for groups, 6/5 for
     text). The property `getValue`/`setValue` must store the JSON string, so that
     `textEditValue` and `fontTextRunLength` can be asserted. Commit.
  2. Add `app.beginUndoGroup` and `app.endUndoGroup`, which write to `fake.undoLog`.
     `fake.openUndoGroups()` returns the imbalance. Make `clip.end = {ticks}` assignable,
     without any overlap resolution. Add `CSXSEvent` with a `dispatch()` that records to
     `fake.events`. Make out-of-range `videoTracks[n]` throw `FatalHostError`. Commit.
  3. Write tests for each behaviour, including one where an overlap left by `clip.end` is
     visible through `track.overlaps()`. Commit.
- **Verify:** `node --test tests/host/fake-premiere.test.js`
- **Done when:**
  - [ ] `importMGT` overwrite/trim matches T-03's single-overlap case in a test.
  - [ ] `fontTextRunLength` and `textEditValue` written through `setValue` can be read back.
  - [ ] An undo-group imbalance can be detected.
  - [ ] An out-of-range track access is uncatchable by script `try`/`catch`. A test shows the
        error still reaches the Node caller.

## Traps

- **Don't invent behaviour the spikes didn't measure.** Where the spikes are silent, make the
  fake strict: throw `NotModelled` rather than guessing. That way a test can't pass on a fiction.
- The fake is test code. Keep it under `tests/lib/`, never in `panel/`.
