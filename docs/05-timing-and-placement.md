# 05 — Timing and Placement

Detection ([04](04-reference-detection.md)) says *which* scripture and *roughly when* in the
media file. This document turns that into a frame-exact position on the Premiere timeline and
a duration — the promise in [00-prd.md](00-prd.md) §7.

Four conversions happen, in order:

```
detection span (source seconds)
   → read-span alignment            §4   → is this READ or PARAPHRASE, and where does the reading end?
   → anchor + duration (source s)   §3   → when does the graphic start and how long does it last?
   → sequence ticks                 §5   → where is that in the current edit?
   → frame-snapped, overlap-resolved §7, §8
```

§4 and §3 run in the sidecar and know nothing about Premiere. §5 onward runs in the panel,
because only Premiere knows what the edit looks like.

---

## 1. Time domains

Getting these confused is the most likely source of an off-by-a-lot bug, so they are named
consistently everywhere in the codebase.

| Domain | Unit | Origin | Produced by | Used by |
|--------|------|--------|-------------|---------|
| **Source time** | seconds (float) | start of the media **file** | Whisper word timestamps | detection, alignment, anchoring |
| **Sequence time** | ticks (string) | start of the **sequence** | `timemap.js` via `VS.getMediaSegments` | `importMGT`, durations |
| **Display timecode** | `HH:MM:SS:FF` | sequence start **plus `zeroPoint`** | panel formatting only | the review list |

`zeroPoint` matters only for display. A sequence that starts at `01:00:00:00` still has its
first frame at tick 0 as far as `importMGT` and `trackItem.start` are concerned. Adding
`zeroPoint` into placement math would shift every graphic by an hour — a mistake worth a
comment in the code.

Constants, inherited from VerseFlow:

```
TICKS_PER_SECOND = 254016000000
TICKS_PER_FRAME  = Number(sequence.timebase)     // Premiere gives this directly
```

Deriving ticks-per-frame from a float frame rate is wrong for 23.976 and 29.97. Use
`sequence.timebase` and never compute it.

---

## 2. Configuration

All tunable, in `config.yaml`, with the first three exposed in the panel:

| Key | Default | Meaning |
|-----|---------|---------|
| `lead_in_s` | `0.5` | Graphic starts this far *before* the anchor, so the animate-in completes as the words land |
| `tail_pad_s` | `1.0` | READ cues stay up this long after the reading ends |
| `duration_mode` | `auto` | `auto` \| `fixed` |
| `fixed_duration_s` | `8.0` | Used when `duration_mode: fixed` |
| `min_duration_s` | `3.0` | Inherited from VerseFlow |
| `max_duration_s` | `20.0` | Inherited from VerseFlow (READ cues may exceed — see §3.3) |
| `max_read_duration_s` | `45.0` | Ceiling for READ cues specifically |
| `min_visible_s` | `2.0` | Below this, a truncated cue is flagged rather than silently shrunk |
| `overlap_gap_s` | `0.25` | Gap left between a truncated cue and the next anchor |
| `read_coverage_threshold` | `0.55` | Alignment coverage above which a cue is READ |
| `duplicate_cooldown_s` | `60` | Repeat mentions inside this window are suppressed |

---

## 3. The anchor

### 3.1 The rule

```
anchor_source = min(mention_start, read_start_if_any) - lead_in_s
anchor_source = max(anchor_source, 0.0)
```

Where:
- `mention_start` — `source_start` of the detection: the first token of the spoken reference.
- `read_start_if_any` — the start of a detected read span (§4), **only if** that span begins
  within `read_lookbehind_s` (default 20 s) before the mention. A reading that starts two
  minutes earlier is a different moment, not this cue's opening.

This implements the product rule directly: *the earlier of "starts reading" and "mentions the
reference"*. Both orderings occur constantly in real preaching:

- `"Turn to John 3:16. For God so loved the world…"` → mention first; anchor on the mention.
- `"For God so loved the world… that's John 3:16."` → reading first; anchor on the reading.

