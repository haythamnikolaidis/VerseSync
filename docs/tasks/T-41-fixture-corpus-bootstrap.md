# T-41 · Fixture corpus bootstrap

| | |
|---|---|
| **Workstream** | 0 — Foundations |
| **Wave** | 0 |
| **Estimate** | L |
| **Prereqs** | T-40 |
| **Unblocks** | T-10, T-11, T-12, T-13, T-17, T-18, T-33 |
| **Spec** | [11-testing.md §3](../11-testing.md) · [04-reference-detection.md §9](../04-reference-detection.md) |

## Goal

Committed transcript fixtures — word arrays with timestamps, plus hand labels — so detection
and timing can be built and tested with **no audio, no GPU and no transcription**.

## Context you need

[11 §3](../11-testing.md) treats the corpus as an M2 deliverable and [12](../12-decisions-and-risks.md)
(risk R-2) calls it a deliverable rather than an afterthought. This task front-loads *enough* of
it to unblock streams C and E in Wave 1; T-33 grows it to full size for tuning.

The fixture format is the same word array the sidecar produces:
`[{ "text": "...", "start": 0.00, "end": 0.31, "probability": 0.98 }, …]`. Everything downstream
of transcription consumes exactly this, which is why faking it is enough.

## Steps

1. Define and document the fixture format in `tests/fixtures/README.md` — word array file plus
   a sibling `*.labels.json`.
2. Produce **at least three** transcript fixtures. Hand-authoring is acceptable and often
   better, because it lets you place hard cases deliberately. Between them they must cover:
   - spoken numbers including "one hundred and nineteen", "twenty eight" ([04 §3.1](../04-reference-detection.md))
   - ordinal books — "First Corinthians", "Second Timothy", "Third John"
   - a verse range, a single verse, and a chapter-only reference
   - a context-carried verse ("…and in verse twelve he says…")
   - the Psalms concatenation ambiguity
   - **negative cases** that must produce zero matches: "he lost his job", "faith without works
     acts dead", "mark my words"
   - one long verbatim reading (for read-span alignment, T-17) and one paraphrase of the same
     passage (for the classification boundary)
3. Hand-label each fixture: expected references in canonical form, expected classification, and
   the expected anchor time to the nearest 0.1 s.
4. Add one *realistic-length* fixture (~7,000 words) so performance and duplicate-suppression
   behaviour are exercised. Generating filler around the interesting spans is fine.
5. Add a loader helper shared by the Python tests.

## Files

- `tests/fixtures/transcripts/*.words.json`
- `tests/fixtures/transcripts/*.labels.json`
- `tests/fixtures/README.md`

## Done when

- [ ] Three or more fixtures with labels are committed and load in a test.
- [ ] Every bullet in step 2 is present in at least one fixture.
- [ ] The format doc is clear enough that T-33 can extend the corpus without asking.

## Traps

- **Do not commit sermon audio or anything with personal or pastoral content** — see risk R-12.
  Fixtures are text only, and hand-authored or anonymised.
- Timestamps must be *plausible*: monotonic, non-overlapping, and consistent with natural
  speaking pace (~2–3 words/second). T-17's alignment is timing-sensitive, and unrealistic
  fixtures will tune it wrongly.
