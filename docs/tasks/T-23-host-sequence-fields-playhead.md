# T-23 · Host: sequence info, field discovery, playhead

| | |
|---|---|
| **Workstream** | G — Host (ExtendScript) |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-22 |
| **Unblocks** | T-24, T-25, T-27 |
| **Spec** | [08-premiere-host-api.md §1–3, §5, §7, §9](../08-premiere-host-api.md) |

## Goal

Port VerseFlow's host to `VerseSync.jsx` and implement `VS.ping`, `VS.getSequenceInfo`,
`VS.getMogrtFields` and `VS.setPlayhead`.

## Context you need

**Read [08 §1](../08-premiere-host-api.md) and VerseFlow's `docs/planning/02-adobe-research.md`
before writing a line.** The conventions there are not style preferences — each one is a bug
that was already paid for:

- **One file, no `#include`** — path resolution is unreliable in Premiere 2026.
- **`var fn = function(){}`, never `function fn(){}`** — `$.evalFile()` does not hoist
  declarations into persistent global scope in this engine. Violating this produces
  "undefined is not a function" at *call* time, not load time.
- **ES3, ASCII-only**, with the JSON polyfill at the top — this engine has no native `JSON`.
- **Never throw across the bridge.** Every function returns a JSON string.
- **Ticks are strings.**

## Steps

1. Port `VerseFlow.jsx` → `VerseSync.jsx`, namespace `VS`, keeping the polyfill and conventions.
2. `VS.ping` → `{pong, version, hostApi}` for the health check and version handshake;
   `hostApi` is `"1.1"` ([08 §11](../08-premiere-host-api.md)).
3. `VS.getSequenceInfo` — VerseFlow's version **extended** with `timebase`, `frameRate`,
   `zeroPointTicks`, `endTicks` and `sequenceID` (`app.project.activeSequence.sequenceID`; the
   identity the insert guard compares, risk R-13) ([08 §3](../08-premiere-host-api.md)).
4. `VS.getMogrtFields` — VerseFlow's logic **unchanged**. Keep all three detection strategies
   (`propertyType === 6`, then `=== 5`, then a `getValue()` probe for the substring
   `textEditValue`), the group-node handling for types `10` and `4`, the scratch-insert-past-
   the-end technique, and the open-sequence error message.
5. `VS.setPlayhead` — small function, disproportionate effect: it backs FR-6.6, letting an
   editor click a review row's timecode and hear the actual audio.
6. Use the exact error strings in [08 §9](../08-premiere-host-api.md). These are read by
   editors, not developers.

## Files

- `panel/jsx/VerseSync.jsx`

## Done when

- [ ] Field discovery returns **both** `Text` fields of `AV_Quote_04.mogrt` with **distinct
      indices** and group-qualified labels (`Title Main > Text`, `Description > Text`).
- [ ] `getSequenceInfo` returns `timebase` as the real ticks-per-frame integer.
- [ ] `getSequenceInfo` returns `sequenceID` as a non-empty string that differs between two open
      sequences and is unchanged after renaming a sequence.
- [ ] `ping` reports `hostApi: "1.1"`.
- [ ] `setPlayhead` moves the playhead.
- [ ] With no sequence open, every function returns the specified message, not an exception.

## Traps

- **`timebase` is load-bearing.** All frame snapping divides by it. Deriving ticks-per-frame
  from `frameRate` is wrong for 23.976 and 29.97 and produces cumulative drift across a 40-cue
  batch. Return Premiere's integer.
- **Keep index-based field targeting.** The reference template has two fields both named `Text`;
  `getParamForDisplayName` is ambiguous and would silently target the wrong one (risk R-8).
  This must not be "simplified" away.
- `zeroPointTicks` is for **display timecode only** ([05 §1](../05-timing-and-placement.md)).
  Do not use it in placement math.

## Status

Premiere is not available in the build environment. `panel/jsx/VerseSync.jsx` is executed under
Node by `tests/host-jsx.test.js` against a mock of the Premiere object model
(`tests/lib/premiere-mock.js`, `tests/lib/load-host.js`) shaped from docs/08 and the recorded T-02
spike data (`spikes/word_timestamps/graphic_raw.json`), with no native `JSON` so the file's own
polyfill is the one under test. The mock cannot prove that a live Premiere behaves the same way;
that is what the Deferred steps below are for.
`tests/jsx-conformance.test.js` and `npm run lint` enforce ES3, ASCII-only source, no function
declarations and no `#include`.

- **Deferred — needs Premiere.** Field discovery returns both `Text` fields of `AV_Quote_04.mogrt`
  with distinct indices and group-qualified labels. Logic is covered against a mock of that
  template (`tests/host-jsx.test.js`: "both Text fields of AV_Quote_04 ...", all three detection
  strategies, group types 10 and 4, scratch insert past the end, undo-group balance). The mock
  has the 45-property layout recorded in the T-02 dump: `Title Main` header at index 2 followed
  by `Text` at 3, `Description` header at 6 followed by `Text` at 7, propertyType undefined for
  every property, group headers whose getValue() is a ';'-joined GUID list, text leaves whose
  getValue() is the recorded JSON blob. The dump records only the two text fields, so the other
  41 property slots in the mock are placeholders, not the template's real properties. Steps for
  a human: open a sequence in Premiere, load the panel, select your `AV_Quote_04.mogrt` template,
  and confirm the field list shows `Title Main > Text` (index 3) and `Description > Text`
  (index 7) and that no scratch clip is left on the timeline.
- **Deferred — needs Premiere.** `getSequenceInfo` returns `timebase` as the real ticks-per-frame
  integer. The host passes `seq.timebase` through as a string and never derives it from
  `frameRate` (`tests/host-jsx.test.js`, "returns the real ticks-per-frame integer ..."; output
  equals `tests/fixtures/host/sequence-*.json`). Steps: in 29.97, 23.976 and 25 fps sequences,
  run `VS.getSequenceInfo('{}')` from the panel DevTools console and compare `timebase` with
  8475667200, 10594584000 and 10160640000.
- **Deferred — needs Premiere.** `setPlayhead` moves the playhead. Covered by the mock
  ("setPlayhead moves the playhead ..."); the call form is `seq.setPlayerPosition(ticksString)`
  as used in the T-02 spike. Steps: run `VS.setPlayhead('{"ticks":"30481920000000"}')` from the
  panel DevTools console and confirm the Program monitor moves to 120 seconds into the sequence
  (30481920000000 / 254016000000).
- **Met** — With no sequence open every function returns the specified message, not an
  exception: `getMogrtFields` returns the field-discovery message, `setPlayhead` returns `Open a
  sequence in Premiere first.`, `getSequenceInfo` returns `hasActiveSequence: false`, and `ping`
  still answers (`tests/host-jsx.test.js`, "with no sequence open no function throws ...", plus
  an exact-string test for each).
- **Deferred — needs Premiere.** `getSequenceInfo` returns `sequenceID` as a non-empty string that
  differs between two open sequences and is unchanged after renaming a sequence. The host passes
  `seq.sequenceID` through as a string (`tests/host-jsx.test.js`, "getSequenceInfo follows
  whichever sequence is active and stamps its ID", plus the missing-ID error test). Steps: open
  two sequences, run `VS.getSequenceInfo('{}')` from the panel DevTools console in each and
  confirm the two `sequenceID` values are non-empty and different; rename one sequence in the
  Project panel and confirm its `sequenceID` is unchanged.
- **Met** — `ping` reports `hostApi: "1.1"` (`tests/host-jsx.test.js`, ping tests assert the
  `{pong, version, hostApi}` payload with `hostApi` `"1.1"`).
