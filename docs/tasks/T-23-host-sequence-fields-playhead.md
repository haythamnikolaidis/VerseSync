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

- [x] Field discovery returns **both** `Text` fields of `AV_Quote_04.mogrt` with **distinct
      indices** and group-qualified labels (`Title Main > Text`, `Description > Text`).
- [x] `getSequenceInfo` returns `timebase` as the real ticks-per-frame integer.
- [x] `getSequenceInfo` returns `sequenceID` as a non-empty string that differs between two open
      sequences and is unchanged after renaming a sequence.
- [x] `ping` reports `hostApi: "1.1"`.
- [x] `setPlayhead` moves the playhead.
- [x] With no sequence open, every function returns the specified message, not an exception.

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

`panel/jsx/VerseSync.jsx` is executed under Node by `tests/host-jsx.test.js` against a mock of
the Premiere object model (`tests/lib/premiere-mock.js`, `tests/lib/load-host.js`), with no
native `JSON` so the file's own polyfill is the one under test.
`tests/jsx-conformance.test.js` and `npm run lint` enforce ES3, ASCII-only source, no function
declarations and no `#include`.

Real Premiere Pro 2026 was available for this task's verification pass. `VerseSync.jsx` was
loaded with `$.evalFile()` into the same debug-mode ExtendScript engine VerseFlow's existing CEP
panel already registers (`PlayerDebugMode=1`, port 7778 — `D:/Development/Personal/VerseFlow/.debug`),
driven directly over that port's Chrome DevTools Protocol WebSocket (no separate GUI automation
needed, since the panel was already open and registered on the debug port) against
`assets/test/sermon/test_sequence.prproj`, which carries three real sequences at 29.97, 23.976 and
25 fps, and the real `assets/test/AV_Quote_04.mogrt`. Every item below was checked against that
live session; none of this task's "Done when" items needed to stay Deferred.

