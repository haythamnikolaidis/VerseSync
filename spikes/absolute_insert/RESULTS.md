# T-03 Results — `importMGT` on a populated track: overwrite or ripple?

See [T-03](../../docs/tasks/T-03-spike-importmgt-absolute-insert.md) for the
gate and fallback order, and `console-driver.md` for how each case was run.

Environment: Premiere version ____, sequence ____, timebase ____.

## Case 1 — insert at 00:02:00 on a populated track (V4, `trackIndex: 3`)

**Overwrite, via trimming the left-adjacent clip's tail. Confirmed, not ripple.**

- Pre-existing clip at that point (`AV Quote 04`, clipIndex 3):
  `[27667422720000, 31091558400000]` → trimmed to
  `[27667422720000, 30481920000000]` — its end moved back to meet the new
  clip's start.
- New clip inserted at exactly the requested point:
  `[30481920000000, 31955212800000]` (readback ticks match requested ticks
  exactly — see Case 6).
- Every other clip on the same track (previously clipIndex 4+) kept
  **identical start/end ticks**; they only shifted position in the track's
  item array (+1) to make room for the new entry. Track clip count went
  54 → 55, consistent with "one clip trimmed in place + one clip added,
  nothing else touched."
- No other track (video or audio) appears in the diff — nothing elsewhere in
  the sequence moved.

### Important caveat on how this was reached

The first several attempts at this exact test crashed with an opaque,
uncatchable ExtendScript error (`"EvalScript error."`), which **turned out
to be self-inflicted, not a real import/overwrite problem**:

1. An early call used an out-of-range `trackIndex`, which threw a *fatal*
   ExtendScript exception — one that **skips `try`/`catch` entirely**,
   confirmed by the fact that `app.endUndoGroup()` in the `catch` block never
   ran.
2. That left an **unclosed undo group** open in Premiere. Every subsequent
   call — even with fully valid inputs (valid track, valid ticks, valid
   native path, even a genuinely empty track) — then failed the same way,
   because Premiere's undo manager was in a broken state, not because of
   anything about the insert itself.
3. Calling `app.endUndoGroup()` repeatedly (`spikeFlushUndoGroups`) to drain
   the stuck groups, and removing undo-group wrapping from the spike
   functions going forward, resolved it. The test above is the first clean,
   reproducible result once that was fixed.

