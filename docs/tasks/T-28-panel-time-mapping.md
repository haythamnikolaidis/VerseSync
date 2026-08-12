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
   `t_seq = offset + t_src`. Label it clearly as an approximation and flag every cue produced
   this way.
7. Centralise all tick arithmetic here so it can be upgraded to string math later (risk R-11).

## Files

- `panel/js/timemap.js`
- `tests/js/test_timemap.js`

## Done when

- [ ] Unit tests — **pure JS, no Premiere** — cover every case in
      [05 §5](../05-timing-and-placement.md) and [§8](../05-timing-and-placement.md).
- [ ] The worked example in [05 §9](../05-timing-and-placement.md) reproduces exactly.
- [ ] Snapping is correct at 23.976, 25 and 29.97 using the real `timebase`.
- [ ] A 40-cue batch shows **no cumulative drift**.
- [ ] All three panel-owned flags are assigned correctly from the T-39 fixtures.
- [ ] Manual-offset mode maps and flags correctly.

## Traps

- **Never derive ticks-per-frame from `frameRate`.** It is wrong for 23.976 and 29.97 and
  produces exactly the cumulative drift this task must not have.
- Truncation is silent and usually right; the flagged overlap case is genuinely ambiguous
  (a range read as two mentions, or a list of three references) and is the editor's call. Do not
  try to be clever there.
- Alternate-track spillover is **deliberately not v1** (D14). Do not add it.
- Ticks are strings across the host boundary; convert deliberately and centrally.
