# 08 — Premiere Host API (`VS.*`)

The contract between the panel and Premiere. Everything that touches the Premiere DOM lives
here and nowhere else ([03](03-architecture.md) §7).

**Read VerseFlow's `docs/planning/02-adobe-research.md` before writing any of this** (in the
`haythamnikolaidis/VerseFlow` repository). It carries the sourced API facts — `importMGT`, the
`textEditValue`/`fontTextRunLength` write, ticks, scratch-insert field discovery — that this
document builds on rather than repeats.

---

## 1. Conventions (inherited, non-negotiable)

1. Every function returns a **JSON string**: `{"ok":true,"data":…}` or
   `{"ok":false,"error":"message"}`. **The host never throws across the bridge.**
2. Arguments arrive as a **single JSON string**, parsed inside the host.
3. Everything hangs off one global `VS`.
4. Helpers are `var fn = function(){}`, never `function fn(){}` — `$.evalFile()` does not hoist
   declarations into persistent global scope in Premiere 2026's engine. VerseFlow learned this
   the hard way and documented it at the top of `VerseFlow.jsx`.
5. **One file.** `jsx/VerseSync.jsx` holds everything, including the ES3 JSON polyfill. No
   `#include` — path resolution is unreliable in Premiere 2026.
6. Ticks are passed as **strings** everywhere.
7. The panel calls `VSBridge.loadJSX()` at init to `$.evalFile()` the host explicitly, bypassing
   Premiere's `ScriptPath` cache.

---

## 2. `VS.ping`

```
VS.ping("{}")
→ { ok: true, data: { pong: true, version: "1.0.0", hostApi: "1.0" } }
```

Used for the health check and the version handshake.

---

## 3. `VS.getSequenceInfo`

Extends VerseFlow's version with everything the timing layer needs.

```
VS.getSequenceInfo("{}")
→ { ok: true, data: {
      hasActiveSequence: true,
      name: "Sermon 2026-08-09",
      videoTrackCount: 4,
      audioTrackCount: 6,
      playheadTicks: "355622400000000",
      timebase: "8475667",            // ticks per frame — use this, never a float fps
      frameRate: 29.97,               // display only
      zeroPointTicks: "914457600000000",
      endTicks: "689538816000000"
   } }
```

**`timebase` is the load-bearing field.** All frame snapping ([05](05-timing-and-placement.md)
§7) divides by it. Deriving ticks-per-frame from `frameRate` is wrong for 23.976 and 29.97 and
will produce cumulative drift across a 40-cue batch.

`zeroPointTicks` is for **display timecode only** — see [05](05-timing-and-placement.md) §1.

---

## 4. `VS.getMediaSegments`

**New in VerseSync. Nothing like it exists in VerseFlow.** This is what makes source→sequence
mapping possible (FR-5.5).

```
VS.getMediaSegments('{"mediaPath":"D:/Sermons/SERMON_A001.MXF"}')
→ { ok: true, data: {
      matched: true,
      segments: [
        { trackType: "video", trackIndex: 2,
          seqStartTicks: "0", seqEndTicks: "254016000000000",
          inPointTicks:  "3048192000000",
          durationTicks: "254016000000000",
          speed: 1.0, name: "SERMON_A001.MXF" }
      ],
      unsupported: []
   } }
```

**Implementation:**

```javascript
var seq = app.project.activeSequence;
// walk seq.videoTracks[i].clips[j] and seq.audioTracks[i].clips[j]
//   var pi = clip.projectItem;
//   var path = pi ? pi.getMediaPath() : '';
//   if (normalisePath(path) === normalisePath(target)) → emit a segment
```

Notes and traps:

- **Path normalisation** must handle forward/back slashes, UNC paths, and Windows
  case-insensitivity. Compare normalised lowercase strings.
- **Both video and audio tracks are walked.** The sermon's audio may be a detached audio-only
  clip while the picture comes from a different camera file. A match on either is a valid
  mapping.
- **`clip.getSpeed()`** — any segment with `speed !== 1.0` goes into `unsupported` with a
  reason, and the panel flags affected cues `speed_change_unsupported`
  ([05](05-timing-and-placement.md) §5.3).
- **Merged clips, multicam and nested sequences** have unverified `getMediaPath()` behaviour.
  **Spike T-04** characterises them; whatever is not resolvable is reported in `unsupported`
  so the panel can explain itself rather than silently returning nothing.
- **`matched: false`** with an empty `segments` array means the media is not in this sequence at
  all — the panel then offers the manual-offset fallback ([05](05-timing-and-placement.md) §5.4).

Performance: a long sequence can hold thousands of track items. Walk once, build the list,
return. Do not call this per cue.

---

## 5. `VS.getMogrtFields`

**Reused from VerseFlow essentially unchanged** — insert one instance past the end of the
sequence inside an undo group, enumerate `mgt.properties`, remove it.

```
VS.getMogrtFields('{"path":"D:/Templates/AV_Quote_04.mogrt"}')
→ { ok: true, data: { fields: [
      { index: 3,  name: "Text", group: "Title Main",  label: "Title Main > Text" },
      { index: 11, name: "Text", group: "Description", label: "Description > Text" }
   ] } }
```

Keep all three detection strategies (`propertyType === 6`, `=== 5`, then a `getValue()` probe
for `textEditValue`) and the group-node handling for types `10` and `4`. Keep the
open-sequence error message. **Keep index-based targeting** — the reference template has two
fields both named `Text`, so display names are ambiguous (VerseFlow risk R7).

