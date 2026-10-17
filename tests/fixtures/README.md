# Transcript fixtures (T-41)

Committed stand-ins for the sidecar's transcription output, so detection, resolution and timing
can be built and tested with **no audio, no GPU and no transcription**. See
[`docs/11-testing.md`](../../docs/11-testing.md) §3 and
[`docs/04-reference-detection.md`](../../docs/04-reference-detection.md) §9 for why this corpus
exists and what the *full-size* version (T-33) must eventually cover — this is the Wave 0
bootstrap, not the final corpus.

## Format

Each fixture is a pair of files in `tests/fixtures/transcripts/`:

- **`<name>.words.json`** — a flat JSON array of raw ASR words, in the exact shape the
  sidecar's transcriber emits (`docs/04-reference-detection.md` §3's `Word(text, start, end,
  probability)`), **before** any normalisation:

  ```json
  [ { "text": "Turn", "start": 10.0, "end": 10.38, "probability": 0.97 }, ... ]
  ```

  - `text` keeps whatever punctuation Whisper attaches to the word (`"world,"`, `"God."`).
    Stripping it is step 1 of normalisation (T-10), not this fixture's job.
  - Numbers are spelled out or digits inconsistently, on purpose — that inconsistency is
    exactly the problem T-10/T-11/T-12 exist to solve, so fixtures must not pre-normalise it.
  - Timestamps are **monotonic and non-overlapping**, at a natural speaking pace
    (~2–3 words/second). Unrealistic timing will tune T-17's alignment against the wrong curve.
  - `probability` is usually 0.9–1.0; a handful of words are deliberately given a lower value
    where the fixture represents an ASR mishearing (see `numbers-and-ordinals`'s
    "Philippines"-for-"Philippians" case).

- **`<name>.labels.json`** — a flat JSON array of hand labels, one per interesting utterance in
  the sibling `.words.json`. Three shapes:

  - **A detectable reference:**
    ```json
    {
      "reference": "1 Corinthians 6:19-20",
      "expected_classification": "read",
      "expected_anchor_s": 9.5,
      "mention_span_s": [10.0, 14.3],
      "read_span_s": [14.9, 20.1],
      "note": "optional, free text"
    }
    ```
    `expected_classification` is `"read"`, `"paraphrase"`, or `null` for a reference with
    nothing to classify yet (chapter-only, or an ambiguous pair — see below).
    `expected_anchor_s` follows D8 exactly: `min(mention_start, read_start) − 0.5` (lead-in),
    rounded to one decimal, `null` when there is nothing to anchor (a suppressed duplicate).
    `read_span_s` is present only when `expected_classification` is `"read"`.
  - **A Psalms-concatenation-ambiguity pair** adds `alternative_reference` alongside
    `reference` — same pair of candidates as T-37's `alternatives.json`.
  - **A negative case** (must produce zero matches):
    ```json
    { "reference": null, "negative": true, "span_s": [125.5, 129.4], "note": "..." }
    ```

## Fixtures in this bootstrap set

| File | Covers |
|------|--------|
| `numbers-and-ordinals` | Ordinal books (1 Corinthians, 2 Timothy reads), spoken numbers ("one hundred and nineteen", "one hundred and seventy six"), a chapter-only reference (Romans 8), the "Philippines"/Philippians ASR-mishearing case, one negative ("job"). |
| `context-and-ambiguity` | A context-carried verse (book/chapter established earlier, later mention gives only "verse twelve"), the Psalms concatenation ambiguity (Psalm 122 / Psalm 12:2, both canon-valid), the spoken number "twenty eight", two negatives ("mark", "faith/works/acts/dead"). |
| `read-vs-paraphrase` | The same passage (1 Corinthians 13:4-7) quoted verbatim, then paraphrased — the READ/PARAPHRASE classification boundary (T-17) — plus one more verse-range read (Joshua 1:9). |
| `long-sermon-filler` | ~7,000 words of scripture-free filler (explicitly allowed — see T-41 step 4) padding a realistic sermon length, with one mention repeated inside the 60s `duplicate_cooldown_s` (expect suppression) and again well outside it (expect a fresh, un-suppressed cue) — performance and duplicate-suppression. |

**Do not add sermon audio, real recordings, or anything with personal/pastoral content to this
directory** (risk R-12). Every fixture here is hand-authored text; there is nothing to
anonymise because nothing real went in.

## Loading them

```python
from transcript_fixtures import load_words, load_labels, FIXTURE_NAMES

words = load_words("numbers-and-ordinals")  # list[dict]
labels = load_labels("numbers-and-ordinals")  # list[dict]
```

See `tests/transcript_fixtures.py`. T-33 (growing this to the full-size corpus) should add new
`<name>.words.json` / `<name>.labels.json` pairs in this same shape — nothing else needs to
change.
