# T-27 · Panel: setup UI, status strip, progress

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | T-29.4 |
| **Spec** | [09-ui-spec.md §1–4](../09-ui-spec.md) |

## Goal

The weekly run is **pick media, click Analyse**. Everything except the media file persists
between sessions (FR-1.7). The Analyse button explains why it's disabled whenever it is.

## Context

Views are split ([AGENT.md §6](AGENT.md)). **Pure functions** do the decision-making and get
unit tests. **Render functions** are thin, are tested under jsdom, and are checked visually with
`npm run smoke` (T-49). The bridge, the sidecar client and `cep.fs` are all injected.

## Subtasks

### T-27.1 · `state.js`: persistence, smart defaults, Analyse blockers

**Executor** agent · **Size** S · **Prereqs** T-22.2 · **Status** done

- **Read:** [09 §3](../09-ui-spec.md) · `reference/verseflow/js/state.js` (the persistence
  pattern and the smart-default regexes)
- **Touches:** `panel/js/state.js` (new) · `tests/panel/state.test.js` (new)
- **Interface:**
  ```javascript
  VSState.create({ storage }) -> state     // storage: localStorage-like; injected
  state.get() / state.set(patch)           // persists everything except mediaPath
  state.fieldMappingFor(mogrtPath) / state.setFieldMapping(mogrtPath, { referenceIndex, bodyIndex })
  VSState.smartDefaults(fields) -> { referenceIndex, bodyIndex }   // VerseFlow regexes: ref ← /descr|caption|sub|credit|author/i, body ← /title|main|quote|body/i
  VSState.analyseBlockers(s) -> [string]   // ordered; empty = enabled
  ```
  The blocker strings, in this order:
  - `Transcription service isn't ready.`
  - `Open a sequence in Premiere first.`
  - `Select a media file.`
  - `Select a template.`
  - `This template has no editable text fields.`
  - `Map both template fields.`
  - `Reference and scripture must use different fields.`
  - `Select a translation.`
  - `Select a target track.`
- **Steps:**
  1. Port the persistence pattern. Store a schema version under one key, and store field
     mappings **per MOGRT path**, as **indices**. Commit.
  2. Write `smartDefaults` and `analyseBlockers`. Tests:
     - `AV_Quote_04`'s fields (from `tests/fixtures/host/mogrt-fields.json`) default to
       Description for the reference and Title Main for the body;
     - each blocker is triggered on its own;
     - the same field for both is blocked;
     - settings survive a new `create()` on the same storage, which stands in for a restart;
     - `mediaPath` is not persisted.

     Commit.
- **Verify:** `node --test tests/panel/state.test.js`
- **Done when:**
  - [x] Every blocker and the persistence rules are tested.
  - [x] Indices are stored, never display names (R-8).

### T-27.2 · Setup view (part 1): media, template, field mapping

**Executor** agent · **Size** S · **Prereqs** T-27.1 · **Status** in-progress

- **Read:** [09 §3](../09-ui-spec.md) (the Media, Template and dropdown rows)
- **Touches:** `panel/js/setup.js` (new) · `panel/index.html` (the `#setup` markup) ·
  `tests/panel/setup-fields.test.js` (new)
- **Steps:**
  1. Write `VSSetup.create({ root, state, bridge, fs })`.
     - **Media:** `fs.showOpenDialog`, filtered to audio and video extensions, showing the
       basename with the full path as a `title`.
     - **Template:** a `.mogrt` dialog, then `bridge.call('getMogrtFields', {path})`, with a
       *Reading template…* busy state. Zero fields shows the [09 §3] After Effects warning.
     - **Dropdowns:** group-qualified labels, with index values. Use `smartDefaults` when no
       mapping is saved for that path, and persist on change.

     Commit.
  2. jsdom tests, with the stub bridge and a fake `fs`:
     - picking `AV_Quote_04` fills both dropdowns with the right defaults;
     - an empty fields response shows the warning;
     - switching templates restores each template's saved mapping;
     - a bridge error shows its message in place.

     Commit.
- **Verify:** `node --test tests/panel/setup-fields.test.js`
- **Done when:**
  - [ ] The listed jsdom tests pass.
  - [ ] It uses `cep.fs.showOpenDialog`, never ExtendScript's `File.openDialog`.

### T-27.3 · Setup view (part 2): translation, track, duration, lead-in, Analyse

**Executor** agent · **Size** S · **Prereqs** T-27.2, T-26.1 · **Status** todo

- **Read:** [09 §3](../09-ui-spec.md) (the Translation, Target track, Duration, Lead-in and
  Analyse rows)
- **Touches:** `panel/js/setup.js` · `panel/index.html` · `tests/panel/setup-controls.test.js`
  (new)
- **Steps:**
  1. Add the controls:
     - **Translation:** from `client.translations()`, with the attribution in small type
       underneath. It's disabled while the sidecar is unreachable.
     - **Track:** from `getSequenceInfo.videoTrackCount`, listed high to low (`V4 … V1`),
       defaulting to the topmost, with a **Refresh** button.
     - **Duration:** Auto or Fixed, plus a seconds input.
     - **Lead-in:** 0.5 by default, clamped to 0–3.
     - **Analyse:** enabled only when `analyseBlockers` is empty. Otherwise the **first**
       blocker is shown next to it.

     It emits `onAnalyse(request)`, using the 07 `POST /jobs` body shape. Commit.
  2. jsdom tests:
     - the track list is ordered high to low;
     - Refresh re-reads the tracks;
     - the attribution renders;
     - the lead-in clamps;
     - the Analyse reason text updates as each blocker is cleared;
     - the request body matches the 07 shape.

     Commit.
- **Verify:** `node --test tests/panel/setup-controls.test.js`
- **Done when:**
  - [ ] Analyse enables exactly according to the blocker rules, and a disabled Analyse always
        shows its reason.

### T-27.4 · Status strip and progress view

**Executor** agent · **Size** S · **Prereqs** T-27.3, T-26.3, T-49 · **Status** todo

- **Read:** [09 §2, §4](../09-ui-spec.md)
- **Touches:** `panel/js/progress.js` (new) · `panel/js/main.js` (wiring) · `panel/index.html` ·
  `tests/panel/status-progress.test.js` (new)
- **Steps:**
  1. Write `VSProgress.statusLine(lifecycleState, health, hasSequence)`, which returns
     `{icon, text, details?}` for every row of [09 §2]. Write
     `VSProgress.view({root, onCancel})` with methods `update({phase, progress, elapsed_s,
     eta_s})`, `cacheHit()` and `done()`.
     - The ETA appears only once progress passes 10%.
     - The phase label reads `Transcribing…`, `Detecting…` and so on.
     - Cancel calls `client.cancel`.
     - Setup collapses to a one-line summary while a job runs. Clicking the summary expands it
       again.

     Commit.
  2. Tests:
     - every status-strip row has its exact text, and the unreachable row has **Details** with
       the log path;
     - the ETA is hidden below 10%;
     - a cache hit shows `Using cached transcript`;
     - Cancel invokes the client.

     Run `npm run smoke` and look at `artifacts/smoke-happy.png`. Commit.
- **Verify:** `node --test tests/panel/status-progress.test.js && npm run smoke`
- **Done when:**
  - [ ] Every [09 §2] state and the [09 §4] behaviours are tested.
  - [ ] The smoke screenshot shows setup, the status strip, and the progress bar.

## Traps

- Persist field mappings **per MOGRT path**.
- Use the `cep.fs` dialogs. ExtendScript's `File.openDialog` fails in Premiere 2026.