---

## 6. `VS.insertCues`

**The function VerseSync exists to call.** Replaces VerseFlow's `insertBatch`: cues carry
absolute times instead of being laid end to end from the playhead.

```json
{
  "mogrtPath": "D:/Templates/AV_Quote_04.mogrt",
  "trackIndex": 2,
  "mapping": { "referenceIndex": 11, "bodyIndex": 3 },
  "cues": [
    { "id": "cue_014", "atTicks": "358996428390000", "durationTicks": "6878765400000",
      "reference": "1 Corinthians 6:19-20 (KJV)", "body": "19 What? know ye not…" }
  ]
}
```

```
→ { ok: true, data: {
      results: [ { id: "cue_014", ok: true, actualStartTicks: "358996428390000" } ],
      insertedCount: 17, failedCount: 0
   } }
```

**Contract:**

- `cues` **must** arrive sorted ascending by `atTicks`. The panel sorts; the host asserts and
  errors rather than silently misbehaving.
- `atTicks` and `durationTicks` are already **frame-snapped** by the panel. The host does not
  re-snap.
- Everything is wrapped in **one undo group** — `app.beginUndoGroup("VerseSync: Insert
  scriptures")` … `endUndoGroup()`, each call individually try-wrapped as VerseFlow does.
- A failing cue is recorded and the loop continues; the summary reports it (FR-7.7). Unlike
  VerseFlow, there is **no running cursor to advance** — each cue's position is independent, so
  a failure cannot shift anything else.
- `actualStartTicks` is read back from the inserted clip. If Premiere placed it somewhere other
  than requested, the panel finds out rather than assuming.
- Progress is dispatched per cue via `CSXSEvent` type `com.versesync.progress`, same mechanism
  as VerseFlow's.

Per-cue body, reusing VerseFlow's proven sequence:

```javascript
var clip = seq.importMGT(mogrtPath, cue.atTicks, trackIndex, 0);
var mgt  = clip.getMGTComponent();
_setTextField(mgt, mapping.referenceIndex, cue.reference);
_setTextField(mgt, mapping.bodyIndex,      cue.body);
_setClipDuration(clip, cue.durationTicks);
```

`_setTextField` and `_setClipDuration` are lifted from `VerseFlow.jsx` unchanged, including the
`fontTextRunLength` write that VerseFlow's research names as the single most common cause of
silent failure.

### 6.1 The open question this function turns on

**Does `importMGT` at an arbitrary time on a populated track overwrite, or insert-and-ripple?**

VerseFlow never had to know: it always placed contiguously from the playhead, and its field
discovery deliberately inserts *past the end* of the sequence. VerseSync places into the middle
of a populated timeline, so the answer decides the design.

- **Overwrite** (expected) → this design works as written.
- **Ripple** → every insert would shift everything after it, corrupting the edit. Fallbacks, in
  order: (a) require an empty target track and validate it is empty before inserting;
  (b) insert all cues **descending** by time so ripples only affect already-placed cues, then
  verify positions; (c) fall back to VerseFlow's documented Option B — pre-render each graphic
  and use `videoTracks[t].overwriteClip(projectItem, timeSeconds)`, which has unambiguous
  overwrite semantics.

**This is spike T-03 and it is the M1 hard gate.** Nothing else in the Premiere layer should be
built until it has an answer.

---

## 7. `VS.setPlayhead`

```
VS.setPlayhead('{"ticks":"358996428390000"}')
→ { ok: true, data: { ticks: "358996428390000" } }
```

Backs FR-6.6 — clicking a review row's timecode jumps Premiere to that moment so the editor can
check a cue against the actual audio without leaving the panel. Small function, disproportionate
effect on whether the review pass feels trustworthy.

---

## 8. `VS.validateTrack`

```
VS.validateTrack('{"trackIndex":2,"ranges":[{"startTicks":"…","endTicks":"…"}]}')
→ { ok: true, data: { conflicts: [ { rangeIndex: 3, existingClipName: "Lower Third 02" } ] } }
```

Called before insert. Reports existing clips that would be overwritten in the ranges VerseSync
is about to write, so the panel can warn — *"3 of your cues will overwrite existing clips on
V3"* — instead of the editor discovering it afterwards. Directly serves FR-7.5 and the
"nothing surprising happens to the timeline" invariant.

---

## 9. Error strings

Host errors are read by editors, not developers. Keep VerseFlow's tone:

| Situation | Message |
|-----------|---------|
| No active sequence | `Open a sequence in Premiere first.` |
| Field discovery with no sequence | `Open a sequence in Premiere first — reading a template's fields requires an active sequence.` |
| `importMGT` returned null | `Premiere could not insert the template. Check the .mogrt path is still valid.` |
| `getMGTComponent()` null | `This template has no Motion Graphics component — it may not be an After Effects template.` |
| Track index out of range | `Track V{n} no longer exists in this sequence. Click Refresh.` |
| Unsorted cues | `Internal error: cues must be sorted by time. Please report this.` |

---

## 10. What is deliberately not in the host

Kept out so the ExtendScript layer stays as small as possible — it is the layer with the
end-of-support clock on it (risk R-3), and the one that cannot be unit-tested.

- No time arithmetic beyond adding a duration to a start. Snapping, overlap resolution and
  source→sequence mapping all happen in `timemap.js`.
- No scripture knowledge whatsoever. The host receives two strings per cue and writes them.
- No HTTP. The host never talks to the sidecar.
- No persistence. `localStorage` lives in the panel.
