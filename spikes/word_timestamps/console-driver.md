# Extracting T-02's ground-truth candidates from the edited sermon

T-02 step 1 asks you to hand-label the start time of 30 scripture mentions,
to the frame, against the audio. This tool does **not** replace that — it
reads the timestamps and reference text the editor already placed as
scripture lower-thirds in the finished Premiere edit, so you start from a
sorted candidate list instead of scrubbing 45 minutes of audio from zero.
You still confirm (and nudge to the exact frame) each one against the raw
sermon audio, per the spike's own trap: *"Label against the audio, not
against a transcript."* A placed graphic can be off from the true word onset
by design — VerseSync's own spec gives graphics a 0.5s lead-in before the
anchor (`docs/05-timing-and-placement.md` §2) — so treat every row below as
a candidate to confirm, not a finished label.

**Sequence time vs. source time** (`docs/05-timing-and-placement.md` §1):
every timestamp out of Premiere is relative to the *sequence* (tick 0 =
start of the edited timeline). The raw sermon audio file is in *source*
time — seconds from the start of that file. These are only the same number
if nothing was trimmed off the front or cut out of the middle during
editing — confirmed false on this project's sermon, which has a long stretch
of silence trimmed off the front of the raw file. Step 2 below resolves this
per cue via the audio clip's `inPoint`, rather than assuming one constant
offset, because an edit with any internal cuts would make the offset vary
cue to cue.

Same approach as `spikes/absolute_insert` and `spikes/media_segments`: no
separate CEP extension. Load `spike.jsx` into VerseFlow's already-running
ExtendScript engine with `$.evalFile()`, drive it with the panel's own
`window.VFBridge.call()`. Functions here are prefixed `wt` (word timestamps)
so they coexist with the other spikes' functions in the same engine.

This spike is **read-only** except for `wtSetPlayhead`, which only moves the
playhead — none of `absolute_insert`'s undo-group hazards apply.

## One-time setup per Premiere session

1. Open Premiere with your edited sermon project and its sequence active.
2. `Window > Extensions > VerseFlow` to open the panel (skip if already open).
3. In Chrome, go to `http://localhost:7778`, open the VerseFlow panel's
   DevTools.
4. Load the spike file:

   ```js
   var cs = new CSInterface();
   cs.evalScript(
     "$.evalFile('D:/Development/Personal/VerseSync/spikes/word_timestamps/spike.jsx')",
     function (r) { console.log('loaded:', r); }
   );
   VFBridge.call('wtPing', {}).then(console.log);
   // → { pong: true, file: 'word_timestamps/spike.jsx' }
   ```

   Re-run the `evalFile` line any time you edit `spike.jsx`.

## Working with multiple open sequences

Same caveat as the other spikes: don't rely on `app.project.activeSequence`
or on setting it sticking across separate `evalScript` round-trips. List
sequences once and pass the index explicitly:

```js
VFBridge.call('wtListSequences', {}).then(console.log);
VFBridge.call('wtGetSequenceInfo', { sequenceIndex: 0 }).then(console.log);
```

Omit `sequenceIndex` to fall back to whatever `activeSequence` currently
resolves to (fine for a single-sequence session).

## Step 1 — sanity-check the timeline

Before trusting the filtered walk, see what's actually on the timeline and
which clips it thinks have a Motion Graphics component:

```js
VFBridge.call('wtWalkSequenceClips', {}).then(function (r) {
  console.log(r);
  // copy(r) if Chrome truncates it
});
```

Check `hasMGTComponent` on the rows you know are scripture graphics — if it
comes back `false` or an `ERROR: ...` string for clips you can see are
lower-thirds, something about this project's component structure differs
from what this script assumes. Stop here and report what `wtDumpClipProperties`
(Step 3 below) shows for one of those clips before going further.

## Step 2 — find the raw-audio track, then pull the scripture graphics

First, find which audio track actually holds the raw sermon audio (by name
or `mediaPath`):

```js
VFBridge.call('wtWalkAudioClips', {}).then(console.log);
```

Note its `trackIndex`. Then pull the graphics, passing that index so each
one's `sourceSeconds` (raw-file time, not sequence time) gets resolved:

```js
VFBridge.call('wtWalkScriptureGraphics', { audioTrackIndex: 0 }).then(function (r) {
  console.log(r);
  copy(r); // clipboard — paste into a file, see "Building the timing file" below
});
```

If your sermon audio has internal cuts across *multiple* clips on that
track, nothing extra is needed — each graphic is resolved against whichever
clip actually contains it, so the offset is computed per cue, not assumed
constant. If a graphic's `sourceResolved` comes back `false` (check
`sourceResolutionNote`), it likely sits in a gap or exactly on a cut
boundary — `wtMapTicksToSource({ atTicks, audioTrackIndex })` is useful for
investigating that one timestamp in isolation.

Each entry has `startSeconds`/`endSeconds` (sequence time — don't use these
for Audacity), `sourceSeconds`/`sourceResolved` (source/raw-file time — this
is what matters), raw ticks, and `textFields` — the
best-effort extracted reference text per MGT text property. For each entry,
check `textFields`:

- If a field's `guess` is a clean string (e.g. `"John 3:16"`), that's your
  reference.
- If `guess` is `null`, read `raw` — the automated parse didn't recognize the
  shape (possibly a Premiere-authored "Type tool" MOGRT rather than an
  AE-authored one — VerseFlow's research notes these as a different,
  unsupported shape), but the actual value is in there for you to read by eye.
