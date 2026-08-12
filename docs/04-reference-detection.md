# 04 — Reference Detection

**This is the algorithm the product stands on.** Everything else is plumbing around it. Read
this before writing anything in `sidecar/versesync/detect/`.

The job: given an array of transcript words with timestamps, produce a list of canonical
scripture references, each with the exact token span that produced it and a confidence score.

---

## 1. Why this is harder than a regex

A preacher does not say "John 3:16". Across ten real sermons, the same reference appears as:

| What is said | What Whisper typically writes |
|--------------|-------------------------------|
| "John three sixteen" | `John three sixteen` or `John 3 16` or `John 3:16` |
| "John chapter three verse sixteen" | `John chapter 3 verse 16` |
| "the third chapter of John, verse sixteen" | `the third chapter of John, verse 16` |
| "First Corinthians six, nineteen and twenty" | `1 Corinthians 6, 19 and 20` or `First Corinthians 6:19 and 20` |
| "Second Timothy chapter two" | `2 Timothy chapter 2` |
| "…and verse five tells us…" | `and verse 5 tells us` (book from earlier context) |
| "Psalm one nineteen" | `Psalm 119` or `Psalm 1 19` or `Psalm one nineteen` |
| "turn with me to Philippians four" | `turn with me to Philippines 4` ← **ASR error** |

Four distinct problems stack up:

1. **Number rendering is inconsistent.** Whisper's normalisation is context-dependent; the same
   utterance can come out spelled or in digits within one transcript.
2. **Structure varies.** Colon, comma, "chapter"/"verse" keywords, inverted forms, or nothing
   at all between the two numbers.
3. **Book names get misheard**, especially the ones with no everyday English neighbours.
4. **Book names are often everyday English words.** "Job", "Mark", "Acts", "Numbers", "Judges",
   "Kings", "Romans", "Revelation" all appear in ordinary sermon speech. A naive book-name
   search produces false positives on nearly every page.

The design answers all four: normalise aggressively, match a **grammar** rather than a single
pattern, allow fuzzy book matches but **gate them on a following number pattern**, and
**validate against the canon** to throw out the impossible.

---

## 2. Stage 0 — biasing the decoder (before detection runs)

The cheapest accuracy win is upstream: tell Whisper what to expect. `faster-whisper` accepts an
`initial_prompt` that conditions the decoder's vocabulary.

```python
SCRIPTURE_PROMPT = (
    "A sermon quoting the Bible. Books mentioned may include: "
    "Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, "
    "1 Samuel, 2 Samuel, 1 Kings, 2 Kings, 1 Chronicles, 2 Chronicles, Ezra, "
    "Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Song of Solomon, "
    "Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, "
    "Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, "
    "Matthew, Mark, Luke, John, Acts, Romans, 1 Corinthians, 2 Corinthians, "
    "Galatians, Ephesians, Philippians, Colossians, 1 Thessalonians, "
    "2 Thessalonians, 1 Timothy, 2 Timothy, Titus, Philemon, Hebrews, James, "
    "1 Peter, 2 Peter, 1 John, 2 John, 3 John, Jude, Revelation. "
    "For example: John 3:16, Romans 8:28, 1 Corinthians 13:4-7."
)
```

Two caveats a developer will hit:

- Whisper's prompt window is **224 tokens**. The string above is close to that limit; measure
  it and trim the example sentence first if it overflows.
- `initial_prompt` conditions only the first window. With `condition_on_previous_text=True`
  (the default) the effect propagates, but it also risks repetition loops on long audio. Set
  `condition_on_previous_text=False` and accept that the prompt's influence fades, **or** keep
  it True and rely on VAD to break loops. **Spike T-02 decides this empirically** — it is a
  measurable A/B against hand-labelled audio, not a judgement call.

The prompt is a *bias*, not a guarantee. Everything downstream still assumes the book name may
be wrong.

---

## 3. Stage 1 — normalisation