### 3.2 Why lead-in defaults to 0.5 s

A lower-third's animate-in takes roughly 0.5–1.0 s. Anchoring exactly on the first spoken word
means the graphic is still sliding in while the reference is being said. Half a second early is
imperceptible as an error and makes the graphic feel intentional. Editors who disagree change
one field.

### 3.3 Duration

```
if duration_mode == 'fixed':
    duration = fixed_duration_s

elif classification == READ:
    duration = (read_end - anchor) + tail_pad_s
    duration = clamp(duration, min_duration_s, max_read_duration_s)

else:  # PARAPHRASE
    duration = VerseFlow model:
        reading_seconds = (verse_word_count / 160) * 60
        duration = round(reading_seconds + 1.5, 1)
        duration = clamp(duration, min_duration_s, max_duration_s)
```

The PARAPHRASE branch is VerseFlow's `duration.js` verbatim, including its client-approved
constants — the same graphic should behave the same way it does today when nothing better is
known.

The READ branch is the improvement VerseSync can make and VerseFlow could not: when the
speaker demonstrably reads a passage for 38 seconds, the graphic stays up for it. `max_read_
duration_s` (45 s) exists to stop a runaway alignment producing a two-minute graphic.

---

## 4. Read-span alignment

**Purpose.** Decide READ vs PARAPHRASE, find where the reading starts and ends, and produce a
corroboration signal for confidence.

**Both classes get a graphic** — that is a product requirement ([00-prd.md](00-prd.md) §4, G4).
Classification changes *duration* and *confidence*, never whether the cue exists.

### 4.1 The algorithm

Monotonic greedy alignment with a skip budget. Chosen over LCS because it runs in effectively
linear time, tolerates the skips and ad-libs real reading contains, and naturally yields the
first and last matched timestamps.

```
inputs:  V = normalised content tokens of the resolved verse text
         T = normalised transcript tokens
         m = token index of the reference mention

window:  T[ m - (0.6·|V| + 20)  ...  m + (1.8·|V| + 30) ]
         (lookbehind catches reading-before-naming; lookahead is generous
          because preachers interject while reading)

align(start_j):
    i = 0; j = start_j; matched = 0; misses = 0
    first_match = last_match = None
    while i < |V| and j < |window|:
        if equal(window[j], V[i]):            # exact, or Levenshtein ≤1 for len ≥ 5
            if first_match is None: first_match = j
            last_match = j
            matched += 1; i += 1; j += 1; misses = 0
        else:
            j += 1; misses += 1
            if misses > max_skip (6):
                i += 1; misses = 0            # assume the speaker skipped a verse word
    coverage = matched / |V|

run align() from each of the first K (default 12) plausible starts — positions where
window[j] equals V[0] or V[1] — and keep the best coverage.
```

