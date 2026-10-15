# T-47 · Contract: host API 1.1, sequence identity (R-13)

**Executor** agent · **Size** S · **Prereqs** — · **Status** in-progress

| | |
|---|---|
| **Workstream** | 0 — Agent enablement (a contract change) |
| **Unblocks** | T-23.1, T-24, T-25.1, T-28.4, T-30.1 |
| **Spec** | [12 R-13](../12-decisions-and-risks.md) · [08 §3, §4, §6, §8, §9](../08-premiere-host-api.md) |

## Goal

Close risk R-13 *before* any host or panel code is written against the old contract.
`app.project.activeSequence` follows UI focus, so `VS.insertCues` can silently land in the wrong
sequence if the editor switches tabs between Analyse and Insert.

## Decision (D20, already recorded in [12](../12-decisions-and-risks.md))

- `VS.getSequenceInfo` returns **`sequenceId`**, Premiere's `sequence.sequenceID` string.
- `VS.getMediaSegments`, `VS.validateTrack` and `VS.insertCues` take a **required**
  `sequenceId` argument. Before touching anything, the host compares it to
  `app.project.activeSequence.sequenceID`. If they differ, it returns:
  `The active sequence changed since this analysis. Switch back to "<name>" or click Analyse again.`
  Here `<name>` is the name of the sequence whose ID matches, looked up in
  `app.project.sequences`. If no sequence has that ID, it returns `Open a sequence in Premiere first.`
- The host **never** silently changes the active sequence.
- `hostApi` goes from `"1.0"` to `"1.1"`. The new argument is required, but nothing has consumed
  1.0 yet, so this is a minor bump.

The full contract-change protocol applies ([13 §8](../13-technical-plan.md)): the spec, the
fixtures and the stub all change in **this one PR**.

## Steps

1. **Spec.** In [08](../08-premiere-host-api.md):
   - add `sequenceId` to the §3 example, with a note;
   - add `sequenceId` to the §4, §6 and §8 request examples;
   - add the new message to the §9 table;
   - change the `hostApi` value in §2 to `"1.1"`.

   D20 and the R-13 update are already in [12](../12-decisions-and-risks.md); leave that file
   alone. Commit: `T-47 [1/3] spec`.
2. **Fixtures and stub.**
   - Add `"sequenceId"` to every non-empty `tests/fixtures/host/sequence-*.json`, as a distinct
     GUID-like string each.
   - Update the matching literal data in `panel/js/lib/host-stub.js`. The test
     `host-stub-fixtures-sync.test.js` enforces that it matches.
   - Make the stub compare the `sequenceId` argument for the three calls. Add a
     `__setScenario({ focusedSequence })` switch that simulates the editor changing tabs.
   - Bump the stub's `hostApi` to `1.1`.

   Commit: `T-47 [2/3] fixtures and stub`.
3. **Tests.** Extend `tests/host-stub.test.js` with these cases:
   - a matching ID passes;
   - a mismatched ID returns the exact §9 message;
   - a missing `sequenceId` on `insertCues` returns `ok:false`.

   Commit: `T-47 [3/3] tests`.

## Verify

`npm test`

## Done when

- [ ] 08 describes D20, and `hostApi` is `1.1` everywhere.
- [ ] The fixtures, the stub and the sync test all agree.
- [ ] The stub rejects a mismatched sequence with the exact message.

## Traps

- `sequenceID` stability across separate `evalScript` calls is *assumed*. T-25.H verifies it on
  real Premiere. If it turns out to be unstable, the fallback is to compare `name` plus `end`.
  That's a follow-up contract task, not an improvisation.
