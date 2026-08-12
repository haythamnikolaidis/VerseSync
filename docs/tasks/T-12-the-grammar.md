# T-12 · The grammar

| | |
|---|---|
| **Workstream** | C — Detection |
| **Wave** | 1 |
| **Estimate** | L |
| **Prereqs** | T-10, T-11 |
| **Unblocks** | T-13, T-17 |
| **Spec** | [04-reference-detection.md §4](../04-reference-detection.md) |

## Goal

Match patterns **P1–P12** over the normalised search string and emit candidate references with
their token spans.

## Context you need

This is the core of detection. Patterns are tried **in priority order**; the first match wins
and **consumes its span**, so a later, looser pattern cannot re-match the same words. That
ordering is why `1 corinthians 6 : 19 - 20` yields one range (P1) rather than a bare chapter
(P9) plus noise.

⚠️ **Stream E depends on this task's output shape.** Agree it with them before hardening —
this is the mid-Wave-1 integration checkpoint in [13 §8](../13-technical-plan.md).

## Steps

1. Implement P1–P12 exactly as tabulated in [04 §4](../04-reference-detection.md), in priority
   order, as regexes over T-10's search string.
2. Implement **span consumption** — a matched span is unavailable to later patterns.
3. Convert every match's character span back to a token span, then to `(start, end)` seconds and
   word probabilities, via T-10's offset map.
4. Implement **context carry** for P11/P12: a bare verse reference inherits book and chapter
   from the most recent full reference, if that reference is within the context window —
   default **120 seconds or 400 tokens, whichever is shorter**. Outside the window, discard the
   fragment. Mark carried cues `contextual: true`.
5. Implement the **Psalms concatenation ambiguity** ([04 §3.1](../04-reference-detection.md)):
   when a book is followed by two bare numbers with no `:`, no comma and no chapter/verse
   keyword, and the book is Psalms, and both the concatenated and split readings are valid,
   emit **both** as alternatives. They surface in the Cue Document's `alternatives`
   ([07 §5.1](../07-sidecar-api.md)) so the review row can offer a one-click switch.
6. Chapter-only forms (P5, P9, P10-without-verse) emit `verse = None`. **Never expand to
   verse 1** — see decision D12.
7. Record which pattern matched; it goes into `detection.pattern` in the Cue Document.

## Files

- `sidecar/versesync/detect/grammar.py`
- `tests/test_grammar.py`

## Done when

- [ ] Every row of the [04 §4](../04-reference-detection.md) P1–P12 table has a passing test
      using its tabulated example.
- [ ] Context carry works, and a fragment beyond the window is discarded.
- [ ] The Psalms ambiguity emits two alternatives.
- [ ] Priority and span consumption are tested — a P1 match prevents a P9 match on the same
      words.
- [ ] Chapter-only forms emit `verse = None`.

## Traps

- The context window is *"120 seconds **or** 400 tokens, whichever is shorter"* — both bounds,
  not either.
- P11/P12 are the patterns most likely to attach to the wrong passage, which is why they take a
  confidence penalty in T-13. Do not widen the window to catch more of them.
- Emit alternatives; do not pick a winner. Ranking is [04 §6](../04-reference-detection.md)'s
  job (T-13) and the final call is the editor's (D4).
