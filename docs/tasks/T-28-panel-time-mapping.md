# T-28 · Panel: time mapping (`timemap.js`)

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | T-29, T-30, T-31 |
| **Spec** | [05-timing-and-placement.md §1, §5, §7, §8, §9](../05-timing-and-placement.md) |

## Goal

Convert every cue's **source-time** anchor into a frame-snapped **sequence-time** anchor,
resolve overlaps, and assign the panel-owned flags. This is pure maths, built against the T-39
fixtures, with no Premiere involved.

## Context

The mapping lives in the panel (D6) because only Premiere knows the edit. Keeping the Cue
Document in source time is what makes Journey B a pure recomputation.

**Ticks are `Number` internally and `String` at module boundaries.** A `Number` is exact up to
2^53 ticks, which is about 9.9 hours of sequence time: comfortably beyond a sermon edit. All
tick maths lives in this one file, so it can move to string or BigInt maths later (R-11).
Config defaults come from [05 §2](../05-timing-and-placement.md): `MIN_VISIBLE_S = 2.0` and
`OVERLAP_GAP_S = 0.25`.

**The panel keeps sequence data outside the Cue Document.** `mapCueDocument` returns a
`placements` map keyed by cue id. The document itself is never changed here (see T-29.2).

## Subtasks

### T-28.1 · Tick helpers, snapping, timecode, `duration.js` port

**Executor** agent · **Size** S · **Prereqs** T-22.1 · **Status** in-progress

- **Read:** [05 §1, §7](../05-timing-and-placement.md) · `reference/verseflow/js/duration.js`
- **Touches:** `panel/js/timemap.js` (new) · `panel/js/duration.js` (new, ported) ·
  `tests/panel/timemap-ticks.test.js` (new) · `tests/panel/duration.test.js` (new)
- **Interface:**
  ```javascript
  VSTimemap.TICKS_PER_SECOND = 254016000000
  VSTimemap.secondsToTicks(s) -> Number ; ticksToSeconds(t) -> Number
  VSTimemap.snapToFrame(ticks, timebase) -> String     // 05 §7, verbatim
  VSTimemap.timecode(ticks, seqInfo) -> "HH:MM:SS:FF"  // adds zeroPointTicks; frames = floor(ticks/timebase); fps = Math.round(frameRate); non-drop-frame
  ```
- **Steps:**
  1. Write the helpers, and port `duration.js` from VerseFlow as UMD (`VSDuration`), keeping its
     constants and function names. Commit.
  2. Tests:
     - snapping at 23.976, 24, 25, 29.97, 30, 50 and 59.94, using **real `timebase` values**
       from the T-39 fixtures where they exist, and derived ones otherwise;
     - snapping twice gives the same result as snapping once;
     - 40 sequential snapped additions show **zero** drift against a single multiplication;
     - `timecode` includes `zeroPoint`;
     - the duration ports give the same results as VerseFlow for 6 word counts.

     Commit.
- **Verify:** `node --test tests/panel/timemap-ticks.test.js tests/panel/duration.test.js`
- **Done when:**
  - [ ] The ticks-per-frame value is never derived from `frameRate`, and a test asserts that
        (grep the file for `frameRate` usage outside `timecode`).

### T-28.2 · Segment map: source→sequence, inverse, flags

**Executor** agent · **Size** S · **Prereqs** T-28.1, T-47 · **Status** todo

- **Read:** [05 §5.1, §5.2, §5.3](../05-timing-and-placement.md) · [08 §4](../08-premiere-host-api.md)
  (the response shape)
- **Touches:** `panel/js/timemap.js` · `tests/panel/timemap-map.test.js` (new)
- **Interface:**
  ```javascript
  VSTimemap.buildMap(segmentsResponse) -> map
  VSTimemap.toSequence(map, tSrcSeconds) -> { ticks: Number, placements: [Number] } | null   // null = cut
  VSTimemap.toSource(map, seqTicks) -> Number | null    // inverse; for nudges and "set to playhead"
  ```
