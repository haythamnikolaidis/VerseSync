# T-19 · Cue Document assembly

| | |
|---|---|
| **Workstream** | E — Timing |
| **Wave** | 1 |
| **Estimate** | S |
| **Prereqs** | T-18, T-37 |
| **Unblocks** | T-20 |
| **Spec** | [07-sidecar-api.md §5](../07-sidecar-api.md) |

## Goal

Assemble the pipeline's outputs into a **schema-valid Cue Document** — the sidecar's output, the
panel's input, and the on-disk save format.

## Context you need

T-37 already froze the schema and the golden fixtures, and the panel has been built against
them for weeks. **Your job is to conform to that contract, not to design it.** If you find the
schema genuinely wrong, use the contract change protocol in [13 §8](../13-technical-plan.md) —
do not quietly emit something different.

## Steps

1. Build the document per [07 §5](../07-sidecar-api.md): `schema_version` (`"1.0"`),
   `generated_at`, `job`, `translation`, `transcript`, `cues[]`, `warnings[]`.
2. Populate every cue field: reference object and `reference_display`, `body`,
   `body_word_count`, `body_truncated`, the four timing fields, `classification`,
   `read_coverage`, `read_start_s`/`read_end_s`, `confidence`, the `detection` block
   (pattern, contextual, `book_match`, `token_span`, `word_span`), `snippet`, `flags`,
   `alternatives`.
3. Write the transcript word array to a **sibling file** and reference it via
   `transcript.words_ref` — ~7,000 word objects must not be inlined. The panel fetches it only
   when an editor expands a row.
4. Emit only sidecar-owned flags. `cut_from_edit`, `multiple_placements` and
   `speed_change_unsupported` are added by the **panel** after mapping — never by you.
5. Set `origin: "detected"` for pipeline cues (manual and edited are set by the panel).
6. Populate `warnings[]` — e.g. `provider_partial` when some passages could not be fetched.
7. Validate every generated document against T-37's schema **in the code path**, not only in
   tests, so a malformed document never reaches the panel.

## Files

- `sidecar/versesync/cues.py`
- `tests/test_cue_document.py`

## Done when

- [ ] Generated documents validate against `schemas/cue-document.schema.json`.
- [ ] A document round-trips: write → read → identical.
- [ ] The transcript is a sibling file, not inlined.
- [ ] No panel-owned flag is ever emitted.
- [ ] A document generated from a fixture transcript is structurally indistinguishable from
      T-37's golden fixtures.

## Traps

- **All times here are source seconds** ([07 §5.1](../07-sidecar-api.md)). Sequence ticks are
  never persisted — that is precisely what keeps a saved Cue Document valid across a recut, and
  it is the reason Journey B is cheap.
- `schema_version` is `major.minor`. Adding a field is a minor bump; removing or retyping one is
  major and requires the contract protocol.
