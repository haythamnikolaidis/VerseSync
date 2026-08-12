# T-18 · Anchors and durations

| | |
|---|---|
| **Workstream** | E — Timing |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-17 |
| **Unblocks** | T-19 |
| **Spec** | [05-timing-and-placement.md §3, §9](../05-timing-and-placement.md) |

## Goal

Compute each cue's **anchor in source seconds** and its duration. This is the number the whole
product exists to get right.

## Context you need

The anchor rule implements the product promise directly — *the earlier of "starts reading" and
"mentions the reference"*. Both orderings happen constantly in real preaching:

- *"Turn to John 3:16. For God so loved the world…"* → mention first, anchor on the mention.
- *"For God so loved the world… that's John 3:16."* → reading first, anchor on the reading.

**All output is source seconds.** The sidecar never sees a sequence, a tick or a frame rate —
that conversion is the panel's job (T-28). See [03 §7](../03-architecture.md).

## Steps

1. Implement the anchor rule from [05 §3.1](../05-timing-and-placement.md):

   ```
   anchor = min(mention_start, read_start_if_any) - lead_in_s
   anchor = max(anchor, 0.0)
   ```

   `read_start_if_any` counts **only if** the read span begins within `read_lookbehind_s`
   (default 20 s) before the mention. A reading that started two minutes earlier is a different
   moment, not this cue's opening.
2. Default `lead_in_s` to **0.5** (decision D9). A lower-third's animate-in takes ~0.5–1.0 s;
   anchoring exactly on the first spoken word leaves the graphic still sliding in as the
   reference is said.
3. Implement the three duration branches from [05 §3.3](../05-timing-and-placement.md):
   - **fixed** → `fixed_duration_s`
   - **READ** → `(read_end - anchor) + tail_pad_s`, clamped to
     `[min_duration_s, max_read_duration_s]` (45 s cap stops a runaway alignment producing a
     two-minute graphic)
   - **PARAPHRASE** → **VerseFlow's `js/duration.js` verbatim**: `(word_count / 160) * 60`,
     `+ 1.5`, rounded to 0.1 s, clamped `[3, 20]`. These constants are client-approved — port
     them, do not re-derive them.
4. Apply the **corroboration bonus (+0.10)** to confidence when a read span was found — the
   speaker demonstrably quoted the passage, which is strong independent evidence the reference
   was heard correctly ([04 §6](../04-reference-detection.md)).
5. Reproduce the worked example in [05 §9](../05-timing-and-placement.md) exactly as a test.

## Files

- `sidecar/versesync/timing/anchor.py`
- `tests/test_anchor.py`

## Done when

- [ ] The [05 §9](../05-timing-and-placement.md) worked example reproduces **exactly**.
- [ ] Both orderings (mention-first, reading-first) anchor correctly.
- [ ] A read span starting outside `read_lookbehind_s` is ignored for anchoring.
- [ ] PARAPHRASE durations match VerseFlow's `duration.js` output for the same word counts —
      test this against ported cases directly.
- [ ] The anchor never goes negative.

## Traps

- Duration is measured from the **anchor**, not from `read_start` — the lead-in is inside the
  graphic's life, not before it.
- The corroboration bonus is applied here, not in T-13, because only the timing stage knows
  whether a read span was found. T-13 leaves the hook.
- Emit seconds. Any tick or frame arithmetic appearing in this file is a design violation.
