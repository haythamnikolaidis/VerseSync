# T-03 · Spike: `importMGT` at an absolute time on a populated track

| | |
|---|---|
| **Workstream** | S — Spikes |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | T-01 |
| **Unblocks** | T-25 |
| **Spec** | [08-premiere-host-api.md §6.1](../08-premiere-host-api.md) · risk **R-4** in [12](../12-decisions-and-risks.md) |

## Goal

Answer one question: **does `importMGT` at an arbitrary time on a populated track overwrite
what is there, or insert-and-ripple everything after it?**

## Context you need

VerseFlow never had to know. It always placed contiguously from the playhead, and its field
discovery deliberately inserts *past the end* of the sequence. VerseSync places into the middle
of a populated timeline, so the answer decides the entire Premiere-side design.

- **Overwrite** (expected) → [08 §6](../08-premiere-host-api.md) works as written.
- **Ripple** → every insert shifts the editor's edit. That is a corrupted timeline, and the
  worst possible failure mode for this product.

## Steps

1. Build a sequence with clips on V1–V3 and known, identifiable content after 00:05:00.
2. `importMGT` at 00:02:00 on V3 where a clip already exists. Record:
   - is the existing clip overwritten, split, or pushed right?
   - does anything on **other tracks** move?
   - does the sequence duration change?
3. Repeat on an **empty** track, and past the end of the sequence.
4. Test `_setClipDuration` (from `VerseFlow.jsx`) extending a clip's `end` into an adjacent
   clip — this is a known open behaviour, see [02 §1.3](../02-source-project-audit.md).
5. Insert 20 cues **out of order**, and again **descending** by time. Verify final positions
   against requested positions in both cases.
6. Read back `clip.start` after each insert and compare to the requested ticks — this is what
   `actualStartTicks` in [08 §6](../08-premiere-host-api.md) is for.

## Files

- `spikes/absolute_insert/` — the test `.jsx`, and `RESULTS.md`

## Done when

- [ ] Documented behaviour for each case above.
- [ ] A recommendation: proceed as specified, require an empty track, insert descending, or
      fall back to Option B.
- [ ] The recommendation is reflected in T-25's task file before T-25 starts.

## Gate

**T-25 does not start without an answer here.** If the result is "ripple", the fallbacks are
pre-costed in [08 §6.1](../08-premiere-host-api.md), in order: (a) require and validate an empty
target track; (b) insert descending so ripples only affect already-placed cues; (c) VerseFlow's
Option B — pre-render each graphic and use `videoTracks[t].overwriteClip(projectItem, seconds)`,
which has unambiguous overwrite semantics and is already investigated in VerseFlow's
`docs/planning/11-alternative-approaches.md`.

## Traps

- Test on a sequence that looks like a **real edit**, not three clips on a blank timeline.
  Ripple behaviour can differ with linked audio, transitions and adjacent clips.
- Check linked audio specifically — a video-track ripple that drags audio is a different-sized
  problem from one that does not.
