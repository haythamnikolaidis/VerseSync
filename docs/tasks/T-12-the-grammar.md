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

## Status

### Output shape

Defined in `sidecar/versesync/detect/grammar.py` (module docstring and dataclasses). The mid-Wave-1
checkpoint in [13 §8](../13-technical-plan.md) reviews this shape.

```python
match_grammar(words, *, config=None, canon=None, matcher=None) -> GrammarResult

GrammarResult(normalized: Normalized, detections: tuple[Detection, ...])  # ordered by position

Detection(                            # frozen
    pattern: str                      # "P1".."P12"; the Cue Document's detection.pattern
    reference: Reference             # first reading, in the grammar's preference order
    alternatives: tuple[Alternative, ...]   # other readings of the same words; usually ()
    contextual: bool                 # True for P11/P12 (book and chapter carried)
    book_match: BookMatchInfo        # (tier: exact|alias|fuzzy, distance); a carried verse
                                     # inherits its source reference's
    token_span: tuple[int, int]      # INCLUSIVE indices into GrammarResult.normalized.tokens
    word_span: tuple[int, int]       # INCLUSIVE indices into the transcript word array
    source_start: float              # start of the first token of the match (source seconds)
    source_end: float                # end of the last token of the match
    word_probs: tuple[float, ...]    # one per distinct source word in the match
    carried_from: tuple[int, int] | None   # token_span of the reference a verse borrowed from
)
Reference(book, osis, chapter, verse: int | None, verse_end: int | None)   # frozen, .display
Alternative(reference: Reference, reason: str)                              # frozen
```

Contract notes:

- **Nothing is canon-validated or scored here** except the Psalms rule (which needs the canon to
  know whether each reading is valid). `Detection` carries no confidence; T-13 derives it from
  `book_match`, `pattern`/`contextual`, `mean_word_prob` and its own validation.
- `reference.verse is None` means chapter-only (P5, P9, P10 without a verse, a concatenated
  Psalm); `Detection.chapter_only` says so. It is never expanded to verse 1 (D12).
- `alternatives` are unranked competing readings; the grammar only orders them by the 04 §3.1
  preference (concatenated chapter first for Psalms). T-13 owns ranking.
- A carried P11/P12 detection's `token_span`, `word_span`, `source_start`, `source_end` and
  `word_probs` cover only the fragment ("verse twelve"). `carried_from` is the source
  reference's `token_span`. If the source has alternatives, the fragment carries onto each.
- Mention location for alignment: use `word_span` (stable across normalisations) and
  `source_start`/`source_end`. `token_span` indexes T-10's tokens, which `GrammarResult` hands
  back so the same array need not be rebuilt.
- Cue Document assembly copies `Detection.detection_block()` into `cue.detection` and
  `Reference.to_dict()` into `cue.reference`; both validate against
  `schemas/cue-document.schema.json` (`test_detection_block_matches_the_cue_document_schema`).
- Discarded fragments (no full reference inside the window) produce no record.

### Done when

- **Met** — Every P1-P12 table row passes with its tabulated example: `test_table_example`
  (P1-P10), `test_table_example_p11_and_p12_carry_from_a_full_reference` (P11, P12), plus three
  or more phrasings per pattern: `test_phrasings`,
  `test_every_full_pattern_has_at_least_three_phrasings`, `test_fragment_phrasings`.
- **Met** — Context carry works and a fragment beyond the window is discarded:
  `test_context_carry_inside_the_window`, `test_fragment_beyond_the_seconds_window_is_discarded`,
  `test_fragment_beyond_the_token_window_is_discarded_even_when_close_in_time`, both bounds
  inclusive (`test_seconds_window_boundary_is_inclusive`,
  `test_token_window_boundary_is_inclusive`), shorter-of-the-two
  (`test_the_window_is_the_shorter_of_the_two_bounds`), no leak across an intervening book
  (`test_context_does_not_leak_across_an_intervening_book`).
- **Met** — Psalms ambiguity emits two alternatives:
  `test_psalms_with_two_valid_readings_emits_both_concatenated_first` ("psalm twelve two" gives
  Psalm 122 and Psalm 12:2), `test_psalms_ambiguity_across_spellings`,
  `test_psalms_with_structure_between_the_numbers_is_not_ambiguous`,
  `test_psalms_ambiguity_survives_context_carry`.
- **Met** — Priority and span consumption: `test_p1_match_prevents_a_p9_match_on_the_same_words`,
  `test_p1_beats_p2_and_leaves_no_stray_number`, `test_longest_pattern_wins_and_consumes`,
  `test_p11_consumes_its_words_so_p12_cannot_take_the_first_verse`,
  `test_consumed_book_ordinal_is_not_stolen_as_a_number_by_the_previous_reference`,
  `test_priority_is_global_not_left_to_right`.
- **Met** — Chapter-only forms emit `verse = None`: `test_chapter_only_forms_emit_no_verse`,
  `test_concatenated_psalm_is_chapter_only`, `test_chapter_only_is_never_expanded_to_verse_one`.

Also covered: the negative fixtures through the whole grammar
(`test_ordinary_english_produces_no_detections`, `test_structure_words_alone_produce_nothing`),
all four transcript fixtures against their labels (`test_fixture_detections`,
`test_fixture_labels_are_all_found_with_matching_times`,
`test_fixture_negative_spans_produce_zero_detections`), span and timing round trips, and a seeded
random-stream invariant test.

### Behaviour beyond the 04 §4 table (all tested)

- An optional comma between the chapter number and the verse keyword in P3/P4 ("chapter 8,
  verse 28"); the T-41 fixtures contain it.
- Consecutive comma verse lists collapse to one range in P3, P6 and P11 ("verses 16, 17, and
  18", 04 §8); non-consecutive lists do not.
- P10 accepts a verse range, an optional comma, and any ordinal chapter number (T-10 normalises
  only first to third).
- P6/P7 connectors are exactly the tabulated ones: "john 3 , 16 - 18" yields P7 John 3:16.
  P8 takes two numbers only: "john 3 16 through 18" yields John 3:16.
- The context window is measured from the end of the reference's last token to the start of the
  fragment's first token, inclusive: 120.0 s and 400 tokens match, anything beyond is discarded.

### Gaps between the specs and the fixtures

- `numbers-and-ordinals` labels "Third John, verse two" as 3 John 2. P1-P12 have no pattern for a
  verse in a single-chapter book (every pattern needs a chapter number, or a prior reference for
  P11/P12), and T-11's gate does not open on "john , verse". The grammar therefore produces no
  3 John detection and carries "verse two" onto Philippians 4 (P12, contextual);
  `EXPECTED_FIXTURE_DETECTIONS` in `tests/test_grammar.py` pins this. Closing it needs a new
  pattern, which changes the frozen `detection.pattern` enum and T-11's gate, so it is left as
  a spec decision.
- `read-vs-paraphrase` labels the paraphrased second mention as 1 Corinthians 13:4-7; only
  "First Corinthians thirteen" is spoken, so the grammar emits chapter-only P9 and the verses are
  for alignment (05 §6) to find.
- doc 11 §1 says "psalm one nineteen" yields both readings; 04 §3.1 and this task require both
  to be canon-valid, and Psalm 1:19 is not (Psalm 1 has six verses), so only Psalm 119 is
  emitted. "psalm twelve two" (both valid) yields both.
