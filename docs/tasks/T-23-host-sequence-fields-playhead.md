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
2. `VS.ping` → `{pong, version, hostApi}` for the health check and version handshake.
3. `VS.getSequenceInfo` — VerseFlow's version **extended** with `timebase`, `frameRate`,
   `zeroPointTicks` and `endTicks` ([08 §3](../08-premiere-host-api.md)).
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