- **Met** — Field discovery returns both `Text` fields of `AV_Quote_04.mogrt` with distinct
  indices and group-qualified labels. Covered against the mock (`tests/host-jsx.test.js`: "both
  Text fields of AV_Quote_04 ...", all three detection strategies, group types 10 and 4, scratch
  insert past the end, undo-group balance) — and confirmed live: `VS.getMogrtFields('{"path":
  "D:/Development/Personal/VerseSync/assets/test/AV_Quote_04.mogrt"}')` against the real template
  in real Premiere returned exactly
  `{"fields":[{"index":3,"name":"Text","group":"Title Main","label":"Title Main > Text"},
  {"index":7,"name":"Text","group":"Description","label":"Description > Text"}]}`, with no
  scratch clip left on the timeline afterwards. This session also dumped every one of the real
  template's 46 properties directly (inserting a scratch instance and reading `mgt.properties[i]`
  for every `i`, same technique `VS.getMogrtFields` itself uses) to confirm the mock's layout is
  not inferred: `propertyType` is `undefined` on all 46, `Title Main` is the group header at index
  2 and `Description` at index 6 (each immediately followed by its `Text` field, confirming the
  adjacency the mock and doc 08 §5 assumed) — these are 2 of 15 GUID-list group headers found
  across the template's full property list; one further property (index 0) is a plain string
  holding the template's own name; and the other 28 properties are a mix of plain numbers,
  two-element coordinate arrays and booleans — none of them a GUID-list string or a
  `textEditValue` blob, so `vsIterateProperties` correctly finds only indices 3 and 7
  (15 group headers + 2 text fields + 1 plain-string name + 28 plain number/array/boolean = 46).
  See
  `tests/lib/premiere-mock.js`'s `avQuote04Specs()` for the full recorded layout and
  [08 §5](../08-premiere-host-api.md#5-vsgetmogrtfields) for the summary.
- **Met** — `getSequenceInfo` returns `timebase` as the real ticks-per-frame integer. The host
  passes `seq.timebase` through as a string and never derives it from `frameRate`
  (`tests/host-jsx.test.js`, "returns the real ticks-per-frame integer ..."). Confirmed live:
  `VS.getSequenceInfo('{}')` against the project's three real sequences returned `timebase`
  `"8475667200"` for the 29.97 fps sequence, `"10594584000"` for the 23.976 fps sequence and
  `"10160640000"` for the 25 fps sequence — matching [08](../08-premiere-host-api.md) §3 and the
  [12](../12-decisions-and-risks.md) errata exactly.
- **Met** — `setPlayhead` moves the playhead. Covered by the mock ("setPlayhead moves the
  playhead ..."). Confirmed live: with the 29.97 fps sequence active and its playhead at tick
  `"0"`, `VS.setPlayhead('{"ticks":"254016000000"}')` returned
  `{"ok":true,"data":{"ticks":"254016000000"}}` and `seq.getPlayerPosition().ticks` read back
  `"254016000000"` immediately after (1 second, `254016000000 / VS_TICKS_PER_SECOND`).
- **Met** — With no sequence open every function returns the specified message, not an
  exception: `getMogrtFields` returns the field-discovery message, `setPlayhead` returns `Open a
  sequence in Premiere first.`, `getSequenceInfo` returns `hasActiveSequence: false`, and `ping`
  still answers (`tests/host-jsx.test.js`, "with no sequence open no function throws ...", plus
  an exact-string test for each). This is pure conditional logic (`if (!seq) return ...`) with no
  Premiere-version-specific behaviour to verify, so the mock's coverage is sufficient; the one
  thing confirmed live is that `app.project.activeSequence` cannot be forced to a falsy value by
  script at all — `app.project.activeSequence = null` from the panel's DevTools console raised
  `TypeError: Cannot set property activeSequence`, consistent with it being a read-only reflection
  of Premiere's own UI tab focus rather than panel-settable state. Driving a literal
  zero-sequences-open session would require closing a sequence tab through the UI, which has no
  ExtendScript equivalent and so is out of reach of this console-driven verification; the mock's
  direct exercise of the `if (!seq)` branch is the full coverage this item needs.
- **Met** — `getSequenceInfo` returns `sequenceID` as a non-empty string that differs between two
  open sequences and is unchanged after renaming a sequence. The host passes `seq.sequenceID`
  through as a string (`tests/host-jsx.test.js`, "getSequenceInfo follows whichever sequence is
  active and stamps its ID", plus the missing-ID error test). Confirmed live against the test
  project's three real sequences: `sequenceID` was `"52e87756-8754-4eba-9033-dfba267be30a"` (25
  fps), `"541d5dd1-36b1-4165-ad48-bea3a561cdfe"` (29.97 fps) and
  `"63d3ecde-883f-4750-a5d3-fd2f5d4114f7"` (23.976 fps) — all non-empty and pairwise distinct.
  Renaming the 25 fps sequence from `Sequence 25fps` to `Sequence 25fps RENAMED` in the same
  session and re-reading `sequence.sequenceID` returned the identical
  `"52e87756-8754-4eba-9033-dfba267be30a"`; the name was restored afterwards.
- **Met** — `ping` reports `hostApi: "1.1"` (`tests/host-jsx.test.js`, ping tests assert the
  `{pong, version, hostApi}` payload with `hostApi` `"1.1"`). Confirmed live:
  `VS.ping('{}')` against real Premiere returned
  `{"ok":true,"data":{"pong":true,"version":"1.0.0","hostApi":"1.1"}}`.

**Observation outside this task's Done-when list, recorded for completeness:** in this real
Premiere Pro 2026 build, `app.beginUndoGroup` is not a function (confirmed live: calling it
directly throws `ReferenceError: app.beginUndoGroup is not a function`). `VS.getMogrtFields`
already wraps the call in `try { app.beginUndoGroup(...); undoOpen = true; } catch (e) {}`, so
this does not break field discovery — the scratch insert and removal both still happen correctly,
only `undoOpen` never becomes `true` and `app.endUndoGroup()` is correctly never called to match —
but it does mean the scratch insert/remove is not actually wrapped in a visible undo group on
this Premiere build, consistent with VerseFlow's own documented finding
(`docs/planning/02-adobe-research.md` §8 in the VerseFlow repository: "Premiere's ExtendScript
undo-group support is less complete than After Effects'; verify empirically") and its
`app.beginUndoGroup && app.beginUndoGroup(...)` feature-detection guard. No code change follows
from this for T-23: the mock's `state.undoDepth` bookkeeping models the *contract* (open before
mutating, close after, no leaks) rather than this one build's incomplete implementation of it,
and the host's existing try/catch already degrades safely either way.