- **Steps:**
  1. Each segment covers source times `[inPoint, inPoint + (seqEnd - seqStart))` and maps them
     as `t_seq = seqStart + (t_src - inPoint)`.
     - **No candidate** means the cue is cut.
     - **One candidate** maps directly.
     - **Several candidates** map to the **earliest** `seqStart`, and all of them are returned
       in `placements`.

     `toSource` inverts the mapping for the segment containing `seqTicks`, and returns `null`
     outside every segment. Speed-changed segments are in `unsupported` and are never mapped.
     Commit.
  2. Test it with every `segments-*.json` fixture: a time before `inPoint`, a time past the
     segment end, trimmed heads and tails, duplicates, and the `toSequence`/`toSource`
     round-trip. Commit.
- **Verify:** `node --test tests/panel/timemap-map.test.js`
- **Done when:**
  - [ ] Every [05 §5.2] case is tested against the fixtures.

### T-28.3 · Overlap sweep

**Executor** agent · **Size** XS · **Prereqs** T-28.2 · **Status** todo

- **Read:** [05 §8](../05-timing-and-placement.md)
- **Touches:** `panel/js/timemap.js` · `tests/panel/timemap-overlap.test.js` (new)
- **Interface:**
  `VSTimemap.resolveOverlaps(items /* [{id, anchor, end}] Numbers */, timebase, cfg) -> { [id]: {anchor, end, flags:[]} }`
- **Steps:**
  1. Sort by anchor and sweep once. When `a.end > b.anchor`, truncate `a` to
     `snap(b.anchor - gap)` if the result still lasts at least `MIN_VISIBLE`, and add the flag
     `truncated`. Otherwise flag **both** cues `overlap`. Only **enabled** items take part.
     Tests:
     - silent truncation;
     - truncation refused below 2 s;
     - a three-way overlap;
     - cues that exactly abut don't overlap;
     - every result is frame-aligned.

     Commit.
- **Verify:** `node --test tests/panel/timemap-overlap.test.js`
- **Done when:**
  - [ ] Every [11 §2](../11-testing.md) "Overlap sweep" case passes.
  - [ ] After the sweep, no enabled pair overlaps. This is the guarantee T-25 depends on.

### T-28.4 · `mapCueDocument`, manual offset, worked example

**Executor** agent · **Size** S · **Prereqs** T-28.3 · **Status** todo

- **Read:** [05 §5.4, §9](../05-timing-and-placement.md)
- **Touches:** `panel/js/timemap.js` · `tests/panel/timemap-document.test.js` (new)
- **Interface:**
  ```javascript
  VSTimemap.mapCueDocument(doc, { segments /* VS.getMediaSegments data */, seqInfo, enabledById,
                                   manualOffsetTicks /* optional */, cfg })
    -> { placements: { [cueId]: { atTicks: String, durationTicks: String, endTicks: String,
                                  timecode, alternatives: [String], panelFlags: [String] } },
         unmatched: Boolean, approximate: Boolean }
  ```
  `panelFlags` is a subset of `cut_from_edit`, `multiple_placements`,
  `speed_change_unsupported`, `overlap` and `truncated`.
- **Steps:**
  1. Write it:
     - map each cue's `source_anchor_s`;
     - the end is `anchor + source_duration_s`, snapped;
     - run the overlap sweep over the enabled cues;
     - assign the panel flags. A cue whose source time falls inside an `unsupported` speed
       segment gets `speed_change_unsupported`.

     **Manual offset:** when `segments.matched` is false and an offset is given, use
     `t_seq = offset + t_src` for every cue, and set `approximate: true`. Commit.
  2. Tests:
     - reproduce the [05 §9] worked example: 1425.32 s, 12 s trimmed off the head, 29.97 fps,
       giving 1413.32 s snapped to a frame;
     - map the `happy-18-cues.json` fixture against `segments-split`, and check its panel
       flags;
     - a 40-cue synthetic batch shows no drift;
     - manual-offset mode maps and marks the result approximate;
     - the input document is deep-equal before and after.

     Commit.
- **Verify:** `node --test tests/panel/timemap-document.test.js`
- **Done when:**
  - [ ] The worked example reproduces exactly.
  - [ ] All three panel-owned flags are assigned correctly from the fixtures.
  - [ ] The document is never changed.

## Traps

- **Never derive ticks-per-frame from `frameRate`.**
- Spilling over onto an alternate track is deliberately not v1 (D14).
- `zeroPointTicks` is for display only. Adding it into placement maths shifts every graphic by
  an hour.