Input: `Word(text, start, end, probability)[]` from the transcriber.

Build a parallel **token array** where every token keeps a back-reference to the word (or
words) it came from. This back-reference is what makes timestamps recoverable at the end, and
losing it is the single easiest way to get this module wrong.

```python
@dataclass
class Token:
    text: str          # normalised surface form
    kind: str          # 'word' | 'number' | 'ordinal' | 'punct'
    value: int | None  # numeric value when kind is number/ordinal
    word_ids: list[int]  # indices into the original Word array
    start: float       # seconds, from the first source word
    end: float         # seconds, from the last source word
    prob: float        # min probability across source words
```

Normalisation steps, in order:

1. **Case-fold** and strip surrounding punctuation, keeping `:` and `-` as their own tokens
   (they are structural).
2. **Split hyphenated numerals** — `twenty-eight` → one token, value 28.
3. **Collapse number words into numeric tokens** using the spoken-number parser (§3.1).
4. **Map ordinals** — `first`, `1st`, `one` (when followed by a book name) → ordinal token
   value 1. Same for second/third.
5. **Preserve digits as-is**, `3` → number token value 3.
6. Leave everything else as a `word` token.

Then produce a **search string**: the token texts joined by single spaces, with a
`char_offset → token_index` map. The grammar in §4 runs as regexes over this string, and every
match's character span converts back to a token span, and from there to `(start, end)`
timestamps and word probabilities. This gives regex ergonomics without losing timing — the
technique the implementation should follow.

### 3.1 Spoken-number parsing

Must handle the full range that appears in references: chapters up to **150** (Psalms) and
verses up to **176** (Psalm 119:176).

```
units      one..nineteen                → 1..19
tens       twenty, thirty … ninety      → 20, 30 … 90
compound   tens + unit                  → "twenty eight" = 28, "forty two" = 42
hundreds   unit + "hundred"             → "one hundred" = 100
           + optional "and" + remainder → "one hundred and nineteen" = 119
```

Two ambiguities that matter, both from real sermons:

- **"Psalm one nineteen"** means Psalm 119, not Psalm 1 verse 19. Rule: when a book is followed
  by two bare number tokens with no `:`, no comma, and no `chapter`/`verse` keyword, and the
  book is **Psalms**, and `concat(n1, n2)` is a valid chapter while `n1:n2` is *also* valid,
  emit **both** candidates and let §6 rank them — with the concatenated reading preferred for
  Psalms and the split reading preferred elsewhere. Surface the alternative in the review row.
- **"one Corinthians"** is the book, not the number one. Resolved by the ordinal rule in
  step 4: a unit number immediately preceding a book name that *has* a numbered form
  (Samuel, Kings, Chronicles, Corinthians, Thessalonians, Timothy, Peter, John) is an ordinal
  prefix, never a chapter.

---

## 4. Stage 2 — the grammar

Patterns are tried **in priority order**; the first match wins and consumes its span. Written
here against the normalised search string, where `N` is a number token, `B` is a matched book
name, `ORD` an ordinal prefix.

| # | Form | Example (normalised) | Yields |
|---|------|----------------------|--------|
| **P1** | `[ORD] B N : N - N` | `1 corinthians 6 : 19 - 20` | book, ch, v, vEnd |
| **P2** | `[ORD] B N : N` | `john 3 : 16` | book, ch, v |
| **P3** | `[ORD] B chapter N verse[s] N (through\|to\|-\|and) N` | `john chapter 3 verses 16 through 18` | book, ch, v, vEnd |
| **P4** | `[ORD] B chapter N verse[s] N` | `2 timothy chapter 2 verse 15` | book, ch, v |
| **P5** | `[ORD] B chapter N` | `romans chapter 8` | book, ch |
| **P6** | `[ORD] B N , N (and\|through\|to) N` | `1 corinthians 6 , 19 and 20` | book, ch, v, vEnd |
| **P7** | `[ORD] B N , N` | `john 3 , 16` | book, ch, v |
| **P8** | `[ORD] B N N` | `john 3 16` | book, ch, v (see Psalms rule §3.1) |
| **P9** | `[ORD] B N` | `romans 8` | book, ch |
| **P10** | `the ORD chapter of [ORD] B (, verse[s] N)?` | `the third chapter of john , verse 16` | book, ch, v? |
| **P11** | `verse[s] N (through\|to\|and\|-) N` | `verses 19 through 20` | **context**: v, vEnd |
| **P12** | `verse N` | `verse 5` | **context**: v |

