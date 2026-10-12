# T-27 · Panel: setup UI

| | |
|---|---|
| **Workstream** | F — Panel |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-26, T-39 *(T-23 for real host data)* |
| **Unblocks** | T-29 |
| **Spec** | [09-ui-spec.md §1–4](../09-ui-spec.md) |

## Goal

The setup panel: media, template, field mapping, translation, target track, duration mode,
lead-in — plus the status strip and the progress view.

## Context you need

The weekly run must be **pick media, click Analyse**. Everything except the media file persists
between sessions (FR-1.7). Getting persistence right is most of this task's value.

## Steps

1. Implement every control in [09 §3](../09-ui-spec.md).
2. **Media file** — use `window.cep.fs.showOpenDialog` (VerseFlow's `pickFileCEP`), **not**
   ExtendScript `File.openDialog`, which fails in Premiere 2026.
3. **Template** — `.mogrt` picker calling `VS.getMogrtFields` with a *Reading template…* busy
   state. Zero fields → the VerseFlow After-Effects-authored-template warning (FR-1.4).
4. **Field dropdowns** — labels are group-qualified (`Description > Text`), **values are field
   indices**. Apply VerseFlow's smart defaults: reference ← group matching
   `/descr|caption|sub|credit|author/i`, body ← `/title|main|quote|body/i`. Same field for both
   is a validation error. Persist per MOGRT path.
5. **Translation** — from `GET /translations`, with the licence attribution beneath it in small
   type (FR-4.7). Disabled while the sidecar is unreachable.
6. **Target track** — from `VS.getSequenceInfo`, listed V-high to V-low, default topmost, with a
   **Refresh**.
7. **Duration** (Auto/Fixed, Auto default) and **Lead-in** (0.5 default, range 0–3).
8. **Analyse enablement** — enabled only when: sidecar ready, sequence open, media selected,
   template with ≥ 1 field, both fields mapped **and distinct**, translation selected, track
   selected. **When disabled, show the reason next to it** — never just a greyed button.
9. Status strip ([09 §2](../09-ui-spec.md)) and progress view ([09 §4](../09-ui-spec.md)):
   weighted bar, phase label, elapsed/ETA after 10%, **Cancel**. Setup collapses to a one-line
   summary during and after a job so the review list gets the height.
10. A cache hit shows *Using cached transcript* and visibly races — Journey B should feel
    different from a cold run.

## Files

- `panel/js/state.js` (ported from VerseFlow and extended), `panel/js/main.js`,
  `panel/css/style.css`

## Done when

- [ ] Every persisted setting survives a **Premiere restart**.
- [ ] Analyse enables exactly per the stated conditions, and the disabled reason is always shown.
- [ ] Smart defaults select the right two fields for `AV_Quote_04.mogrt`.
- [ ] Mapping both dropdowns to the same field is rejected.
- [ ] Progress renders correctly against the mock, including a cache-hit run.

## Traps

- Persist field mapping **per MOGRT path** — an editor with two templates should not have to
  remap on every switch.
- Store field **indices**, not display names (risk R-8 — two fields are both called `Text`).
- Keep VerseFlow's `state.js` persistence pattern; it works and it is already proven in this
  environment.

## Status

- **Every persisted setting survives a Premiere restart.** Met in a browser profile:
  `tests/state.test.js` (store round-trip, per-MOGRT mappings, corrupt storage) and
  `tests/setup-ui.test.js` "setup flow" (closes and reopens the browser profile; template,
  per-template mapping by index, translation, track, duration mode, fixed seconds and lead-in
  all return, the media file does not). **Deferred — needs Premiere:** select a template,
  translation, track, Fixed duration and lead-in, map the two fields non-default, quit and
  relaunch Premiere, reopen the panel and confirm all of them are restored with only the media
  file empty. (CEP keeps `localStorage` per extension; this has not been observed there.)
- **Analyse enables exactly per the stated conditions, and the disabled reason is always
  shown.** Met: `analyseGate` is tested by removing each condition in turn from a valid state
  (`tests/state.test.js`, 14 rows plus the sidecar and sequence states), and the UI test shows
  the reason beside the button at each step and hides it once enabled.
- **Smart defaults select the right two fields for `AV_Quote_04.mogrt`.** Met against the
  stub's field list (`Description > Text` index 11 as reference, `Title Main > Text` index 3
  as scripture) in `tests/state.test.js` and the UI test. **Deferred — needs Premiere and the
  real `AV_Quote_04.mogrt`:** select it and confirm the same two fields are chosen.
- **Mapping both dropdowns to the same field is rejected.** Met: validation error shown,
  Analyse disabled with that reason, and the invalid mapping is not persisted (state test and
  UI test).
- **Progress renders correctly against the mock, including a cache-hit run.** Met
  (`tests/setup-ui.test.js`): cold run shows the weighted bar, phase label, elapsed/ETA only
  after 10%, Cancel, and completion; `--cache-hit` shows *Using cached transcript* with the
  distinct styling and finishes in seconds; a failed job shows the message, hint and Retry; a
  panel reload rejoins a running job.

Not exercised here, **Deferred — needs Premiere:** the real CEP file dialog (media and
`.mogrt`); `pickFileCEP` is tested against a fake `window.cep.fs` (`tests/file-picker.test.js`).
Reading a template with the real host (`VS.getMogrtFields`) and the real sequence's tracks
(`VS.getSequenceInfo`) also need Premiere; both run against the host stub here.

Notes: `tests/setup-ui.test.js` needs Playwright and Chromium, which are not npm dependencies;
it locates them through `PLAYWRIGHT_NODE_PATH` / `PLAYWRIGHT_BROWSERS_PATH` and skips with a
reason when absent. Outside Premiere the panel connects to a running mock when opened with
`?sidecarPort=N&sidecarToken=T`. When no translation was saved, the bundled public-domain WEB
is preselected if listed; a licensed translation is never chosen silently. Analyse sends the
lead-in and duration mode as `options.timing.lead_in_s`, `duration_mode` and
`fixed_duration_s`.
