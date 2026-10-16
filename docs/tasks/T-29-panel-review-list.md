# T-29 · Panel: review list

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | T-30 |
| **Spec** | [09-ui-spec.md §5, §7](../09-ui-spec.md) · [07 §5](../07-sidecar-api.md) |

## Goal

Build the core screen. Every detected cue can be reviewed, corrected and re-timed before anything
touches the timeline. **This is what makes the product trustworthy** (D4, G3).

## Context

This was the one XL task in the old plan. It's now nine S/XS subtasks, built **outside-in**: the
model first, then collapsed rows, then the analysis flow, which makes the screen demoable, and
the expansion and editing after that.

**The model owns the document, and `timemap` owns sequence placement.** Rules:

- `VSCues` holds the schema-shaped Cue Document. `toJSON()` must always validate against the
  schema (`tests/lib/validate-cue-document.js`). It **never** stores ticks.
- Placements (ticks, timecodes, panel flags) come from `VSTimemap.mapCueDocument` and are
  recomputed after **every** edit. They're never persisted.
- Edits to timing are stored back in **source seconds**, using `VSTimemap.toSource`. Then a
  saved document is still correct after a recut.

```javascript
VSCues.load(jsonText) -> { ok:true, model, warning? } | { ok:false, error }
   // schema_version "1.x" accepted (a newer minor warns); any other major is refused with
   // "This cue document was made by a newer VerseSync (version X) and can't be opened."
model.cues() -> [cue]                     // document order
model.get(id) ; model.setEnabled(id, bool) ; model.enabledCount()
model.applyPanelFlags(placements)         // the first time a cue gets cut_from_edit / speed_change_unsupported → disable it once
model.edit(id, patch)                     // sets origin 'edited' unless it's 'manual'
model.addManual({ reference, reference_display, body, body_word_count, source_anchor_s, source_duration_s }) -> id   // 'cue_m001'…
model.remove(id)
model.toJSON() -> doc                     // schema-valid; panel-only state stripped
```

## Subtasks

### T-29.1 · `cues.js` model

**Executor** agent · **Size** S · **Prereqs** T-22.1 · **Status** done

- **Read:** [07 §5.1, §5.2](../07-sidecar-api.md) · [09 §5.2](../09-ui-spec.md) (the flags
  table)
- **Touches:** `panel/js/cues.js` (new) · `tests/panel/cues-model.test.js` (new)
- **Steps:**
  1. Write the interface above.
     - A manual cue gets `origin 'manual'`, `confidence 1.0`, `classification 'paraphrase'`,
       `mention_start_s` and `mention_end_s` both equal to `source_anchor_s`, `snippet ""`,
       `flags []`, `alternatives []`, and **no** `detection` block.
     - `edit` re-validates the cue.

     Commit.
  2. Tests:
     - load all four T-37 fixtures, and check that `toJSON()` validates and is deep-equal to
       the input when nothing was edited;
     - a 1.1 document loads with a warning, and a 2.0 document is refused with that exact
       message;
     - `enabledCount()` is right;
     - `edit` sets `edited`;
     - the manual cue validates;
     - `applyPanelFlags` disables a cue once, and doesn't re-disable it after the editor turns it
       back on.

     Commit.
- **Verify:** `node --test tests/panel/cues-model.test.js`
- **Done when:**
  - [x] Every mutation keeps `toJSON()` schema-valid.
  - [x] The version rules match 07 §5.2.

### T-29.2 · Save, load, and VerseFlow `.txt` export

**Executor** agent · **Size** XS · **Prereqs** T-29.1, T-43 · **Status** done

- **Read:** [09 §5.4](../09-ui-spec.md) (Save ▾) · `reference/verseflow/js/scripture-parser.js`
  (the block format)