**Context carry (P11, P12).** A bare verse reference inherits the book and chapter from the
most recent full reference, provided that reference is within a **context window** — default
**120 seconds** or **400 tokens**, whichever is shorter. Outside the window the fragment is
discarded. Context-carried cues are marked `contextual: true` and receive a confidence penalty
(§6), because this is the pattern most likely to attach to the wrong passage.

**Chapter-only forms (P5, P9, P10-without-verse)** produce a reference with `verse = None`.
These are handled specially at resolution time — see [05](05-timing-and-placement.md) §6. They
are **not** silently expanded to verse 1.

### 4.1 Book matching

`B` resolves through three tiers, tried in order:

1. **Exact** match against the canonical name or a curated alias
   (`psalm`/`psalms`/`ps`, `song of solomon`/`song of songs`/`canticles`, `revelation`/
   `revelations` — the plural is wrong but ubiquitous in speech).
2. **Curated ASR-confusion table** — a hand-maintained map of observed mishearings, grown from
   the fixture corpus. Seed entries:

   | Heard | Book |
   |-------|------|
   | philippines, philippi ans | Philippians |
   | collations, colossions | Colossians |
   | tight us, titus's | Titus |
   | have a cook, habakuk, habbakuk | Habakkuk |
   | ecclesiasties, ecclesiastes' | Ecclesiastes |
   | thessalonians variants, thessalonica ns | Thessalonians |
   | deuter onomy, deuteronomy's | Deuteronomy |
   | zachariah, zecharia | Zechariah |
   | nehemia, nehamiah | Nehemiah |

3. **Fuzzy** — Levenshtein distance ≤ 2 on strings of length ≥ 6, ≤ 1 for shorter, computed
   against canonical names and aliases. Also try a phonetic key (Double Metaphone) as a
   secondary signal.

**The gate that makes this safe:** tiers 2 and 3 only fire when the candidate is **immediately
followed by a number pattern** matching P1–P10. Without that gate, "job" in "he lost his job"
and "acts" in "faith without works acts dead" would each produce a reference. With it, they
cannot: no number follows.

Short high-frequency book names — **Job, Mark, Acts, Numbers, Judges, Ruth, James, Amos** —
carry an additional restriction: they match at **tier 1 only** (exact), never fuzzy. Their edit
neighbourhoods in English are too dense for fuzzy matching to be net-positive, and losing a
fuzzy match on "Mark" costs one review row while gaining one costs credibility.

---

## 5. Stage 3 — canon validation

Every candidate is checked against a canon table holding, per book: canonical name, OSIS id,
aliases, chapter count, and **verses per chapter**.

Rejections:

- Book not in the canon → discard.
- `chapter > book.chapter_count` → discard. (Kills "Jude 5:1" — Jude has one chapter.)
- `verse > book.verse_counts[chapter]` → discard, **unless** the number is a plausible
  concatenation (see the Psalms rule) in which case try the alternative reading.
- `verse_end < verse_start` → swap if the swap validates, otherwise drop the end.
- `verse_end - verse_start > max_range` (default 30) → treat as a mis-parse, drop the end.

This single stage removes a large share of false positives at effectively zero cost, because
number mishearings usually produce impossible references rather than merely wrong ones.

The verse-count table is a static data file shipped with the sidecar
(`detect/data/canon.json`). It must be generated once and checked in, not fetched at runtime.

