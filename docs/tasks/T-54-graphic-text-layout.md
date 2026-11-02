# T-54 · Wrap and split scripture text on graphics

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | — |
| **Spec** | [15-graphic-text-layout.md](../15-graphic-text-layout.md) · D28 in [12](../12-decisions-and-risks.md) |

## Goal

Scripture text never runs off the screen. The editor sets the characters per line and lines per
graphic on Setup, and a passage that doesn't fit becomes several graphics, split between verses.

## Context

VerseSync writes each cue's body as one line. VerseFlow added *Max chars / line* in upstream commit
`e586b3d`, after the copy in `reference/verseflow/` (`aa7b915`), so the feature was never ported.
Its `_wrapText` is quoted in 15 §3. Layout happens at insert time in the panel: the Cue Document's
`body` doesn't change, and neither does the host.

## Subtasks

### T-54.1 · Layout functions

**Executor** agent · **Size** S · **Prereqs** T-29.3 · **Status** todo

- **Read:** [15 §3, §4, §6](../15-graphic-text-layout.md)
- **Touches:** `panel/js/layout.js` (new) · `panel/index.html` · `tests/panel/layout.test.js` (new) ·
  `tests/fixtures/graphic-measurements.json` (new)
- **Interface:**
  - `wrapText(text, maxChars) -> string`
  - `verseChunks(body, reference) -> string[]`
  - `layoutCue(cue, {wrapEnabled, wrapChars, maxLines}) -> [{ body, firstVerse|null }]`
  - `timeParts(parts, cue, atTicks, durationTicks, frameTicks) -> [{ atTicks, durationTicks }]`
- **Steps:**
  1. `wrapText` and `verseChunks`, ported and tested. Commit.
  2. `layoutCue`, including a single verse too long for one graphic. Commit.
  3. `timeParts`: `verse_offsets_s` when valid, otherwise word share. Tick values go through the
     panel's existing string-tick helpers, never floats (R-11). Commit.
- **Verify:** `npm test -- layout`
- **Done when:**
  - [ ] No part exceeds `maxLines`, on any input.
  - [ ] Joining the parts' words gives back the body's words exactly.
  - [ ] Part durations add up to the cue's duration, exactly in ticks.

### T-54.2 · Setup controls

**Executor** agent · **Size** XS · **Prereqs** T-54.1 · **Status** todo

- **Read:** [15 §2](../15-graphic-text-layout.md) · [09 §3](../09-ui-spec.md)
- **Touches:** `panel/js/setup.js` · `panel/js/state.js` · `panel/index.html` · `docs/09-ui-spec.md` ·
  `tests/panel/setup-controls.test.js`
- **Steps:**
  1. Add the checkbox, *Max chars / line* and *Max lines / graphic*, with the defaults and ranges in
     15 §2. Out-of-range values clamp, as Lead-in does. Unticking disables both numbers. They persist
     with the other settings and never gate Analyse. Commit.
- **Verify:** `npm test -- setup`
- **Done when:**
  - [ ] Settings survive a reload, using the T-30.H write-through to `panel-state.json`.

### T-54.3 · Insert and review list

**Executor** agent · **Size** S · **Prereqs** T-54.2, T-51.2 · **Status** todo

- **Read:** [15 §4, §5](../15-graphic-text-layout.md) · `panel/js/insert.js`
- **Touches:** `panel/js/insert.js` · `panel/js/review.js` · `panel/js/main.js` · `docs/09-ui-spec.md` ·
  `tests/panel/insert-plan.test.js` · `tests/panel/insert-run.test.js` · `tests/panel/review-expand.test.js`
- **Steps:**
  1. `buildPayload` expands each enabled cue with `layoutCue` and `timeParts`. Later parts get the id
     `<cue id>#<n>`; every part keeps `reference_display` verbatim. Still sorted by `atTicks`. The
     conflict check covers every part, and the results summary counts graphics and names the cue.
     Commit.
  2. Review row: *Inserts as N graphics*, the parts in the expanded row, and the amber *Part under
     2 s*. Changing a setting updates them. Commit.
- **Verify:** `npm test`
- **Done when:**
  - [ ] An unsplit cue's payload differs from today only by the line breaks in `body`.
  - [ ] `panel/jsx/VerseSync.jsx` is unchanged.
  - [ ] The Cue Document saved after an insert has the same `body` as before it.

### T-54.H · Real graphics on real Premiere

**Executor** human · **Size** — · **Prereqs** T-54.3 · **Status** todo

Using the 2026-10-25 sermon and `AV_Quote_04.mogrt`, at the defaults, with the results recorded in
`docs/qa/graphic-layout.md`:

1. Insert every enabled cue, and scrub through them. No text goes off the screen, and `\n` renders
   as a line break.
2. Find the longest line and the most lines that fit, and change the defaults in 15 §2 if they're
   wrong.
3. Check a split passage: the parts sit back to back, each shows the full reference, and each
   appears about when its verse is read.
4. Change the settings and insert again without re-analysing: the new layout applies.

## Traps

- **Wrap the body only.** The reference field stays on one line, as in VerseFlow.
- **Never store wrapped text in the Cue Document.** `body` must stay comparable with VerseFlow's
  output (FR-4.2), and the settings have to be changeable after analysis.
- **Don't split one verse per graphic.** The editor keeps a passage together when it fits (15 §1).
- **`fontTextRunLength` must match the final text.** The host computes it from the string it
  receives, so don't add line breaks anywhere after the host call.