- **Touches:** `panel/js/cues.js` · `tests/panel/cues-io.test.js` (new)
- **Steps:**
  1. Add `VSCues.serialize(model) -> string`, as pretty JSON. Add
     `VSCues.exportVerseFlowTxt(model) -> string`, covering **enabled cues with a body**, in
     anchor order, in VerseFlow's block format. Tests:
     - save → load → save is byte-identical;
     - edits, disables and manual additions survive the round trip;
     - every exported block parses with VerseFlow's regex (copied into the test with a comment
       citing the file);
     - the export skips cues with an empty body.

     Commit.
- **Verify:** `node --test tests/panel/cues-io.test.js`
- **Done when:**
  - [x] The round trip is lossless.
  - [x] The `.txt` export parses with VerseFlow's parser.

### T-29.3 · Collapsed rows

**Executor** agent · **Size** S · **Prereqs** T-29.1, T-28.4 · **Status** in-progress

- **Read:** [09 §5.1, §5.2, §8](../09-ui-spec.md)
- **Touches:** `panel/js/review.js` (new) · `panel/css/style.css` ·
  `tests/panel/review-rows.test.js` (new)
- **Steps:**
  1. Write `VSReview.rowViewModel(cue, placement, threshold) -> {…}`. It's pure: it produces
     the timecode, reference, a `READ` or `PARAPHRASE` badge, the confidence as a percentage
     with an `amber` marker below 0.55, the duration in seconds, the snippet with the matched
     span marked, and the flag badges with their colours from 09 §5.2. Every flag also has a
     **text label**. Commit.
  2. Write `VSReview.create({root, model, getPlacements, bridge})`, which renders rows sorted by
     **sequence timecode**. Cues that are cut sort to the end. Ticking a checkbox updates **only
     that row** and the header counts; no full re-render. Tests:
     - all four fixtures render;
     - each of the 11 flags renders with the right colour class and label;
     - a disabled row dims;
     - toggling a checkbox doesn't replace other rows' DOM nodes (check node identity).

     Commit.
- **Verify:** `node --test tests/panel/review-rows.test.js`
- **Done when:**
  - [ ] All four golden fixtures render.
  - [ ] Every flag has its colour and its text label.

### T-29.4 · The Analyse → review flow (makes the screen demoable)

**Executor** agent · **Size** S · **Prereqs** T-29.3, T-27.4 · **Status** todo

- **Read:** [03 §4](../03-architecture.md) (Journey A, steps 1–4) · [09 §7](../09-ui-spec.md)
- **Touches:** `panel/js/main.js` · `tests/panel/analyse-flow.test.js` (new)
- **Steps:**
  1. In `main.js`, wire `onAnalyse` to the following sequence:
     - `client.startJob`;
     - the watcher drives the progress view;
     - on done: `client.result`, then `VSCues.load`;
     - `bridge.call('getSequenceInfo')`, then `getMediaSegments({mediaPath, sequenceId})`;
     - `mapCueDocument`, then `model.applyPanelFlags`, then render the review.

     Remember the `sequenceId` the analysis ran against, because T-30 needs it. When the media
     isn't matched, show the [09 §7] message *"<basename> isn't in this sequence."* and an
     **Enter a start timecode manually** input, which re-maps with `manualOffsetTicks`. Commit.
  2. jsdom test, with the stub bridge and the fake client:
     - Analyse leads to a rendered review of 18 rows for the `happy` scenario;
     - `segments-none` shows the manual-offset prompt, and entering an offset renders
       approximate rows;
     - a failed job shows its `message` and `hint` and a **Retry** button.

     Then run `npm run smoke -- --expect '#review .row' --count 18`. Commit.
- **Verify:** `node --test tests/panel/analyse-flow.test.js && npm run smoke`
- **Done when:**
  - [ ] **The review list can be demoed in a browser against the stubs** (the old Wave 1 exit
        criterion).

### T-29.5 · List header and actions

**Executor** agent · **Size** S · **Prereqs** T-29.4, T-29.2 · **Status** todo

