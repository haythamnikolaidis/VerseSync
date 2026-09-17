# T-29 · Panel: review list

| | |
|---|---|
| **Workstream** | F — Panel |
| **Wave** | 1 |
| **Estimate** | **XL** — the largest task in the project, and on the critical path |
| **Prereqs** | T-27, T-28 |
| **Unblocks** | T-30 |
| **Spec** | [09-ui-spec.md §5](../09-ui-spec.md) |

## Goal

The core screen: every detected cue, reviewable, correctable and re-timable before anything
touches the timeline.

## Context you need

**This is what makes the product trustworthy** (decision D4, goal G3). ASR errors are certain;
the review list is what converts a detection error from a published mistake into a checkbox.

It is also the **critical path** ([13 §6](../13-technical-plan.md)). Demo it against the mock
weekly from the day it starts — this is the one task where slippage is visible early and
cheaply.

You are building against T-37's golden fixtures via the mock sidecar and T-39's host stub. No
Premiere and no Python needed.

## Steps

1. **Collapsed row** ([09 §5.1](../09-ui-spec.md)): checkbox, sequence timecode, reference,
   READ/PARAPHRASE badge, confidence (amber below 0.55), duration, transcript snippet with the
   matched span emphasised, flag badges. Sorted by sequence timecode.
2. **Clicking the timecode calls `VS.setPlayhead`** (FR-6.6). This single interaction does more
   for trust than any confidence display — the editor *hears* the moment. Do not cut it.
3. **Flags** ([09 §5.2](../09-ui-spec.md)): all eleven, with the specified colours and
   **default-enabled/disabled** state. Every red or amber default-disabled flag must be
   recoverable by the editor **in one click** — nothing is hidden, it just starts off.
4. **Expanded row** ([09 §5.3](../09-ui-spec.md)):
   - editable **reference** with `↻` re-resolving via `POST /resolve`, replacing verse text and
     recomputing the paraphrase duration; canon-validation errors shown inline
   - read-only verse text, showing the truncation point when `long_passage` is set
   - transcript context, ~15 words either side, matched span marked, **read span underlined**
     when one was found — the honest way to present a 78% coverage number
   - `[-1f] [+1f]` frame nudges and `⌖` set-to-playhead, **both re-running overlap resolution
     across the whole list**
   - per-cue duration override
   - Delete
5. **List actions** ([09 §5.4](../09-ui-spec.md)): All / None / Flagged only · **Add cue**
   (reference + current playhead, origin `manual`, confidence 1.0) · **Save ▾** with *Save cue
   document*, *Load cue document*, and *Export as VerseFlow `.txt`*.
6. `cues.js` — the Cue Document model, edit operations, and validation. Edits set
   `origin: "edited"`.
7. Handle the empty document and the all-disabled cases gracefully
   ([09 §7](../09-ui-spec.md)).

## Files

- `panel/js/review.js`, `panel/js/cues.js`, `panel/css/style.css`
- `tests/js/test_cues.js`

## Done when

- [ ] Every FR-6 requirement demonstrably works on a real analysis of a real sermon.
- [ ] All four T-37 golden fixtures render correctly, including `empty.json` and
      `alternatives.json`.
- [ ] All eleven flags render with the right colour and default state.
- [ ] Editing a reference re-resolves and updates text and duration.
- [ ] Frame nudges re-run overlap resolution across the list.
- [ ] Save → load round-trips losslessly; `.txt` export is parseable by VerseFlow's parser.

## Traps

- Scope this deliberately — it is XL and it gates T-30. Build the collapsed row and the
  checkbox first, get it demoable, then add expansion. Do not build it inside-out.
- A 40-cue list with expanded rows must stay responsive in CEP's older Chromium. Avoid
  re-rendering the whole list on every checkbox toggle.
- The `.txt` export is a genuine escape hatch and is nearly free given
  [06 §2](../06-bible-text-service.md)'s formatting contract. Do not drop it under time pressure.
