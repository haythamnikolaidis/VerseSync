# T-39 · Host stub and `VS.*` fixtures

| | |
|---|---|
| **Workstream** | 0 — Foundations |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | T-40 |
| **Unblocks** | T-22, T-27, T-28, T-29, T-30 |
| **Spec** | [08-premiere-host-api.md](../08-premiere-host-api.md) |

## Goal

A fake `VS` implementation that runs in an ordinary browser and answers every host call with
canned JSON. It lets the panel — including the review list and all the time mapping — be built
and unit-tested with no Premiere licence and no Windows workstation.

## Context you need

Real host calls go `panel → CSInterface.evalScript → ExtendScript`. The stub replaces the
bottom two layers. Because the bridge already normalises everything to *"JSON string in, JSON
string out"* ([08 §1](../08-premiere-host-api.md)), the seam is clean: the panel cannot tell the
difference.

## Steps

1. `panel/js/lib/host-stub.js` — implement all eight calls from
   [08](../08-premiere-host-api.md): `ping`, `getSequenceInfo`, `getMediaSegments`,
   `getMogrtFields`, `insertCues`, `setPlayhead`, `validateTrack`. Each takes a JSON string and
   returns a JSON string, exactly as the real host does.
2. Activate it only when Premiere is absent (no `CSInterface`), or behind an explicit
   `?stub=1`. **It must never load inside Premiere.**
3. Build fixtures in `tests/fixtures/host/` covering the cases stream F must handle:
   - `sequence-2997.json` — 29.97 fps, `timebase: "8475667"`. Also 23.976 and 25.
   - `sequence-none.json` — `hasActiveSequence: false`.
   - `segments-single.json` — one straight placement.
   - `segments-split.json` — media cut into three pieces with a gap (drives `cut_from_edit`).
   - `segments-duplicate.json` — the same media placed twice (drives `multiple_placements`).
   - `segments-speed.json` — a `speed !== 1.0` segment in `unsupported`.
   - `segments-none.json` — `matched: false` (drives the manual-offset fallback).
   - `mogrt-fields.json` — the two `Text` fields of `AV_Quote_04.mogrt` with **distinct
     indices** and group-qualified labels (see [08 §5](../08-premiere-host-api.md)).
4. `insertCues` in the stub must **assert its input contract** — sorted ascending by `atTicks`,
   ticks as strings — and return the per-cue results shape. It should fail loudly when the
   panel gets it wrong, since the real host does.
5. Add a scenario switcher so tests and manual demos can pick a fixture set.

## Files

- `panel/js/lib/host-stub.js`
- `tests/fixtures/host/*.json`

## Done when

- [ ] Opening `panel/index.html` in Chrome loads the panel and every `VS.*` call resolves.
- [ ] All eight calls return the shapes in [08](../08-premiere-host-api.md), including the
      `{ok:false,error}` form.
- [ ] The stub rejects unsorted `insertCues` input.
- [ ] Loading the panel inside Premiere does **not** activate the stub.

## Traps

- Ticks are **strings** everywhere ([08 §1](../08-premiere-host-api.md)). If the stub returns
  numbers, stream F will build against the wrong type and break on the real host.
- `timebase` must be the real ticks-per-frame integer, not derived from `frameRate` — the
  cumulative-drift bug in [08 §3](../08-premiere-host-api.md) is exactly what these fixtures
  exist to catch.
