# T-21 · CLI

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 2 |
| **Estimate** | S |
| **Prereqs** | T-20 |
| **Unblocks** | T-33 |
| **Spec** | [07-sidecar-api.md §6](../07-sidecar-api.md) |

## Goal

Run the whole pipeline from a terminal, with no HTTP and no Premiere.

## Context you need

This is **not a convenience**. Per [07 §6](../07-sidecar-api.md) it is how detection and timing
get developed and tested at all (NFR-5), how the accuracy harness runs (T-33), and how a support
issue gets reproduced without an editing workstation.

## Steps

1. Implement the three commands:

   ```
   python -m versesync.cli analyse D:/Sermons/sermon.mxf --translation kjv --out cues.json
   python -m versesync.cli detect  transcript.json --out detections.json
   python -m versesync.cli resolve "Romans 8:28" --translation kjv
   ```

2. **Call the same pipeline functions the service calls.** Not a reimplementation, not a copy —
   a second entry point to one pipeline.
3. `detect` takes a word-array file directly (the T-41 fixture format), so detection can be
   iterated with no audio.
4. Sensible exit codes and errors for scripting.
5. Write the **parity test**: CLI and HTTP produce identical Cue Documents for the same input.

## Files

- `cli/versesync_cli.py`
- `tests/test_cli_parity.py`

## Done when

- [ ] All three commands work as documented.
- [ ] The parity test passes — identical Cue Documents from CLI and HTTP for one input.
- [ ] `detect` runs against a fixture word array with no audio and no GPU.

## Traps

- Parity drift is the risk this task exists to prevent. If you find yourself writing pipeline
  logic in `cli/`, stop — it belongs in `sidecar/versesync/` and both entry points call it.
- Keep `--out` deterministic (T-13, [05 §10](../05-timing-and-placement.md)), or the parity test
  and the golden-file tests in [11 §4](../11-testing.md) will flake.