---

## 6. Stage 4 — confidence scoring

Every surviving candidate gets a score in `[0,1]`. The score drives review-row flagging
(FR-6.5) and nothing else — **no cue is ever auto-discarded on confidence alone**, because D4
puts a human in the loop and a low-confidence true positive is far cheaper to surface than to
lose.

```
confidence = clamp01(
      0.40 * book_score        # 1.0 exact · 0.85 curated alias · 0.65 fuzzy (scaled by distance)
    + 0.25 * asr_score         # mean word probability across the matched span
    + 0.25 * structure_score   # 1.0 book+ch+verse · 0.75 book+ch+verse-range
                               # 0.55 chapter-only · 0.45 context-carried
    + 0.10 * validation_score  # 1.0 fully valid · 0.5 valid only after an alternative reading
)
```

Weights are constants in `detect/detector.py` and are **tuned against the fixture corpus, not
guessed** — task T-31 owns the tuning pass. The default review threshold for the amber
low-confidence flag is **0.55**.

Two adjustments applied after scoring:

- **Corroboration bonus (+0.10).** If a read span is later detected for this reference
  ([05](05-timing-and-placement.md) §4), the speaker demonstrably quoted it, which is strong
  independent evidence the reference was heard correctly. Applied by the timing stage.
- **Duplicate suppression.** Identical references within the cooldown window (default 60 s) are
  collapsed to the first, with the rest retained as `suppressed: true` rows (FR-3.6). A speaker
  circling back to the same verse three times in a minute wants one graphic, not three.

---

## 7. Output

Each detection becomes a `Detection` record, which the resolver and timer then enrich into a
full cue:

```json
{
  "id": "det_014",
  "reference": {
    "book": "1 Corinthians", "osis": "1Cor",
    "chapter": 6, "verse": 19, "verse_end": 20
  },
  "display": "1 Corinthians 6:19-20",
  "pattern": "P6",
  "contextual": false,
  "token_span": [1841, 1849],
  "word_span": [2103, 2112],
  "source_start": 1425.82,
  "source_end": 1427.61,
  "snippet": "…turn with me to First Corinthians six, nineteen and twenty…",
  "confidence": 0.91,
  "book_match": { "tier": "exact", "distance": 0 },
  "alternatives": []
}
```

`source_start` is the start timestamp of the **first token of the match** — for
`1 Corinthians 6:19-20` that is the "first" in "First Corinthians", not the book name. This is
the reference-mention anchor candidate that [05](05-timing-and-placement.md) §3 consumes.

---

## 8. What this design deliberately does not do

- **No LLM.** Detection is deterministic, offline, auditable and instant. An LLM pass would
  improve recall on unusual phrasings, but it would add a second network dependency, make
  results non-reproducible run to run, and put sermon transcripts on someone else's server.
  Revisit only if M1 recall stalls below 90% after tuning — and then as a local model.
- **No semantic allusion search.** Finding John 3:16 quoted without ever being named requires
  embedding the whole Bible and searching every transcript window. Out of scope (00-prd §8),
  and a false-positive minefield.
- **No cross-verse coalescing.** "Verses 16, 17, and 18" produces one range. "Verse 16… [two
  minutes of preaching]… verse 17" produces two cues, correctly, because they are two moments.

---

## 9. Test corpus requirements

Detection cannot be tuned without labelled data. [11-testing.md](11-testing.md) §3 specifies
the corpus; the requirements it must meet from this document's side:

- **≥ 300 hand-labelled reference utterances** across ≥ 10 sermons and ≥ 3 speakers.
- Every form in the §4 table represented at least five times.
- **Negative fixtures**: transcript passages containing "job", "mark", "acts", "numbers",
  "kings" and "revelation" as ordinary words, with and without nearby numbers. These are the
  regression tests that keep §4.1's gate honest.
- At least two sermons with degraded audio (room mic, applause, music bed) to keep the ASR
  confidence term meaningful.
