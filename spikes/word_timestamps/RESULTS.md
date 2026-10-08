# T-02 Results — word-level timestamps on real sermon audio

**Audio:** `assets/test/03-Pastor Lapel-260927_0935.wav` — 48kHz mono PCM, **1h58m04s**
(7084.0s), a full-service recording. All 32 ground-truth labels fall in the sermon portion
(4634.9s–6400.1s). This is a real recording, not a synthetic 45-minute test clip — notably
longer than the "45-minute sermon" NFR-2 assumes; wall-times below are reported both raw and
normalized to a 45-minute-equivalent.

**Ground truth:** `ground_truth.csv`, 32 hand-confirmed labels (exceeds the 30 required),
built from the already-edited Premiere sequence's scripture-graphic placements
(`spikes/word_timestamps/spike.jsx` → Audacity label workflow, see `console-driver.md`) and
then corrected by ear against this exact audio file to the sample. `confirmed=true` on every
row.

**GPU:** NVIDIA RTX 3080 Ti, 12GB VRAM, CUDA 12.6. `faster-whisper==1.2.1`,
`ctranslate2==4.8.2` (not the `4.6.2` pin in `docs/02-source-project-audit.md` — that version
either isn't published for Python 3.12 or isn't what pip resolved; noted as a deviation, not
re-verified against 4.6.2 specifically). `av==12.3.0` pinned down from latest (`19.0.1`) —
faster-whisper 1.2.1's internal `av.open(..., metadata_errors=...)` call breaks on PyAV's newer
API; this is a real compatibility finding for anyone installing fresh today, not a local
mistake. `float16` throughout — quantization was not swept (see Gaps below).

---

## 1. Recommendation

| Setting | Default | Confidence |
|---|---|---|
| Model | **`distil-large-v3`** | Medium — best on this sample, but see §5 |
| Quantization | **`float16`** on CUDA | Low — not swept, just what worked |
| VAD | **`vad_filter=True`** | **High** — not close, see §3 |
| `initial_prompt` | **Scripture prompt, on** | Low — inconclusive on this sample, kept on by default per theory |
| `condition_on_previous_text` | **`True`** | Medium — see §6 |

**Gate verdict: the ±0.5s p90 gate is NOT met, as literally measured, on any configuration
tested.** Per T-02's own gate language, this is being escalated rather than silently waved
through — see §7. The escalation is **not** "Whisper's cross-attention timestamps are too
imprecise" — on the cleanest, most unambiguous matches, timestamp error is mostly well under
0.5s (§4.2). The real story is two product-level findings that no choice of model, VAD, prompt
or quantization fixes: (a) roughly a third of this sermon's real mentions are **pure narrative
paraphrases with zero lexical overlap** with either the reference or the verse text (§4.3), and
(b) when a mention *is* matched, several seconds of legitimate mention-vs-reading-vs-graphic
timing variance is common (§4.2) — both are detection/anchor-design questions, not ASR quality
questions.

---

## 2. Method (and its limits — read this before trusting any number below)

T-02's own step 3 just says "measure the error distribution of matched word starts against the
labels." Building the real reference-detection grammar (`docs/04-reference-detection.md`) to do
that matching is a separate, much larger task (T-07+), out of scope for a throwaway spike. So
`scripture_match.py` implements a **deliberately simple heuristic**, not the production
detector:

- For each label, search a ±10s window around the hand-confirmed timestamp.
- Try to find the **spoken reference** (book name + chapter/verse number, digit or
  spelled-out, within 8 tokens of the book name).
- Try to find the **quoted verse's body text** — as a sliding 6-word n-gram over the *whole*
  quote (not just its opening words — see §4.3's "Micah 7:8" case where the reading skips
  straight to a later clause), fuzzy-matched at ≥0.7 ratio.
- Take whichever of the two is **earliest** in time, matching the product's own anchor
  definition (`docs/05-timing-and-placement.md` §3: `min(mention_start, read_start)`).
- No match in the window → label is **unmatched**, excluded from the error distribution
  (reported separately as a match-rate).

This is good enough to sanity-check raw timestamp quality, but it is not watertight — see the
worked examples in §4. Anyone extending this spike should read `scripture_match.py`'s docstring
before trusting a specific number to the second decimal place.

---

## 3. VAD — not a close call

| Config | words | wall_s | result |
|---|---|---|---|
| `large-v3-turbo`, VAD **off** | 8852 | 413.9 | **Total collapse.** Every single segment, for the full 2 hours, is the literal text `"."` — not subtle hallucination, a complete degenerate loop. `segment_count == word_count == 8852` (one fake "word" per 30s chunk). |
| `distil-large-v3`, VAD **off** | 8966 | 452.2 | Same failure mode, different attractor: `" Thank you."` repeated every ~30s during quiet stretches (confirmed at 0–144s; real speech elsewhere in the file does transcribe correctly, so this is not a 100% collapse, but the same documented risk manifesting). |
| `large-v3`, VAD **off** | 5822 | 183.2 | No obvious collapse, but still slower and noisier than its VAD-on counterpart. |
| All three, VAD **on** | ~5650–5690 | 42–146 | Clean output throughout, matches hand-checked. |