**Normalisation for alignment** (different from §3's, deliberately): lowercase, strip
punctuation, **remove verse numbers** from the verse text, and drop a small stop-list
(`the a an and of to in that`) from *both* sides so filler differences do not depress coverage.
Content words carry the signal.

### 4.2 Classification and outputs

```
READ        if coverage >= read_coverage_threshold (0.55)
PARAPHRASE  otherwise

read_start  = source start of window[first_match]     (READ only)
read_end    = source end   of window[last_match]      (READ only)
read_coverage = coverage                              (always reported)
```

**Why 0.55 rather than something higher.** A speaker reading aloud is interrupted by their own
commentary, skips words, substitutes synonyms from memory, and is transcribed imperfectly. In
the fixture corpus, verbatim readings land between 0.6 and 0.9 coverage; genuine paraphrase
rarely exceeds 0.35. The gap is wide and 0.55 sits in it.
**[T-34](tasks/T-34-threshold-tuning.md) confirms this against the corpus and adjusts.**

`read_coverage` is always shown in the expanded review row, so an editor can see *why* a cue
was classified as it was — this is a G3 (trustworthy by being visible) requirement, not a
debugging nicety.

### 4.3 Ordering dependency

Alignment needs the verse text, so it must run **after** verse resolution
([06](06-bible-text-service.md)). If a passage cannot be fetched (FR-4.5), alignment is skipped,
the cue is classified PARAPHRASE, and the duration falls back to the fixed default rather than
the word-count model — there are no words to count.

---

## 5. Source time → sequence time

### 5.1 Building the map

`VS.getMediaSegments({mediaPath})` ([08](08-premiere-host-api.md) §4) walks every video and
audio track in the active sequence, and for each `TrackItem` whose
`projectItem.getMediaPath()` matches the selected media file (normalised path comparison,
case-insensitive on Windows), returns:

```json
{ "trackType": "video", "trackIndex": 0,
  "seqStart": "254016000000", "seqEnd": "76204800000000",
  "inPoint": "0", "speed": 1.0 }
```

Each segment is a linear window:

```
segment covers source times  [ inPoint , inPoint + (seqEnd - seqStart) )
mapping:  t_seq = seqStart + (t_src - inPoint)
```

### 5.2 Resolving a source time

```
candidates = [ seg for seg in segments if seg.inPoint <= t_src < seg.inPoint + seg.length ]

0 candidates → cue flagged `cut_from_edit`, disabled by default (FR-5.6)
1 candidate  → map it
n candidates → map to the earliest seqStart, flag `multiple_placements`,
               offer the alternatives in the review row (FR-5.7)
```

The multi-candidate case is real: a sermon clip used once in the body and again in a recap
produces two valid answers, and only the editor knows which they meant.

### 5.3 Limitations, stated plainly

- **Speed changes.** A segment with `speed != 1.0` breaks the linear mapping. v1 detects it,
  flags the cue `speed_change_unsupported`, and disables it. Supporting it means integrating a
  piecewise time-remap curve — not worth v1.
- **Multicam clips and nested sequences do not resolve, and this is one failure mode, not
  two.** Spike **T-04** confirmed against a real client edit: a multicam clip placed on a
  timeline is, from `getMediaPath()`'s point of view, indistinguishable from a nested
  sequence — `projectItem` exists but `getMediaPath()` returns an **empty string**, not an
  exception and not `null`. `VS.getMediaSegments` treats both with one check (falsy/empty
  path → not resolvable) and reports them into `unsupported` rather than silently returning
  nothing. Adjustment Layer track items return the same empty string for the same underlying
  reason (no backing media file) and are handled identically, though they are not themselves
  something the panel needs to explain to the editor.
- **This is why the editor must be pointed at the audio file, not the picture.** In every real
  edit this pipeline will see, the picture side is multicam/nested and therefore unresolvable,
  while the sermon audio is a plain, detached `.wav` that resolves normally. `VS.getMediaSegments`
  already treats a match on either track type as valid (§5.1), but the practical implication
  for T-27's setup UI is stronger than that: the editor's "select your media" action should be
  steered toward the audio file specifically, or the panel will report `matched: false` for
  what an editor naturally thinks of as "the sermon."

### 5.4 Fallback: manual offset

If `getMediaSegments` returns nothing and the editor insists the media is in the edit, the
panel offers a single-offset mode: the editor types the sequence timecode where the media's
frame 0 sits, and mapping becomes `t_seq = offset + t_src` for everything. Correct for one
unbroken recording, wrong the moment the audio is cut — so the panel labels it clearly as an
approximation and flags every cue produced this way.

---

## 6. Chapter-only references

`Romans chapter 8` with no verse (patterns P5, P9, P10-without-verse) has no obvious body text:
showing an entire chapter in a lower-third is not a graphic, it is a wall.

**v1 behaviour (default).** The cue appears in the review list with its reference, its anchor,
and **no body text**, flagged `chapter_only` and **disabled by default**. The editor either
supplies a verse in the reference field — which re-resolves the text — or leaves it out. This
is honest: VerseSync does not know which verse was meant, and guessing is worse than asking.

**P2 enhancement (specified, not built).** Fetch the whole chapter and run the §4 alignment
against it verse by verse. The verses with meaningful coverage are the ones the speaker
actually read, so the cue resolves to that range automatically. This is a genuinely good
feature and reuses machinery that already exists; it is deferred only because chapter-only
references are a minority of detections and the fallback is a single edit.

---

## 7. Frame snapping

Every sequence time is snapped before it reaches the host:

```javascript
function snapToFrame(ticks, ticksPerFrame) {
  return String(Math.round(Number(ticks) / ticksPerFrame) * ticksPerFrame);
}
```

Applied to both the anchor and the end (`anchor + duration`), so a graphic never starts or ends
mid-frame. Durations are therefore whole frames, which also stops sub-frame rounding drift
accumulating across a 40-cue batch.

---

## 8. Overlap resolution

After mapping and snapping, cues are sorted by anchor and swept once:

```
for each consecutive pair (a, b):
    if a.end > b.anchor:
        proposed_end = b.anchor - overlap_gap_ticks
        if proposed_end - a.anchor >= min_visible_ticks:
            a.end = proposed_end            # truncate silently, record `truncated: true`
        else:
            flag both `overlap`             # editor resolves (FR-5.8)
```

Silent truncation is safe and usually right: a graphic that would run into the next scripture
should end before it. The flagged case — two references within ~2 seconds of each other — is
genuinely ambiguous. Common causes are a range read as two mentions ("verse 16… verse 17") or a
list ("Romans 8, Ephesians 2, Colossians 1"), and the sensible resolutions differ: merge,
stagger, or drop one. The editor decides.

**Alternate-track spillover** — placing an overlapping cue on the next track up — is
deliberately not v1 behaviour. It silently changes the layered look of the edit, which is the
media lead's decision, not the tool's.

---

## 9. Worked example

Sermon, 45 minutes, 29.97 fps sequence (`timebase = 8475667`), media starts at sequence tick 0
with 12 s trimmed off the head (`inPoint = 3048192000000`).

The speaker says, at **1425.8 s** into the file: *"Turn with me to First Corinthians six,
nineteen and twenty. Or do you not know that your body is the temple of the Holy Spirit…"*

| Step | Result |
|------|--------|
| Detection (P6) | `1 Corinthians 6:19-20`, tokens 1841–1849, `source_start = 1425.82`, confidence 0.91 |
| Resolution | 44 words of verse text, formatted with verse numbers retained |
| Alignment | coverage **0.78** → **READ**; `read_start = 1428.9`, `read_end = 1451.4` |
| Corroboration | confidence 0.91 → **1.00** (capped) |
| Anchor (source) | `min(1425.82, 1428.9) − 0.5` = **1425.32 s** |
| Duration | READ: `(1451.4 − 1425.32) + 1.0` = **27.08 s** (under the 45 s ceiling) |
| Map to sequence | in segment, `t_seq = 0 + (1425.32 − 12.0)` = **1413.32 s** = `359,033,... ticks` |
| Frame snap | rounded to the nearest 8,475,667 ticks |
| Overlap | next anchor is 96 s later — no conflict |
| MOGRT fields | reference ← `1 Corinthians 6:19-20 (NKJV)` · body ← `19 Or do you not know… 20 For you were bought at a price…` |

The graphic appears half a second before the speaker says "First", and leaves one second after
they finish reading verse 20.

---

## 10. Determinism

Given the same media file, the same edit and the same config, the pipeline must produce
byte-identical cues (NFR-3). Concretely this means:

- No wall-clock or randomness anywhere in detection, alignment or anchoring.
- Whisper is run with a fixed seed and `temperature=0` for VerseSync jobs; the fallback
  temperature ladder is disabled, since a re-decode that changes the transcript changes every
  downstream timestamp.
- Verse text comes from the cache when present, so a provider changing its formatting between
  runs cannot silently change durations.

This is what makes the accuracy harness meaningful and makes a bug reproducible from a media
file and a config alone.
