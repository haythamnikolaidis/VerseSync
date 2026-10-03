# Running the T-04 spike through VerseFlow's debug panel

Same approach as `spikes/absolute_insert`: no separate CEP extension. Load
`spike.jsx` into VerseFlow's already-running ExtendScript engine with
`$.evalFile()`, drive it with the panel's own `window.VFBridge.call()`.

This spike is **read-only** — it only reads clip properties, never mutates
the timeline — so none of `absolute_insert`'s undo-group hazards apply.
Functions here are prefixed `ms` (media segments) rather than `spike`, so
both spikes' functions can coexist in the same engine without colliding if
you don't reload the panel between them.

## One-time setup per Premiere session

1. Open Premiere with the test project and a sequence active.
2. `Window > Extensions > VerseFlow` to open the panel (skip if already
   open from a previous spike).
3. In Chrome, go to `http://localhost:7778`, open the VerseFlow panel's
   DevTools.
4. Load the spike file:

   ```js
   var cs = new CSInterface();
   cs.evalScript(
     "$.evalFile('D:/Development/Personal/VerseSync/spikes/media_segments/spike.jsx')",
     function (r) { console.log('loaded:', r); }
   );
   VFBridge.call('msPing', {}).then(console.log);
   // → { pong: true, file: 'media_segments/spike.jsx' }
   ```

   Re-run the `evalFile` line any time you edit `spike.jsx`.

## Working with multiple open sequences

**Do not rely on `app.project.activeSequence` tracking which sequence tab
has UI focus, and do not rely on `msSetActiveSequence` sticking either** —
confirmed empirically: setting it is visible within that same call, but
reverts by the next, separate `evalScript` round-trip (Premiere's UI tab
focus reasserts itself in between). Instead, list sequences once and pass
the index explicitly to every call:

```js
VFBridge.call('msListSequences', {}).then(console.log);
// find your target sequence's index, then:
VFBridge.call('msWalkSequence', { sequenceIndex: 5 }).then(console.log);
VFBridge.call('msClipsOnTrack', { trackType: 'video', trackIndex: 0, sequenceIndex: 5 }).then(console.log);
VFBridge.call('msTimeWalk', { sequenceIndex: 5 }).then(console.log);
```

Omit `sequenceIndex` to fall back to whatever `activeSequence` currently
resolves to (fine for a single-sequence session; unreliable the moment more
than one sequence is open).

## Step 1 — build the eight test constructs

T-04 needs one clip of each of these on the test sequence, their
`trackType`/`trackIndex`/`clipIndex` noted as you create them so you can
match each one to `msWalkSequence`'s output afterward:

1. A straight cut (plain, untrimmed) — likely already present.
2. A trimmed clip (non-zero in-point) — trim an existing clip's head in the
   Premiere timeline.
3. The same source media used **twice** in the sequence.
4. A **detached audio** clip — audio from a different file than the video
   it's synced to (ask whether the real sermon ingest has this per Q-D; if
   not, fake one by placing an unrelated audio clip under a video clip).
5. A **speed-changed** clip — right-click a clip → Speed/Duration, set
   anything other than 100%.
6. A **merged clip** — select two+ clips in the Project panel →
   right-click → Merge Clips, then cut the merged clip into the sequence.
7. A **multicam clip** — if the project has camera angles to multicam; if
   not, this may need to be skipped and noted as untested rather than faked
   (multicam setup is heavier than the others).
8. A **nested sequence** — drag an existing sequence into this one as a
   clip.

Not all of these may be feasible to construct by hand in a short session —
if any are skipped, say so explicitly in `RESULTS.md` rather than leaving
the row blank.

## Step 2 — walk the sequence

```js
VFBridge.call('msWalkSequence', {}).then(function (r) {
  console.log(r);
  // if Chrome truncates it: copy(r) copies the full JSON to your clipboard
});
```

For each construct above, find its entry by `trackType`/`trackIndex`/
`clipIndex` and record in `RESULTS.md`:

- `mediaPath` — did it resolve to a real file path, come back empty, or
  `"ERROR: ..."`?
- `speed` — does it read `1.0` for normal clips and something else for the
  speed-changed one?
- `inPointTicks` — non-zero for the trimmed clip?
- `projectItemType` / `projectItemIsSequence` — does this reliably
  distinguish a nested sequence from ordinary footage?

To check one construct in isolation instead of the whole dump:

```js
VFBridge.call('msClipsOnTrack', { trackType: 'video', trackIndex: 0 }).then(console.log);
```

## Step 3 — path-format normalisation

Pull a few real `mediaPath` values out of the Step 2 walk and resolve them:

```js
VFBridge.call('msResolvePath', { path: '<a mediaPath from the walk>' }).then(console.log);
```

Note in `RESULTS.md`: forward vs. back slashes as returned, whether any
media is on a UNC path (`\\server\share\...`), and whether drive-letter case
is consistent. This decides the normalisation rule in
[08 §4](../../docs/08-premiere-host-api.md).

## Step 4 — timing

```js
VFBridge.call('msTimeWalk', {}).then(console.log);
// → { elapsedMs: N, clipCount: M }
```

Run this on the longest/most complex sequence available — 08 §4 requires
one walk per request, not one per cue, so this number is what every
`VS.getMediaSegments` call actually costs.

## Writing up

Fill in `RESULTS.md`'s table and the two required statements (path rule,
walk-time) directly from the above. Per the gate, anything that didn't
resolve needs to land in T-24's planned `unsupported` array — note that
explicitly for each construct that failed.