- If `textFieldsError` is set, or `textFields` is empty for a clip you know
  has visible text, move to Step 3 on that one clip.

## Step 3 — diagnose a clip whose text didn't parse

```js
VFBridge.call('wtDumpClipProperties', {
  trackType: 'video', trackIndex: 2, clipIndex: 5
}).then(console.log);
```

Unfiltered dump of every property on that clip's MGT component — `propertyType`,
`isGroupMarker`, `looksLikeText`, and the raw `value`.

**Already confirmed on this project's "Quotes | Imocean" template:**
`prop.propertyType` comes back `undefined` for every property (a Premiere/
template-version difference from whatever VerseFlow was originally built
against). Detection therefore runs primarily on the *shape* of `getValue()`
rather than `propertyType` — see the file-header comment and `wtIsTextLeaf`/
`wtIsGroupMarker` in `spike.jsx`. `propertyType` is still included in the
dump and kept as a secondary check in case a different template exposes it.

If `looksLikeText` is still `false` for a property you can see clearly holds
text, check its raw `value` here directly: a text leaf's value should be a
JSON string with a `.textEditValue` field containing the plain text. If the
value doesn't have that shape at all, this is a genuinely different MOGRT
authoring style (see the "Type tool" MOGRT caveat in
`docs/planning/02-adobe-research.md` §3 in the VerseFlow repo) and is worth
flagging as its own finding rather than a bug in this tool.

**Observed pattern on this project's template** (confirmed from a real dump):
each quote's two text fields sit under two group headers — `Title Main`
(the body/quote text) immediately followed by its `Text` field, then
`Description` (the citation, e.g. `"Micah 7:8 (NKJV)"`) immediately followed
by its `Text` field. `wtWalkScriptureGraphics`' `group`/`label` fields let you
tell these apart without hardcoding index numbers — but don't assume every
template in this project uses the same two group names; check each distinct
template once via this diagnostic if results look off.

## Step 4 — confirm each candidate against the raw audio, in Audacity

Hand-converting ticks/frames to seconds for 30+ rows by hand is exactly the
kind of thing that silently introduces the error T-02 is trying to measure
in the first place — so this step uses Audacity's label track instead of a
spreadsheet. `to_audacity.js`/`from_audacity.js` are plain Node scripts, no
install step beyond Node itself.

1. Save the Step 2 clipboard dump to a file, e.g.
   `spikes/word_timestamps/graphics_raw.json` (paste exactly what `copy(r)`
   gave you — the script accepts the bare `{graphics:[...]}` shape, the full
   `{ok,data:{graphics:[...]}}` bridge envelope, or a raw array).

2. Convert it to an Audacity label file:

   ```
   node spikes/word_timestamps/to_audacity.js spikes/word_timestamps/graphics_raw.json spikes/word_timestamps/labels.txt
   ```

   Each label is `#N <Title Main guess>` — the quote's **body text**, not
   its citation, per the point of this exercise: in Audacity you're matching
   what's actually spoken, and the reference text often isn't read aloud
   verbatim. Read the console output — it flags any clip whose body text
   couldn't be auto-parsed (`[NO-TEXT]` in the label) so you know which ones
   to sanity-check by eye before relying on them.

3. In Audacity: open the raw sermon audio file, then
   `File > Import > Labels...` and pick `labels.txt`. Each label now sits as
   a point marker on the label track, named with the quote text, at the
   graphic's start time **resolved into the raw file's own time** (not the
   sequence time) — so it should already land close to the right spot in
   the waveform, modulo the lead-in/judgement caveat above.

4. For each label: listen around it, find the actual word onset of the
   mention, and drag the label point there — to the sample, which is finer
   than Premiere's frame grid, so this is strictly more precise than nudging
   in Premiere. Add new point labels by hand for paraphrased mentions if any
   turn out not to have a graphic at all (type whatever text helps you
   remember what it is — it doesn't need a `#N` prefix, see step 6).

5. `File > Export > Export Labels...` when done, e.g. to
   `spikes/word_timestamps/labels_edited.txt`.

6. Convert the edited labels back into T-02's ground-truth CSV:

   ```
   node spikes/word_timestamps/from_audacity.js spikes/word_timestamps/labels_edited.txt spikes/word_timestamps/labels.meta.json spikes/word_timestamps/ground_truth.csv
   ```

   (`labels.meta.json` is written alongside `labels.txt` by step 2 — it's
   what lets a label you merely nudged, or even fully retyped, still
   round-trip back to its real scripture reference via the `#N` prefix. A
   label with no `#N` prefix — anything you added fresh in Audacity — comes
   out as `source=manual` with `reference` left blank for you to fill in by
   hand.)

   Add `--fps 29.97` (your sequence's actual frame rate, from
   `wtGetSequenceInfo`) if you also want a `start_timecode_hint` column for
   jumping back into Premiere later — optional, since `start_seconds` is
   what T-02's actual error measurement uses.

Output columns: `index,reference,start_seconds,start_timecode_hint,source,confirmed,notes`.
`confirmed` is always `true` here, because this file only exists once you've
listened to and placed every point by ear — that's what makes it the actual
ground truth, not the raw graphic-seeded candidate list. Check `notes` for
anything flagged `reference not auto-parsed` or `no "#N" prefix` — those
need a reference filled in by hand before this file is complete.

This file is the input to T-02 step 3 (measuring p50/p90 error of matched
word starts against these labels) — that comparison script and `RESULTS.md`
are separate follow-on work, not part of this extraction tool.