**This matters beyond the spike tooling.** [08 §6](../../docs/08-premiere-host-api.md)
specifies wrapping the *entire* cue batch in one `app.beginUndoGroup`/
`endUndoGroup` pair, with each cue individually try-wrapped so "a failing
cue is recorded and the loop continues." That assumption holds for
*catchable* failures, but if a cue triggers a *fatal* ExtendScript exception
(we don't yet know what reliably causes one — an out-of-range track index
did; whether any realistic production input could is still open), the whole
batch call aborts, `endUndoGroup()` is skipped, and the undo group is left
open for the rest of the Premiere session — breaking every subsequent edit,
not just that one cue. **Flag this as a new risk for T-25 and
[12-decisions-and-risks.md](../../docs/12-decisions-and-risks.md)**: the
per-cue try/catch in `VS.insertCues` needs a plan for the fatal-exception
case too (e.g. validate every cue's inputs — track index, ticks format —
*before* the undo group opens, so nothing inside it can throw something
`try`/`catch` can't see).

## Case 2 — insert on an empty track

Confirmed working (V6, `trackIndex: 5`, during the undo-group debugging
detour, and again as the target track for Case 5 below). Insert succeeds,
readback matches requested ticks exactly.

## Case 3 — insert past the end of the sequence

Confirmed working — this is exactly VerseFlow's own long-standing insertion
pattern (always places past the end of the sequence), and its 20-scripture
baseline insert with this same `.mogrt` succeeded with no changes.

## Case 4 — `_setClipDuration` extending into an adjacent clip

**Bad result — this does not overwrite/trim like `importMGT` does.**

- Clip 0 before: `[1249758720000, 4673894400000]`. Neighbour (clip 1):
  `[6502809600000, 9926945280000]`.
- Extended clip 0's duration so its new end (`7249758720000`) overlaps
  ~2.9s into clip 1's range.
- Clip 1's `nextStartTicks` is **unchanged** (`6502809600000`) — it was not
  trimmed, not pushed. `clip.end = ...` just sets the property and produces
  two genuinely overlapping track items. Confirmed visually — the editor
  reported this visibly breaks the timeline (overlapping/corrupted clips).

**This is a separate, more dangerous failure mode than the importMGT
question T-03 set out to answer, and needs its own mitigation before T-25 or
whichever task sets a cue's final duration.** Unlike `importMGT`, nothing
in `_setClipDuration` (or the `trackItem.end`/`outPoint` API it uses) will
self-resolve an overlap. Any cue whose requested duration runs past the next
clip's start — a neighbouring VerseSync cue, or an unrelated pre-existing
clip — will silently corrupt the timeline rather than erroring or trimming.
`VS.validateTrack` ([08 §8](../../docs/08-premiere-host-api.md)) as
specified only checks the **insertion point** range for conflicts; it needs
to check the **full requested duration span**, or the duration must be
clamped before `_setClipDuration` is ever called (timing/placement overlap
resolution per [08 §10](../../docs/08-premiere-host-api.md) — "No time
arithmetic beyond adding a duration to a start... overlap resolution... all
happen in timemap.js" — must guarantee this can never happen, since the host
will not catch it).

## Case 5 — 20 cues, shuffled order then descending order (plus a stress re-run)

**Overwrite trims from either side, order-independent. Confirmed clean.**

Run on the empty V6 track (`trackIndex: 5`), 20 cues spaced 5s apart
(0, 5, 10, ... 95s). Each clip is ~5.8s long (`1473292800000` ticks), so
every cue in every run already overlapped the previous cue's tail by design
— this doubles as an overlap stress test, not just an ordering test.

1. **Descending order, clean track:** all 20 `ok: true`, readback exact.
   Final `spikeClipsOnTrack` shows a **perfectly contiguous chain** — every
   clip's `endTicks` exactly equals the next clip's `startTicks`, spanning
   `0` → `25604812800000`, 20 clips, no gaps, no overlaps.
2. **This reveals `importMGT` trims from *either* side, not just the side
   Case 1 showed.** Case 1 showed trimming the *existing* clip's end when a
   new clip's start lands inside it. Here, with descending insertion, a new
   clip's *end* repeatedly overlapped the *start* of an already-placed
   (earlier-inserted-but-later-in-time) clip — and that existing clip got
   trimmed from its **front** instead. Whichever clip is overlapped loses
   the overlapped portion, regardless of which edge is encroached on, and
   regardless of insertion order.
3. **Stress re-run:** the shuffled-order batch was then inserted directly on
   top of the already-packed descending result (same 20 positions, nothing
   undone first). Final state: still exactly **20 clips**, still a fully
   contiguous chain (`endTicks == nextStartTicks` throughout), same overall
   span. Two full overlapping passes at identical positions converged
   cleanly with no duplication, no drift, no corruption.

Taken together with Case 1, this is strong evidence that `importMGT`'s
overwrite behavior is robust and order-independent, not a fragile result
that only held for one specific overlap shape.

## Case 6 — readback accuracy

`actualStartTicks` matched the requested `atTicks` exactly in every single
call across Cases 1, 2, 3 and 5 (40+ inserts total) — no observed drift or
snapping away from the requested tick value.

## Recommendation

- [x] **Proceed as specified (overwrite confirmed).** `importMGT` overwrites
      by trimming whichever existing clip it overlaps, from whichever edge
      is encroached on, order-independently. No ripple observed on the
      target track or any other track, across a single overlap (Case 1), an
      empty-track/past-end insert (Cases 2–3), and a 20-cue overlap stress
      test in two different insertion orders plus a repeated double-overlap
      pass (Case 5). [08 §6](../../docs/08-premiere-host-api.md) needs no
      design change for the overwrite question itself.
- [ ] Require an empty target track — not needed.
- [ ] Insert descending by time — not needed; order doesn't affect outcome.
- [ ] Fall back to Option B (`overwriteClip`) — not needed.

**Two follow-up risks surfaced during this spike, independent of the
overwrite/ripple question, both needing action before T-25 is considered
done:**

1. **`_setClipDuration` does not self-resolve overlaps (Case 4).** Setting
   `clip.end`/`outPoint` past the next clip's start silently produces
   overlapping, corrupted track items — no trim, no error. Whatever sets a
   cue's final duration (T-25, and the overlap-resolution logic in
   `timemap.js` per [08 §10](../../docs/08-premiere-host-api.md)) must
   guarantee a cue's duration can never run into the next clip before
   `_setClipDuration` is called — this cannot be caught or fixed on the host
   side.
2. **Fatal ExtendScript exceptions skip `try`/`catch` and leave undo groups
   open (see Case 1 caveat).** `VS.insertCues`'s per-cue try/catch
   ([08 §6](../../docs/08-premiere-host-api.md)) only protects against
   catchable failures. A fatal one (confirmed trigger: out-of-range track
   index; other triggers unknown) aborts the whole batch and leaves
   `app.endUndoGroup()` uncalled, corrupting undo for the rest of the
   session — not just failing that one cue. Validate everything that can be
   validated up front (track index against `seq.videoTracks.numTracks`,
   tick-string format) *before* `app.beginUndoGroup()` is called, so nothing
   inside the undo group can throw something uncatchable.

## Gate status

- [x] This file's recommendation has been reflected in
      [T-25](../../docs/tasks/T-25-host-insert-cues.md) before T-25 starts.
