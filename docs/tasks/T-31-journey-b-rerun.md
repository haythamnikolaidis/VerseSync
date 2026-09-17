# T-31 · Journey B — the re-run

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 3 |
| **Estimate** | M |
| **Prereqs** | T-08, T-28, T-30 |
| **Unblocks** | T-32 |
| **Spec** | [00-prd.md §6](../00-prd.md) · [03 §4](../03-architecture.md) · [05 §5](../05-timing-and-placement.md) |

## Goal

Re-analysing an already-transcribed file after the sequence has been recut returns in seconds
with correctly updated anchors.

## Context you need

This is **half the product's value**, not a nice-to-have. Sermons get recut — an intro trimmed,
a section lifted — and without this the editor redoes everything.

It works because of a design choice already made: the Cue Document stores **source time only**
([07 §5.1](../07-sidecar-api.md)), so a recut invalidates the *mapping*, never the *analysis*.
Journey B is therefore a pure recomputation, and most of this task is verifying that the
existing pieces compose rather than writing new logic.

## Steps

1. Wire the cache-hit path through the UI: `POST /jobs` returns `cache_hit: true`, the
   `transcribing` phase is skipped, the bar races, and the panel shows *Using cached transcript*.
2. On every analysis — cached or not — re-call `VS.getMediaSegments` and re-derive **all**
   anchors against the **current** edit. Never reuse previously computed sequence times.
3. Verify `cut_from_edit` detection after a recut: cues whose source moment no longer appears in
   the sequence are flagged and disabled by default.
4. Verify the same for **Load cue document** — loading a saved document must re-map against the
   current sequence, not trust stored positions.
5. Confirm re-running after a recut where a section was *moved* (not deleted) produces correctly
   shifted anchors.

## Files

- `panel/js/main.js`, `panel/js/timemap.js` (verification and wiring; little new logic expected)

## Done when

- [ ] Recutting a sequence and re-analysing returns in **< 5 s** with correctly updated anchors.
- [ ] Cues cut from the edit are flagged `cut_from_edit` and disabled.
- [ ] Moving a section shifts the affected anchors correctly.
- [ ] Loading a saved Cue Document re-maps against the current sequence.
- [ ] The progress bar still ends at exactly 1.0 on a cache hit.

## Traps

- If you find yourself needing to store sequence ticks in the Cue Document to make this work,
  something upstream is wrong — that persistence is precisely what Journey B must not depend on.
- Test with a recut that **deletes** content and one that **moves** it. They exercise different
  paths through [05 §5.2](../05-timing-and-placement.md).