This is exactly the risk `docs/02-source-project-audit.md` Gap 4 names ("Whisper is prone to
hallucinating text in silence... both creates false detections and can drag timestamps") —
except on a real 2-hour sermon with long musical/quiet stretches, it is not a mild drift, it is
a full degenerate repetition loop for at least one model. **`vad_filter=True` is not a tuning
choice here, it is a correctness requirement.** Every number in the rest of this document uses
VAD-on data.

---

## 4. Timestamp accuracy

### 4.1 Base matrix (model × VAD, `prompt=none`, `condition_on_previous_text=true`)

| Model | VAD | match rate | p50 | p90 | max | mean |
|---|---|---|---|---|---|---|
| large-v3 | on | 22/32 (69%) | 0.42s | 6.63s | 7.74s | 1.92s |
| large-v3 | off | 22/32 (69%) | 0.41s | 6.63s | 7.76s | 1.91s |
| large-v3-turbo | on | 22/32 (69%) | 0.39s | 6.45s | 7.66s | 1.88s |
| large-v3-turbo | off | 0/32 (0%) | — | — | — | — (collapsed, §3) |
| **distil-large-v3** | **on** | 21/32 (66%) | **0.62s** | **5.79s** | 7.05s | 1.71s |
| distil-large-v3 | off | 22/32 (69%) | 0.58s | 5.85s | 7.12s | 1.67s |

`distil-large-v3` (VAD on) has the lowest p90 and is the base-matrix winner by this script's
selection rule (lowest p90, tie-break lowest p50). **Read §5 before treating this as "distil
beats the full models" — the gap between all three is small relative to the noise this
methodology has, and distil's own p50 here is higher than large-v3/-turbo's.**

### 4.2 What's actually driving the high p90 — a worked breakdown

Restricting to only the **unambiguous "reference" matches** (book name + chapter:verse number
both present — the match type least likely to be a false positive) on the winning config
(`distil-large-v3`, VAD on, scripture prompt, `condition_on_previous_text=true`):

| # | Reference | Error | Matched text |
|---|---|---|---|
| 1 | Micah 7:8 | **+0.64s** | "micah 7 verse 8 says when i sit in" |
| 2 | 2 Corinthians 4:6-9 | **+0.22s** | "corinthians four verse six for it is the god" |
| 6 | Psalm 4:6 | **+0.00s** | "psalm 4 verse 6 the living bible says many" |
| 11 | Psalm 27:1 | **+0.07s** | "psalm 27 verse 1 the lord is the light" |
| 13 | Genesis 39:21 | **-0.69s** | "genesis genesis 39 verse 21 but the lord was" |
| 26 | John 1:9 | **+0.02s** | "john 1 9 for the light of truth was" |
| 9 | Psalm 31:16 | **-5.81s** | "psalm 31 verse 16 make your face shine upon" |
| 12 | Psalm 27:1 (2nd) | **-4.81s** | "psalm 27 verse 1 just put it up there" |

6 of 8 (75%) are within 0.7s — several within hundredths of a second. **On a clean,
unambiguous match, Faster-Whisper's word timestamp is landing almost exactly where it should.**
The two outliers are each explainable and are *not* the same problem:

- **#12 is a matcher false positive.** "just put it up there" is not scripture — it reads like
  the pastor telling the AV operator to display the graphic. The book+number co-occurrence is
  real (he does say "Psalm 27 verse 1" there), but it is not the reading this label anchors to.
  This is this spike's matching heuristic failing, not Whisper's timestamp.
- **#9 matches genuine verse content** ("make your face shine upon" is real Psalm 31:16 text) —
  it is simply ~5.8s *before* where the editor placed the graphic. This looks like a real
  mention-then-later-reading gap, i.e. exactly the `min(mention_start, read_start)` ambiguity
  the product's own anchor design (`docs/05` §3) exists to handle — not an ASR timing defect.

The `body`-text matches (quoted-verse fuzzy matching, 14 of the 22 total matches) show the same
pattern: mostly small errors, with a handful of multi-second outliers (#27 Job 22:28 at -6.50s,
#29 Isaiah 60:1-2 at +6.83s) that read, on inspection, like genuine large lead-ins or
early/paraphrased mentions rather than alignment failures — see raw data in
`transcripts/*.scored.json` for the full per-label breakdown.

### 4.3 The bigger finding: ~31% of labels have no recoverable text at all

10 of 32 labels (consistent across every model/VAD combination — this is not model-specific)
come back `"neither reference nor body text found in window"`. Spot-checked three of them
directly against the transcript:

- **#17, Daniel 6:16** (label at 5626.4s) — the actual words at that point: *"...he found
  himself in the lion's den. But you know what's the beautiful thing? The king acknowledged...
  I've seen the light of God's favor..."* The pastor is narrating the Daniel-in-the-lion's-den
  story in his own words. He never says "Daniel," "6," "16," or anything resembling the verse
  text.
- **#16, Esther 2:15** — same pattern: *"The Bible says that God gave her favor with
  everybody... you can experience the light of his favor..."* — a paraphrase of the *theme*,
  zero lexical overlap with the citation or the verse.
- **#28, Romans 8:32** — same again: *"if he did not withhold Jesus Christ, the beauty of
  heaven, why will he withhold anything from you?"* — a loose paraphrase of "He who did not
  spare His own Son... how will He not also freely give us all things," with no shared n-gram
  longer than one or two common words.

**This is the finding that actually matters most for the product, more than any p50/p90
number.** It confirms exactly the scenario the person running this spike flagged up front —
scriptures that are "not cited but paraphrased" — and shows that for a real, meaningful
fraction of those, **there is no text in the transcript for any detector, however good, to
anchor to.** No amount of Faster-Whisper model/VAD/quantization tuning fixes this; it's a
structural limit of transcript-based detection against free paraphrase. Worth raising as its
own risk alongside R-5 in `docs/12-decisions-and-risks.md` — this spike surfaced it as a
concrete, measured rate (31% on one real sermon) rather than a theoretical concern.

---

## 5. Model choice: don't over-read "distil won"

`docs/02-source-project-audit.md` Gap 5 flags `distil-whisper-large-v3`'s timestamp quality as
**unverified** because of its reduced decoder, and recommends defaulting to `large-v3-turbo` or
`large-v3`. This spike's measured p90 ranks `distil-large-v3` *first*, which is a genuinely
useful, somewhat surprising data point — but:

- The three models' p90 values (5.79s, 6.45s, 6.63s) are close together relative to how much
  2-3 outlier labels move each one. With only 21-22 matched labels per config, one or two
  different outliers would reorder this ranking.
- `distil-large-v3`'s p50 (0.62s) is actually the **worst** of the three (vs. 0.39-0.42s) —
  it only wins on p90, which is exactly the tail the outlier labels dominate.
- This is **one sermon**. T-02's own step 1 calls for labelling "across at least one sermon" —
  this spike used exactly one. Model ranking on a sample this size is not a settled question.

**Given that caveat, `distil-large-v3` is still the pick** — it is also 2-3.5x faster than
`large-v3-turbo`/`large-v3` (§6), and nothing in the data here contradicts its accuracy being
adequate. But this should be re-checked against a second hand-labelled sermon before being
treated as settled, specifically because it reverses the docs' own a-priori expectation.

---

## 6. Wall-time (NFR-2)

Raw wall-time on the real 7084s (1h58m) file, and normalized to a 45-minute-equivalent for
comparison against NFR-2's assumption:

| Model | VAD | wall (raw) | realtime factor | normalized to 45 min |
|---|---|---|---|---|
| large-v3 | on | 146.4s | 48.4x | 55.8s |
| large-v3 | off | 183.2s | 38.7x | 69.8s |
| large-v3-turbo | on | 66.5s | 106.5x | 25.3s |
| large-v3-turbo | off | 413.9s | 17.1x | 157.8s (garbage output, §3) |
| **distil-large-v3** | **on** | **42.2s** | **167.7x** | **16.1s** |
| distil-large-v3 | off | 452.2s | 15.7x | 172.3s (partially degenerate, §3) |

On the GPU used here (RTX 3080 Ti), all VAD-on configs comfortably clear any plausible NFR-2
target — even `large-v3` finishes a 45-minute-equivalent sermon in under a minute. Speed is not
the bottleneck for model choice; `distil-large-v3`'s 3.5x speed edge over `large-v3` is a nice
bonus, not a deciding factor on its own.

**Batching (`BatchedInferencePipeline`) was deliberately not used** — mixing in a different
inference path would have confounded the timestamp-quality comparison with a batching-strategy
difference. It would likely improve these numbers further; that's `docs/02` Gap 6, separate
follow-up work.

---

## 7. `initial_prompt` A/B (step 4)

**Inconclusive on this sample — honestly reported, not papered over.** None of the four
mishearing pairs T-02 names (Philippians/Philippines, Habakkuk/have-a-cook, Titus/tight-us,
Colossians/collations) occur in this sermon at all — **0 correct, 0 misheard, both prompt
settings.** This sermon simply doesn't exercise that failure mode either way.

| Prompt | match rate | p50 | p90 |
|---|---|---|---|
| none | 22/32 | 0.62s | 5.79s |
| scripture | 22/32 | 0.66s | 5.71s |

The differences are tiny and within the noise this methodology has (§2). The orchestrator's
tie-break (lower p90) picked `scripture`, but that's a coin-flip-sized difference, not a
finding. **Recommendation: keep the scripture prompt on by default anyway** — `docs/04-
reference-detection.md` §2's reasoning for it (biasing decoder vocabulary toward proper nouns)
is sound on its own merits and showed no measured downside here; it just wasn't *proven*
beneficial on this sample. Re-test on a sermon that actually says "Habakkuk" or "Philippians"
before calling this settled.

One measured fact worth keeping: the prompt is ~900 characters / ~155 words — comfortably under
the 224-token window `docs/04` §2 flags as a risk, at least for this exact prompt text.

---

## 8. `condition_on_previous_text` A/B (step 5)

| Setting | match rate | p50 | p90 | repetition loops |
|---|---|---|---|---|
| **true** | 22/32 | 0.66s | 5.71s | **0** |
| false | 22/32 | 0.63s | 5.89s | **0** |

Zero repetition loops either way — **but this A/B only ran with VAD on**, and §3 already shows
VAD-on prevents the degenerate-loop failure mode entirely regardless of this setting. The timing
differences here are again within noise. Per `docs/04` §2's own framing ("keep it True and rely
on VAD to break loops"), and since VAD-on is now a hard requirement anyway (§3),
**`condition_on_previous_text=True` is the reasonable default** — there's no measured reason to
give up its benefit (prompt influence propagating past the first window) once VAD is already
doing the loop-prevention job.

---

## 9. Gate assessment

> If p90 error exceeds ~0.5s on the best configuration, stop and escalate.

By the letter of this gate: **tripped.** Every configuration's p90, including the
cleanest-matches-only slice in §4.2 (5.11s), is well over 0.5s.

**Escalating, per `docs/13-technical-plan.md` §9's options — with a recommendation on which
ones actually fit what was found:**

1. *Widen the tolerance* — directly supported by §4.2: on unambiguous matches, error is mostly
   ≤0.7s but a legitimate few seconds for cases with real mention-vs-reading gaps. A tolerance
   in the 1-2s range would cover most of what's actually a timing-design issue, not an ASR
   defect.
2. *Increase the lead-in* — only partially fits. It would help cases like #9 (mention several
   seconds before the display), but **does nothing for §4.3's 31%** — there's no "mention" to
   lead in from when the text is never said.
3. *Forced-alignment pass over the read span* — also doesn't address §4.3, and the matched-span
   timestamps in §4.2 already look fine without it, so the marginal benefit may be smaller than
   the investigation cost.
4. **Not in the original list, worth adding given §4.3:** for mentions with no verbal citation
   or legible reading at all, no ASR-side fix exists — this needs a product decision (accept a
   lower auto-detection rate for pure paraphrases, and lean on the review-list UI for the editor
   to add those manually) rather than an engineering one. This spike's own tooling
   (`spike.jsx`/`to_audacity.js`, built earlier in this same exercise) incidentally demonstrates
   a *second*, independent source of "where is a scripture graphic" ground truth — the edited
   sequence itself — which could be a fallback/cross-check signal worth a design note, though
   that's a V2 idea, not something to act on now.

---

## 10. Files

- `ground_truth.csv` — 32 hand-confirmed labels (source/raw-audio time).
- `spike.jsx`, `console-driver.md`, `to_audacity.js`, `from_audacity.js` — the Premiere→Audacity
  ground-truth tooling built earlier in this same spike.
- `run_transcription.py` — one faster-whisper run, CLI-driven, `word_timestamps=True`,
  `temperature=0` fixed throughout.
- `scripture_match.py` — the matching heuristic, see §2 for its limits.
- `measure_error.py` — scores one transcript against `ground_truth.csv`.
- `run_all.py` — orchestrates the full base matrix + adaptive prompt/condition A/Bs, resumable.
- `transcripts/*.json` — raw transcripts (words + segments) per configuration.
- `transcripts/*.scored.json` — per-label match details + summary per configuration.
- `all_results_summary.json` — the consolidated machine-readable version of §§3-8.

## 11. Gaps / what this spike did not do

- **Quantization was not swept.** Only `float16` on CUDA was tested. `int8`/`bfloat16` tradeoffs
  (useful if a client machine has less VRAM) are untested.
- **One sermon.** §5's model ranking and §7/§8's A/Bs would all benefit from a second
  hand-labelled sermon, ideally one that actually contains the four flagged book-name
  confusions.
- **The matching heuristic is a proxy, not the production detector** (§2) — treat §4's exact
  numbers as directionally right, not as a certified accuracy figure for the real system.
- **Batched inference untested** (§6) — likely a free wall-time win, not evaluated here to keep
  this comparison clean.
