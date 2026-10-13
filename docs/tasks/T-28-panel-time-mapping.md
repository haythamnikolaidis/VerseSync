# T-28 · Panel: time mapping

| | |
|---|---|
| **Workstream** | F — Panel |
| **Wave** | 1 |
| **Estimate** | L |
| **Prereqs** | T-22, T-39 *(T-24 for real data)* |
| **Unblocks** | T-29 |
| **Spec** | [05-timing-and-placement.md §5, §7, §8, §9](../05-timing-and-placement.md) |

## Goal

`timemap.js` — convert every cue's **source-time** anchor into a frame-snapped **sequence-time**
anchor, resolve overlaps, and assign the panel-owned flags.

## Context you need

This is **pure math over data structures** and it is fully unit-testable with no Premiere. It
consumes a segment list whose shape is already fixed in
[08 §4](../08-premiere-host-api.md) — so build it against T-39's fixtures and do **not** wait for
T-24.

Why this lives in the panel and not the sidecar (D6): only Premiere knows the edit. Keeping the
Cue Document in source time is what makes Journey B a pure recomputation.

## Steps

1. **Build the map** ([05 §5.1](../05-timing-and-placement.md)): each segment is a linear window
   covering source `[inPoint, inPoint + (seqEnd - seqStart))`, mapping
   `t_seq = seqStart + (t_src - inPoint)`.
2. **Resolve** ([05 §5.2](../05-timing-and-placement.md)):
   - **0 candidates** → flag `cut_from_edit`, disabled by default (FR-5.6)
   - **1 candidate** → map it
   - **n candidates** → map to the **earliest** `seqStart`, flag `multiple_placements`, and put
     the others in the cue's alternatives so the review row can offer them (FR-5.7)
3. **Frame snapping** ([05 §7](../05-timing-and-placement.md)) on **both** the anchor and the end:
   ```javascript
   function snapToFrame(ticks, ticksPerFrame) {
     return String(Math.round(Number(ticks) / ticksPerFrame) * ticksPerFrame);
   }
   ```
   Use `timebase` from `VS.getSequenceInfo` — **never** derive ticks-per-frame from `frameRate`.
4. **Overlap resolution** ([05 §8](../05-timing-and-placement.md)): sort by anchor, sweep once.
   If `a.end > b.anchor`, truncate `a` to `b.anchor - overlap_gap_ticks` when the result is still
   at least `min_visible_ticks` (record `truncated`); otherwise flag **both** `overlap` and let
   the editor decide.