- **Read:** [09 §5.4](../09-ui-spec.md) · [09 §1](../09-ui-spec.md) (the review header)
- **Touches:** `panel/js/review.js` · `panel/js/main.js` · `tests/panel/review-actions.test.js`
  (new)
- **Steps:**
  1. Build the header, *"REVIEW — 18 found · 16 enabled [⚑ 3]"*, with these actions:
     - **All**, **None** and **Flagged only** (a filter toggle);
     - **Save ▾**, with *Save cue document* (`fs.showSaveDialog`, then write `serialize`, plus the transcript sibling
       under `words_ref` per D22),
       *Load cue document* (open, `VSCues.load`, **re-map against the current sequence**, then
       render), and *Export as VerseFlow .txt*.

     The Insert button label shows the enabled count. Commit.
  2. Tests:
     - the counts update when cues are toggled;
     - All and None work;
     - Flagged only hides rows that have no flags;
     - Load re-maps, so a fixture loaded against a different segments scenario gets different
       timecodes;
     - Save writes valid JSON through the fake `fs`.

     Commit.
- **Verify:** `node --test tests/panel/review-actions.test.js`
- **Done when:**
  - [ ] Every [09 §5.4] action works.
  - [ ] Load never trusts stored positions.

### T-29.6 · Expanded row (read-only parts)

**Executor** agent · **Size** S · **Prereqs** T-29.5, T-50 · **Status** todo

- **Read:** [09 §5.3](../09-ui-spec.md)
- **Touches:** `panel/js/review.js` · `tests/panel/review-expand.test.js` (new)
- **Steps:**
  1. Build the expanded row:
     - **The timecode is clickable** and calls `bridge.call('setPlayhead', {ticks})` (FR-6.6);
     - clicking the row body expands it;
     - the verse text is read-only, and shows the truncation point when `long_passage` is set;
     - **transcript context** is fetched lazily, **once per document**, using the D22 rules
       ([T-50](T-50-contract-transcript-endpoint.md)). A job result uses
       `client.transcript(jobId)`; a loaded file reads `<dir>/<words_ref>` through `fs`. If the
       transcript is missing, show *"Transcript not available for this document."*. It shows about 15 words either side of `word_span`, with the
       matched span marked and the read span (`read_start_s`–`read_end_s`) underlined;
     - the classification line reads `READ (coverage 0.78)`.

     Commit.
  2. Tests:
     - clicking the timecode calls `setPlayhead` with the placement ticks;
     - the transcript is fetched once, even when 3 rows are expanded;
     - the underline covers the right words;
     - a cue with no `detection` (manual) shows no context, without crashing.

     Commit.
- **Verify:** `node --test tests/panel/review-expand.test.js`
- **Done when:**
  - [ ] Clicking a timecode moves the playhead.
  - [ ] The read span is underlined, and `read_coverage` is shown.

### T-29.7 · Reference editing and re-resolve

**Executor** agent · **Size** S · **Prereqs** T-29.6 · **Status** todo

- **Read:** [09 §5.3](../09-ui-spec.md) (the Reference field) · [07 §2](../07-sidecar-api.md)
  (`POST /resolve`)
- **Touches:** `panel/js/review.js` · `panel/js/cues.js` · `tests/panel/review-reference.test.js`
  (new)
- **Steps:**
  1. Make the reference field editable, with a `↻` button that calls
     `client.resolve(text, translationId)`.
     - **On success**, update the cue: `reference`, `reference_display`, `body`,
       `body_word_count`, `body_truncated`. Remove the `text_unavailable`,
       `passage_not_found` and `chapter_only` flags. If the duration mode is auto and the cue
       is a paraphrase, recompute `source_duration_s` with `VSDuration`. Set
       `origin 'edited'`. Re-map.
     - **On failure**, show the error `message` inline and leave the cue unchanged.
     - Clicking an alternative (Psalms) applies that alternative's reference the same way.

     Commit.
  2. Tests with the fake client:
     - a valid edit updates the text and the duration;
     - `Jude 5:1` shows `Jude has only 1 chapter.` inline;
     - choosing the alternative in `alternatives.json` switches to Psalm 12:2;
     - with the sidecar down, the field is disabled and shows a reason.

     Commit.
