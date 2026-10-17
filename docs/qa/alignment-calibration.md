# Alignment calibration (T-17.3)

Evidence for the READ / PARAPHRASE threshold of 0.55 ([05 §4.2](../05-timing-and-placement.md)),
measured on the bootstrap fixture corpus ([tests/fixtures/README.md](../../tests/fixtures/README.md)).
v1 ships 0.55 as specified (D24). This page does not move it; it is the input for a future
tuning pass ([T-34](../tasks/T-34-threshold-tuning.md)).

## Method

For every T-41 label whose `expected_classification` is `read` or `paraphrase`,
`tests/test_align_corpus.py`:

1. runs `detect()` over the fixture and picks the earliest detection that overlaps the label's
   `mention_span_s` and names the label's book and chapter;
2. fetches the label's passage from `LocalProvider` (the bundled KJV);
3. runs `align()` from that detection's first word and records `coverage`.

`test_calibration_doc_lists_every_measured_row` fails if the table below drifts from what the
test measures.

## Measurements

| Fixture | Reference | Mention (s) | Label | Coverage | Result |
|---|---|---|---|---|---|
| numbers-and-ordinals | 1 Corinthians 6:19-20 | 10.0 | read | 0.079 | paraphrase |
| numbers-and-ordinals | 2 Timothy 1:7 | 52.2 | read | 0.846 | read |
| numbers-and-ordinals | Psalm 119:176 | 149.4 | read | 1.000 | read |
| numbers-and-ordinals | Philippians 4:13 | 191.6 | read | 1.000 | read |
| context-and-ambiguity | Romans 8:28 | 10.0 | read | 1.000 | read |
| context-and-ambiguity | Romans 12:12 | 85.2 | paraphrase | 0.571 | read |
| read-vs-paraphrase | 1 Corinthians 13:4-7 | 10.0 | read | 1.000 | read |
| read-vs-paraphrase | 1 Corinthians 13:4-7 | 82.4 | paraphrase | 0.000 | paraphrase |
| read-vs-paraphrase | Joshua 1:9 | 125.0 | read | 1.000 | read |
| long-sermon-filler | John 3:16 | 540.9 | read | 1.000 | read |
| long-sermon-filler | John 3:16 | 1280.4 | read | 1.000 | read |

One labelled read, `3 John 2` at 225.4 s in numbers-and-ordinals, is not detected at all
("third john , verse two" has no chapter, a form the grammar lacks), so it has no coverage and
is left out. It is tracked in `KNOWN_UNDETECTED`.

## Distributions

| Class (by label) | n | Min | Median | Max | At or above 0.55 |
|---|---|---|---|---|---|
| read | 9 | 0.079 | 1.000 | 1.000 | 8 of 9 |
| paraphrase | 2 | 0.000 | 0.286 | 0.571 | 1 of 2 |

Read coverages: 0.079, 0.846 and seven values of 1.000. Paraphrase coverages: 0.000 and 0.571.

## Overlap

The two classes overlap, and the data does not show the clean gap that 05 §4.2 describes
("verbatim readings land between 0.6 and 0.9 coverage; genuine paraphrase rarely exceeds
0.35"):

- **A read below the threshold: 0.079** (1 Corinthians 6:19-20). The fixture speaker reads a
  modern translation ("Or do you not know that your body is the temple of the Holy Spirit")
  while the bundled text is KJV ("What? know ye not that your body is the temple of the Holy
  Ghost"). The classification is wrong because the verse text differs, not because the
  aligner failed. It points at the translation setting, not at the threshold.
- **A paraphrase above the threshold: 0.571** (Romans 12:12). The paraphrase keeps "rejoicing
  in hope" and "patient in tribulation", four of the seven KJV content words, and lands 0.021
  above 0.55. Any threshold that classifies the 0.846 read as read and this paraphrase as
  paraphrase has to sit in [0.571, 0.846), so 0.55 is not that threshold here.
- Verbatim readings in this corpus mostly score 1.000, not 0.6 to 0.9. The fixtures are
  hand-written and have no ASR error beyond the labelled "Philippines" case, so they are
  cleaner than real transcripts. The 0.6 to 0.9 band in 05 §4.2 is not reproduced.

With 11 measurements, 2 of them paraphrases, this is far too small to choose a threshold. Both
misclassifications are recorded in `KNOWN_MISCLASSIFIED` with their reasons, and the test fails
if either starts matching its label, so a future change that fixes them is noticed.


## Performance

`align()` over every detection in `long-sermon-filler` (about 7,000 words, 5 detections, two of
them chapter-only and aligned against the whole of John 3) must finish in under 1 s in total.
The bound is asserted by `test_long_sermon_alignment_is_fast`. Verse text is fetched before the
clock starts, since only alignment is in scope.
