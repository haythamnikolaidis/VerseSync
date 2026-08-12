# T-35 · Performance pass

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 3 |
| **Estimate** | M |
| **Prereqs** | T-30, T-31 |
| **Unblocks** | release |
| **Spec** | [01-requirements.md](../01-requirements.md) NFR-2 · [00-prd.md §5](../00-prd.md) (M4) |

## Goal

Verify NFR-2 on the reference workstation and record the measured numbers.

## Context you need

NFR-2's numbers are stated **for the reference GPU workstation** and must be reported as such —
a CPU-only machine may take longer to transcribe than the sermon lasts (risk R-10). Honest,
qualified numbers are the deliverable; a single unqualified figure is not.

M4 (editor time ≤ 10 min per 45-minute sermon, against a 60–90 min manual baseline) is the
product-level number these roll up into.

## Steps

1. Measure on the reference workstation, on a real 45-minute sermon:
   - **transcription ≤ 4 min**
   - **pipeline (detect + resolve + time) ≤ 15 s**
   - **cached re-run ≤ 5 s** (Journey B)
   - **a 40-cue insert without freezing the panel**
2. Tune `batch_size` for the reference GPU; record the value and the VRAM headroom it needs.
3. Profile the review list with 40 cues and several rows expanded — CEP's Chromium is old, and
   a re-render on every checkbox toggle will show.
4. Confirm the media hash (T-08) is well under a second on a 4 GB MXF.
5. Measure the `VS.getMediaSegments` walk on the longest available sequence.
6. Also measure a **CPU-only** run and state it plainly, so the warning in the panel
   ([09](../09-ui-spec.md), risk R-10) is based on a real number.
7. Record everything in the repo README with the workstation spec beside it.

## Files

- `README.md` (measured numbers + reference spec)
- `docs/qa/performance-results.md`

## Done when

- [ ] All four NFR-2 numbers are measured and met on the reference workstation.
- [ ] The measured numbers and the workstation spec are in the README.
- [ ] A CPU-only figure is recorded and the panel's warning threshold is set from it.
- [ ] The 40-cue review list stays responsive.

## Traps

- Measure a **cold** start too, including model load. First-run experience is what an editor
  judges the product on, and it is the slowest path.
- Do not report a number without the machine it was measured on.