- **Verify:** `node --test tests/panel/review-reference.test.js`
- **Done when:**
  - [ ] Editing a reference re-resolves it and updates the text and the duration.
  - [ ] Errors appear inline.

### T-29.8 · Timing edits: nudges, set-to-playhead, duration override

**Executor** agent · **Size** S · **Prereqs** T-29.6 · **Status** todo

- **Read:** [09 §5.3](../09-ui-spec.md) (the Timing row)
- **Touches:** `panel/js/review.js` · `tests/panel/review-timing.test.js` (new)
- **Steps:**
  1. Add the timing controls:
     - **`[-1f]`** and **`[+1f]`** move the placement by `timebase`, convert it back with
       `toSource`, store it as `source_anchor_s`, set `edited`, and **re-map the whole list**,
       so the overlap sweep runs again;
     - **`⌖`** calls `getSequenceInfo.playheadTicks`, then `toSource`. If the result is `null`,
       show *"The playhead isn't over this media."* and change nothing;
     - **Duration override:** seconds go into `source_duration_s`;
     - **Delete** calls `model.remove`.

     Commit.
  2. Tests:
     - ten `+1f` presses move the timecode exactly ten frames;
     - a nudge that creates an overlap truncates or flags the neighbouring cue;
     - set-to-playhead outside the media gives the message;
     - a duration override persists through save and load.

     Commit.
- **Verify:** `node --test tests/panel/review-timing.test.js`
- **Done when:**
  - [ ] Every timing edit re-runs overlap resolution across the list.
  - [ ] Edits are stored in source seconds.

### T-29.9 · Add cue, placement alternatives, empty and edge states

**Executor** agent · **Size** S · **Prereqs** T-29.7, T-29.8 · **Status** todo

- **Read:** [09 §5.4](../09-ui-spec.md) (Add cue) · [09 §7](../09-ui-spec.md) · [05 §5.2](../05-timing-and-placement.md)
  (multiple placements)
- **Touches:** `panel/js/review.js` · `tests/panel/review-edge.test.js` (new)
- **Steps:**
  1. Build these pieces:
     - **Add cue:** a reference input plus the current playhead, then `client.resolve`, then
       `toSource` on the playhead, then `model.addManual`. The duration comes from
       `VSDuration`.
     - **Multiple placements:** the expanded row lists the other placements' timecodes. Picking
       one stores a per-cue placement choice in the panel state (not persisted) and re-maps.
     - **Edge states**, using the exact [09 §7] text: *Select a media file and click Analyse.*;
       the "nothing found" message; *Enable at least one scripture to insert.*; and, when the
       provider is down, a banner offering **Retry text fetch**, which re-resolves every
       `text_unavailable` cue.

     Commit.
  2. Tests:
     - a manual cue appears in timecode order with 100% confidence;
     - choosing a placement alternative moves the cue;
     - `empty.json` shows the nothing-found message;
     - all cues disabled shows the insert hint;
     - the `flagged` fixture shows the retry banner.

     Commit.
- **Verify:** `node --test tests/panel/review-edge.test.js`
- **Done when:**
  - [ ] Every FR-6 behaviour that can be tested with stubs is covered. The real-sermon check is
        T-30.H.

## Traps

- Build outside-in. Don't start on the expanded row before T-29.4 is demoable.
- A 40-cue list must stay responsive in CEP's older Chromium. Never re-render the whole list on
  a checkbox toggle. T-35.1 measures this.
- The `.txt` export is a genuine escape hatch. Don't drop it.
