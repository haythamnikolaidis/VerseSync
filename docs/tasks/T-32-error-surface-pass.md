# T-32 · Error surface pass

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 3 |
| **Estimate** | M |
| **Prereqs** | T-30, T-31 |
| **Unblocks** | release |
| **Spec** | [03-architecture.md §8](../03-architecture.md) · [09 §7](../09-ui-spec.md) · [07 §3](../07-sidecar-api.md) |

## Goal

Every failure mode in the specification is implemented, reproducible on demand, and produces
the message it is supposed to.

## Context you need

The invariant behind all of it ([03 §8](../03-architecture.md)): **nothing reaches the timeline
that the editor has not seen in the review list, and anything that does is removable with one
Ctrl+Z.** A failure must never leave the timeline half-modified and unexplained.

Error messages here are read by **video editors, not developers**. "Could not load
large-v3-turbo on cuda: out of memory (9.1 GB free, ~10.4 GB required)" is right; a stack trace
is not.

## Steps

1. Walk every row of the [03 §8](../03-architecture.md) failure table and confirm the specified
   behaviour: sidecar won't launch · sidecar dies mid-job · model fails to load · media
   unreadable · Bible API unreachable · no sequence open · media not in sequence · MOGRT has no
   editable fields · a single `importMGT` fails mid-batch.
2. Walk every row of [09 §7](../09-ui-spec.md): before any analysis · analysis found nothing ·
   media not in the sequence · all cues disabled · provider down · job failed.
3. Confirm every `code` in [07 §3](../07-sidecar-api.md) has an editor-readable `message` and an
   actionable `hint` where one exists.
4. Build a **reproduction switch for each** — the mock sidecar's `--fail` flags (T-38) cover the
   sidecar side; add whatever is needed for host and panel failures. These must be triggerable
   on demand, in a minute, forever — that is what keeps them from rotting.
5. Verify **the sidecar-down path**: Analyse disabled with a clear message and log path, and
   **load-and-insert still fully working**.
6. Verify a mid-batch insert failure leaves the undo group intact — one Ctrl+Z still removes
   everything that did land.

## Files

- Panel and sidecar error paths; `docs/qa/error-reproduction.md` documenting each switch.

## Done when

- [ ] Every row of [03 §8](../03-architecture.md) and [09 §7](../09-ui-spec.md) is reproducible
      on demand and produces the specified message.
- [ ] No failure path shows a stack trace, a raw exception, or a spinner that never resolves.
- [ ] No failure path leaves the timeline modified in a way one Ctrl+Z cannot revert.
- [ ] The reproduction switches are documented.

## Traps

- The most common gap is the *silent* failure — a promise that never settles, leaving a spinner
  forever. Audit for those specifically; they are worse than an error message.
- A Bible API outage is a **successful job with flagged cues** (FR-4.5), not a failure. Verify
  it is presented that way.