5. Assign the panel-owned flags: `cut_from_edit`, `multiple_placements`,
   `speed_change_unsupported` (from the host's `unsupported` list).
6. **Manual-offset fallback** ([05 §5.4](../05-timing-and-placement.md)): when no segments
   matched, accept a typed sequence timecode for the media's frame 0 and map
   `t_seq = offset + t_src`. Label it clearly as an approximation and mark every cue produced
   this way (`approximate`, not a Cue Document flag).
7. Centralise all tick arithmetic here so it can be upgraded to string math later (risk R-11).

## Files

- `panel/js/timemap.js`
- `tests/timemap.test.js`

## Done when

- [ ] Unit tests — **pure JS, no Premiere** — cover every case in
      [05 §5](../05-timing-and-placement.md) and [§8](../05-timing-and-placement.md).
- [ ] The worked example in [05 §9](../05-timing-and-placement.md) reproduces exactly.
- [ ] Snapping is correct at 23.976, 25 and 29.97 using the real `timebase`.
- [ ] A 40-cue batch shows **no cumulative drift**.
- [ ] All five panel-owned flags are assigned correctly from the T-39 fixtures.
- [ ] Manual-offset mode maps and flags correctly.

## Traps

- **Never derive ticks-per-frame from `frameRate`.** It is wrong for 23.976 and 29.97 and
  produces exactly the cumulative drift this task must not have.
- Truncation is silent and usually right; the flagged overlap case is genuinely ambiguous
  (a range read as two mentions, or a list of three references) and is the editor's call. Do not
  try to be clever there.
- Alternate-track spillover is **deliberately not v1** (D14). Do not add it.
- Ticks are strings across the host boundary; convert deliberately and centrally.

## Status

Implemented in `panel/js/timemap.js` (loaded by `panel/index.html`); tests in
`tests/timemap.test.js` (named to match the `npm test` glob `tests/**/*.test.js`). Run with
`npm test`; the suite is pure Node, no Premiere.

- **Unit tests cover every case in 05 §5 and §8** — **Met.** §5: zero, one and many candidates,
  a time before `inPoint`, exactly at the end of a window (half-open), trimmed head and tail,
  linked video+audio counted as one placement, audio-only match, `matched: false`, speed-changed
  segments, manual offset (§5.4). §8: silent truncation, refusal at exactly and just below
  `min_visible_s`, two- and three-way overlaps, abutting cues, identical anchors, disabled cues
  skipped, configurable gap and minimum, repeatable sweep.
- **Worked example in 05 §9 reproduces exactly** — **Met.** Test "worked example": anchor
  `359003835590400` (frame 42,357), end `365886077356800` (frame 43,169), duration 812 frames,
  the next cue 96 s later unflagged. Doc 05 §9 states the same values (1413.32 s is
  `359,005,893,120,000` ticks before snapping).
- **Snapping correct at 23.976, 25 and 29.97 using the real `timebase`** — **Met.** Tests
  "snapToFrame rounds…" (23.976, 24, 25, 29.97, 30, 50, 59.94), "anchors and ends land on whole
  frames…" (the three T-39 sequence fixtures), "frameRate is ignored…". Expected values come
  from an independent BigInt oracle.
- **A 40-cue batch shows no cumulative drift** — **Met.** Test "40 cues in one batch…" at 29.97,
  23.976 and 25: every anchor and end is within half a frame of its exact time.
- **All five panel-owned flags assigned correctly from the T-39 fixtures** — **Met.** Tests
  `segments-split` (`cut_from_edit`), `segments-duplicate` (`multiple_placements` plus
  alternatives), `segments-speed` (`speed_change_unsupported`), `segments-none`.
- **Manual-offset mode maps and flags correctly** — **Met.** Tests "manual offset: …" and
  "offsetFromTimecode: …": every cue gets `approximate: true`; times before the sequence or past
  its end are `cut_from_edit`.

Behaviour the spec left open is now written into
[05 §5.2, §5.4, §7, §8](../05-timing-and-placement.md) and [09 §5.2](../09-ui-spec.md), and is
covered by the tests listed above: the separate `approximate` marker, the overlap gap rounded up
to whole frames, disabled cues skipped by the sweep, manual-offset cues outside the sequence
flagged `cut_from_edit`, `speed_change_unsupported` taking precedence over `cut_from_edit`,
linked video/audio halves counted as one placement, the five panel-owned flags recomputed on
every call, and the typed timecode treated as a display timecode (`zeroPointTicks` subtracted).

Two spec gaps found by independent validation are now resolved:

- **`placementAlternatives` is panel-only session state, never part of the Cue Document.** Its
  exact shape (`anchorTicks`, `endTicks`, `durationTicks`, `trackType`, `trackIndex` — matching
  `timemap.js`'s `placementView`) is now specified in
  [05 §5.2](../05-timing-and-placement.md), and the review row's use of it is specified in
  [09 §5.3](../09-ui-spec.md). [07 §5.1](../07-sidecar-api.md)'s `alternatives` field description
  is corrected to say it holds only competing scripture references from detection, never
  multi-placement options — the code already matched this (`placementAlternatives` was never
  written into a Cue Document), only the docs were out of step.
- **The panel owns five flags, not three.** [07 §5.1](../07-sidecar-api.md) and the `flag`
  description in `schemas/cue-document.schema.json` now say the panel adds/recomputes all five
  of `cut_from_edit`, `multiple_placements`, `speed_change_unsupported`, `overlap` and
  `truncated` after source→sequence mapping (the sidecar never emits any of them), consistent
  with [05 §8](../05-timing-and-placement.md) and [09 §5.2](../09-ui-spec.md) and with
  `timemap.js`'s `OWNED_FLAGS`. No enum change and no `schema_version` bump: the five flags
  already existed, this only corrects which stage the docs/schema say owns them.
