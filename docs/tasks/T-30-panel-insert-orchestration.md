# T-30 · Panel: insert orchestration

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | T-31, T-32 |
| **Spec** | [09-ui-spec.md §6](../09-ui-spec.md) · [03 §4](../03-architecture.md) · [08 §6, §8](../08-premiere-host-api.md) |

## Goal

Turn an approved review list into a **single** `VS.insertCues` call, and report honestly what
landed. **This is where Journey A completes.**

## Subtasks

### T-30.1 · Pre-insert validation, payload, overwrite confirmation

**Executor** agent · **Size** S · **Prereqs** T-29.5, T-25.1 · **Status** done

- **Read:** [03 §4](../03-architecture.md) (pre-insert validation) · [08 §6, §8](../08-premiere-host-api.md) ·
  [09 §6](../09-ui-spec.md)
- **Touches:** `panel/js/insert.js` (new) · `tests/panel/insert-plan.test.js` (new)
- **Interface:**
  ```javascript
  VSInsert.blockers(ctx) -> [string]     // ordered; uses the same strings as VSState where they overlap, plus:
     // 'Enable at least one scripture to insert.' ,
     // 'Resolve the flagged cues before inserting: <ids>'   (any enabled cue with text_unavailable,
     //   passage_not_found, chapter_only, cut_from_edit or speed_change_unsupported)
  VSInsert.buildPayload(model, placements, ctx) -> { sequenceId, mogrtPath, trackIndex, mapping, cues:[…] }  // sorted by atTicks (numeric)
  VSInsert.confirmText(conflicts, trackIndex) -> "3 of your cues will overwrite existing clips on V3. Continue?"
  ```
- **Steps:**
  1. Implement these. The payload includes **only enabled cues**, each as
     `{id, atTicks, durationTicks, reference: reference_display, body}`. They're sorted by
     **numeric** tick value, never by string comparison. It uses the analysis's `sequenceId`.
     Commit.
  2. Tests:
     - each blocker;
     - sorting is numeric (`'9'` comes before `'10'`);
     - disabled cues are excluded;
     - the confirm text for one conflict and for several;
     - the payload's ranges don't overlap (the T-28.3 guarantee holds).

     Commit.
- **Verify:** `node --test tests/panel/insert-plan.test.js`
- **Done when:**
  - [x] The payload always satisfies the host's input contract from T-25.1.

### T-30.2 · Insert execution, progress, summary, partial re-run

**Executor** agent · **Size** S · **Prereqs** T-30.1, T-25.2, T-25.3 · **Status** todo

- **Read:** [09 §6](../09-ui-spec.md)
- **Touches:** `panel/js/insert.js` · `panel/js/main.js` · `tests/panel/insert-run.test.js` (new)
- **Steps:**
  1. Build the Insert click flow:
     - check the blockers;
     - call `validateTrack` with the payload ranges; if there are conflicts, ask with
       `confirm(confirmText)` (injected);
     - make **one** `bridge.call('insertCues', payload)`;
     - `com.versesync.progress` events update the button to *"Inserting… 7 / 16"*;
     - setup and review are disabled while it runs.

     Show a summary: *Placed 16 of 16.* or *Placed 14 of 16 — 2 failed, see details.*, with
     the failures expandable per cue. The first time a session does this, append
     *"One Ctrl+Z reverts the whole batch."* The review state is **kept**, and **Retry failed**
     re-inserts only the failed cue ids. A D20 sequence-changed error is shown verbatim, and
     nothing is inserted. Commit.
  2. Tests using the **real `VerseSync.jsx` loaded on the T-45 fake** as the bridge backend.
     That's a true integration test of panel and host:
     - 16 cues are inserted with one call;
     - a failing cue gives a partial summary, and Retry inserts only that cue;
     - conflicts trigger the confirm, and declining it inserts nothing;
     - focusing a different fake sequence before Insert gives the D20 message;
     - the undo log is a single pair.

     Commit.
- **Verify:** `node --test tests/panel/insert-run.test.js`
- **Done when:**
  - [ ] There is one `insertCues` call per batch.
  - [ ] A partial failure can be recovered.
  - [ ] The panel-and-host integration runs on the fake DOM.

### T-30.H · Journey A on a real workstation

**Executor** human · **Size** — · **Prereqs** T-30.2, T-25.H, T-07.H, T-20.5 · **Status** todo

Run steps 1–26 of [11 §6](../11-testing.md) on the reference workstation with a real sermon:
select media, Analyse, review, Insert, and check that the graphics land at the right moments
and that **one Ctrl+Z** removes the batch. Record the results in
`docs/qa/journey-a.md`. This is the old **Wave 2 exit criterion**.

**Accuracy spot-check (it replaces measurement for v1; D24).** While reviewing, write down five
counts:

- cues surfaced;
- cues unchecked because they were wrong;
- references added by hand because they were missed;
- cues whose anchor was visibly off;
- cues whose reference had to be edited.

This takes no annotation protocol and no extra session, and gives a first rough read on
precision, recall and review burden (M5). Record the counts in `docs/qa/journey-a.md`.

## Traps

- Sort before sending. An unsorted payload means this task has a bug, not the host.
- Times arrive already frame-snapped from `timemap.js`. The host doesn't snap them again.
- Don't disable the review list after a failed insert.
