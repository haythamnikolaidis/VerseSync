# T-37 · Cue Document JSON Schema and golden fixtures

| | |
|---|---|
| **Workstream** | 0 — Foundations |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | T-40 |
| **Unblocks** | T-38, T-19, T-42, and all of stream F |
| **Spec** | [07-sidecar-api.md §5](../07-sidecar-api.md) |

## Goal

Turn the Cue Document from prose into a machine-checkable schema plus a set of realistic
example documents. **This is the single most important unblocking task in the project** — the
panel is built entirely against these fixtures before any Python pipeline exists.

## Context you need

The Cue Document is the sidecar's output, the panel's input, and the on-disk save format
(FR-6.8). Every time in it is **source seconds** — never sequence ticks. See
[07 §5.1](../07-sidecar-api.md) for why that separation is load-bearing.

## Steps

1. Write `schemas/cue-document.schema.json` (JSON Schema draft 2020-12) covering every field in
   [07 §5](../07-sidecar-api.md): `schema_version`, `job`, `translation`, `transcript`, `cues[]`,
   `warnings[]`.
2. Constrain the enums properly — `origin`, `classification`, and the full `flags` list from
   [07 §5.1](../07-sidecar-api.md). A typo'd flag should fail validation, not reach the UI.
3. Mark the panel-added flags (`cut_from_edit`, `multiple_placements`,
   `speed_change_unsupported`) as valid but note in the schema description that the sidecar
   never emits them.
4. Build **four** golden fixtures in `tests/fixtures/cue-documents/`:
   - `happy-18-cues.json` — a realistic sermon: mixed read/paraphrase, a range, a
     single verse, varied confidence.
   - `flagged.json` — at least one of every flag, including `text_unavailable` and
     `low_confidence`, plus a `warnings` entry.
   - `alternatives.json` — the Psalms concatenation ambiguity
     ([04 §3.1](../04-reference-detection.md)) and a multi-placement cue.
   - `empty.json` — zero cues, valid document. The panel must handle this.
5. Add a validator test asserting all four fixtures pass the schema, and that a deliberately
   corrupted copy fails.
6. Expose validation as a helper both languages can call in tests
   (`tools/validate_cue_document.py` plus a small JS assertion helper).

## Files

- `schemas/cue-document.schema.json`
- `tests/fixtures/cue-documents/*.json`
- `tools/validate_cue_document.py`

## Done when

- [ ] All four fixtures validate; a corrupted copy fails with a useful message.
- [ ] The fixtures are realistic enough to render a review list from — real book names, real
      verse text, plausible timings over a ~45-minute media duration.
- [ ] `schema_version` is `"1.0"` and the major/minor rule from
      [07 §5.2](../07-sidecar-api.md) is documented in the schema description.

## Traps

- Fixtures with placeholder text ("lorem ipsum", `cue_001`…`cue_018` all identical) are
  worthless — stream F will build a review list that looks fine and breaks on real data. Spend
  the extra hour making them real.
- **This file is frozen once Wave 1 starts.** Changing it later requires the contract protocol
  in [13 §8](../13-technical-plan.md).
