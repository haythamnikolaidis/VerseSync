# Running the T-03 spike through VerseFlow's debug panel

No separate CEP extension needed. VerseFlow is already registered in debug
mode on this machine (`PlayerDebugMode=1` for CSXS.11/12, debug port `7778`
in its `CSXS/manifest.xml`), and its panel already loads `CSInterface.js` +
`bridge.js`. We piggyback on that process: load `spike.jsx` into the same
ExtendScript engine with `$.evalFile()`, then drive it from the panel's own
`window.VFBridge.call()`.

`spike.jsx` does not touch or depend on `VF.*` — nothing in the VerseFlow
repo needs to change.

## One-time setup per Premiere session

1. Open Premiere with the test project (`assets/test/sermon`) and the
   populated V1–V3 test sequence active (see main spike guide / T-03 steps).
2. `Window > Extensions > VerseFlow` to open the panel.
3. In Chrome, go to `http://localhost:7778`, click through to the VerseFlow
   panel's inspectable page. This opens a normal Chrome DevTools window
   attached to the panel's JS context.
4. In the DevTools **Console**, load the spike file into the ExtendScript
   engine (adjust the path if your checkout isn't at this location):

   ```js
   var cs = new CSInterface();
   cs.evalScript(
     "$.evalFile('D:/Development/Personal/VerseSync/spikes/absolute_insert/spike.jsx')",
     function (r) { console.log('loaded:', r); }
   );
   ```

5. Confirm it loaded:

   ```js
   VFBridge.call('spikePing', {}).then(console.log);
   // → { pong: true, file: 'spike.jsx' }
   ```

   Re-run step 4 any time you edit `spike.jsx` — `$.evalFile` re-executes and
   redefines the `var spikeXxx = function(){}` bindings in place.

## Per-test-case snippets

First, check how many tracks the sequence actually has — `importMGT`/track
lookups with an out-of-range `trackIndex` throw a fatal ExtendScript
exception that no `try/catch` can intercept, which surfaces as the opaque
`"EvalScript error."` / `"... threw an ExtendScript error"` message instead
of a clean `spikeErr(...)` response. If you see that, this is the first thing
to check:

```js
VFBridge.call('spikeTrackCounts', {}).then(console.log);
// → { videoTrackCount: N, audioTrackCount: M }
```

Tracks are zero-indexed: **V3 is `trackIndex: 2`, not `3`.** Valid range is
`0` to `videoTrackCount - 1`.

Second, **never hand-compute tick values.** Premiere's internal ticks are a
fixed 254,016,000,000 per second, independent of frame rate — deriving them
from a frame count/fps by hand is exactly the kind of arithmetic slip that
produces a malformed tick string, and a malformed tick string handed to
`importMGT`/`Time.ticks` is a plausible cause of the same uncatchable fatal
crash as an out-of-range track index. Always get ticks from
`spikeSecondsToTicks` or by reading them back from `spikeSnapshotSequence`:

```js
VFBridge.call('spikeSecondsToTicks', { seconds: 120 }).then(console.log);
// → { ticks: "30481920000000" }  (00:02:00, any frame rate)
```

Set these two once per Premiere session (copy the real `.mogrt` path and a
video track index that has clips on it, confirmed against
`spikeTrackCounts` above):

```js
var MOGRT = 'D:/Development/Personal/VerseSync/assets/test/AV_Quote_04.mogrt';
var TRACK = 2; // V3, zero-indexed — confirm against spikeTrackCounts first
```

**Step 1 — baseline snapshot** (run before every case below):

```js
var before;
VFBridge.call('spikeSnapshotSequence', {}).then(function (d) { before = d; console.log(before); });
```

**Step 2 — insert at 00:02:00 on a populated track:**

```js
VFBridge.call('spikeSecondsToTicks', { seconds: 120 }).then(function (r) {
  return VFBridge.call('spikeInsertAt', { mogrtPath: MOGRT, trackIndex: TRACK, atTicks: r.ticks });
}).then(console.log);

VFBridge.call('spikeSnapshotSequence', {}).then(function (after) {
  VFBridge.call('spikeDiffSnapshots', { before: before.clips, after: after.clips }).then(console.log);
});
```

`spikeDiffSnapshots` returns `changedTracks`: the full before/after clip list
for any track whose contents changed at all (grouped by track, not matched
by clip name — this project has many same-named clips, so a name-keyed match
silently hides real changes). Your target track should be the only entry;
anything else appearing means something rippled onto a track you didn't
touch. Read the before/after lists directly to see trim vs. split vs. push.

**Step 3 — repeat on an empty track, and past the sequence end:**
Same `spikeInsertAt` call with a different `trackIndex` (one with no clips)
and then with `atTicks` beyond `before.sequenceEndTicks`.

**Step 4 — `_setClipDuration` into a neighbour:**

```js
// trackIndex/clipIndex from the snapshot above — pick a clip that has a
// neighbour right after it on the same track.
VFBridge.call('spikeExtendClipDuration', {
  trackType: 'video', trackIndex: TRACK, clipIndex: 1, durationTicks: '500000000000'
}).then(console.log);
```

**Step 5 — 20 cues, out of order then descending:**

```js
function buildCues(atTicksArray) {
  return atTicksArray.map(function (t, i) { return { id: 'cue_' + i, atTicks: String(t) }; });
}

// out of order — shuffle the array before calling
VFBridge.call('spikeInsertBatch', { mogrtPath: MOGRT, trackIndex: TRACK, cues: buildCues([...]) })
  .then(console.log);

// descending — sort atTicksArray descending before calling
```

**Step 6 — readback vs. requested** is already in every result above as
`actualStartTicks` / `actualEndTicks` next to `requestedAtTicks`.

## After each case

- The spike functions do **not** wrap calls in an undo group (on purpose —
  `importMGT`'s failure mode here is a fatal ExtendScript exception that
  skips any `catch`, which would leave `app.endUndoGroup()` never called and
  pile up unbalanced groups until Premiere's undo manager chokes on
  everything, including trivially-valid inserts). Undo manually in Premiere
  (`Ctrl+Z`) between cases. If calls start failing across the board for no
  apparent reason, run `VFBridge.call('spikeFlushUndoGroups', { count: 30 })`
  first before assuming it's a real finding.
- Transcribe the finding into `RESULTS.md` immediately; don't rely on
  DevTools console scrollback.
