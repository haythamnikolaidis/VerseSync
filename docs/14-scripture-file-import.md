# 14 — Scripture file import (EasyWorship export)

> **Status:** Specified 2026-10-31, revised 2026-11-02 after review (repeats, out-of-order readings, close repeats), not built. Decision **D26**, task **[T-51](tasks/T-51-scripture-file-import.md)**. How a cue's text is wrapped and split on screen is in [15](15-graphic-text-layout.md).

The church displays scripture during the live service from **EasyWorship**. After the service,
the operator exports what was shown as a plain-text file — the same file VerseFlow reads
(`reference/verseflow/js/scripture-parser.js`). This document specifies how VerseSync uses
that file, when the editor supplies one, as the **first source of cues and verse text**, ahead of
reference detection and the Bible API.

---

## 1. Why

Measured on the 2026-10-25 sermon (*Lacking Nothing*; 14 export entries, 5,159 transcript
words), against the v1 pipeline on the same transcript:

| | v1 pipeline (detect → API, KJV) | Export entries located by text (§4) |
|---|---|---|
| Correct translation | 0 of 34 cues (the speaker reads NIV, NKJV and TPT) | 14 of 14 — the file carries each entry's own |
| Readings classified READ | 1 | 9 of 12 distinct entries at coverage ≥ 0.69 |
| Readings never detected | James 1:4 (NKJV), James 3:2 (NKJV), Ezekiel 36:26 | James 1:4 and James 3:2 found at 1.00 |
| Noise | 23 chapter-only or false cues ("Psalm 91" ×9, "Isaiah 8:4", "Matthew 5", …) | none: the file is the list |

Three problems in v1 are the same problem: VerseSync guesses **which** scripture was shown and
**which translation**, and then fetches text the speaker did not read. The export answers both
questions exactly, and its text is what the congregation saw. It also reaches cues that detection
cannot: a reading with no spoken reference (D19's ~31%) is still an entry in the file, and can be
found by its text.

## 2. The file

Plain text, **UTF-8 with a BOM, CRLF line endings**. One block per slide shown, in the order
shown, **repeats included** (the 2026-10-25 file shows James 1:4 and Psalm 91:15 twice each):

```
James 1:2-4 (NIV)
2 Consider it pure joy, my brothers and sisters, whenever you face trials of many kinds,
3 because you know that the testing of your faith produces perseverance.
4 Let perseverance finish its work so that you may be mature and complete, not lacking anything.

Ezekiel 36:26 (NKJV)
26 I will give you a new heart and put a new spirit within you; …
```

- The **reference line** matches VerseFlow's regex
  `^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$`:
  a reference and a translation abbreviation in parentheses.
- **Verse lines** start with the verse number and may carry trailing spaces.
- A **blank line** ends a block.
- Translations are mixed within one file.

**Assumption: file order is the order shown (Q-G).** This rests on one real file. It is treated as
correct for now, and the `out_of_order` flag (§4.5) measures how often it fails once the editor is
testing.

## 3. Parsing

`versesync/scripture_file.py`, a port of VerseFlow's parser:

```python
@dataclass(frozen=True)
class ExportEntry:
    index: int                 # 0-based position in the file, repeats counted
    reference_line: str        # verbatim, e.g. "James 1:2-4 (NIV)"
    reference: Reference       # parse_reference() of the reference part, canon-validated
    translation: str           # "NIV"
    lines: tuple[str, ...]     # verse lines, stripped
    body: str                  # lines joined by single spaces, verse numbers kept (VerseFlow _finalize)
    word_count: int

def parse_scripture_file(path: Path, canon: Canon) -> tuple[list[ExportEntry], list[Warning]]
```

- Strip the BOM; accept CRLF and LF.
- `body` and `word_count` are computed **exactly** as VerseFlow's `_finalize`, so the same file
  gives the same graphics in both tools (FR-4.2).
- A reference line that canon validation rejects → warning `export_reference_invalid`, block
  skipped.
- Lines before the first reference line, or a block with no reference line → warning
  `export_block_unreferenced`, skipped. This is VerseFlow's behaviour; see open question **Q-F**.
- An empty file, or one with no valid entry → error `scripture_file_empty` (an input error,
  07 §3).

## 4. Locating entries in the transcript

Each entry gets **candidate placements** from two sources, then one assignment over the whole
file picks at most one placement per entry, **in file order**. Two later passes use what that
assignment left over: a strong reading out of order (§4.5), and a scripture the pastor went back
to with no new slide (§4.6).

### 4.1 Text candidates

`V = normalise_verse(entry.lines)` (05 §4.1 normalisation; the verse numbers drop out as digit
tokens). For every transcript token `j` that `tokens_equal`s one of `V[0..2]`:

```
run      = align_from(V, tokens[j : j + 3·|V| + 30], 0)       # 05 §4.1, unchanged
coverage = run.matched / |V|
```

Sort the runs by coverage, highest first (ties: earliest). Keep a run with coverage ≥
`text_min_coverage` (**0.30**) only if its word span **doesn't overlap** a run already kept, up to
`candidates_per_entry` (**5**). Each keeps `read_start_s`, `read_end_s`, the word span and the
per-verse start times (§4.7). The span cap is what stops a greedy run from collecting stray
matches across the whole sermon.

Overlap, not a fixed time window, separates two readings: the spike sermon has Psalm 27:1 read
twice about 21 seconds apart, and a 60-second window would merge them into one candidate.

### 4.2 Mention candidates

Every detection (04) whose reference **matches** the entry: same book and chapter, and either
the detection is chapter-only or its verse range intersects the entry's. Score
`0.5 × detection.confidence`, placed at `mention_start_s`. Chapter-only mentions count here
(the 2026-10-25 repeat of James 1:4 is only ever named as "James 1").

### 4.3 Merging

A text candidate and a mention candidate for the same entry merge when the mention starts no
more than **120 s** before, or **20 s** after, the read start. The merged score is
`coverage + 0.25`, with the text candidate's span and the mention's start.

### 4.4 Assignment

Dynamic programming over entries in file order and candidates in time order. Maximise the total
score, subject to **placement times strictly increasing in file order**. An entry may be left
unplaced at a score of 0. Ties go to the earlier placement. With ~20 entries and ≤ 5 candidates
each this is trivially fast, and it is deterministic (05 §10).

The order constraint is what disambiguates repeats: the second "James 1:4" cannot reuse the
1:24:08 reading once Psalm 91:15 (1:38:41) is placed, so it takes its later mention.

### 4.5 Out-of-order pass

The assignment can't place an entry out of file order, so it may leave one unplaced, or on a weak
spot, while a strong reading of it sits elsewhere. After the assignment, in file order, for each
entry that is unplaced or has no text placement with coverage ≥ `read_coverage_threshold` (0.55):

- find its best text candidate with coverage ≥ 0.55 whose word span overlaps no placement;
- if there is one, move the entry there and flag the cue `out_of_order`. A mention it gives up
  becomes available to the later passes.

A mention alone never moves an entry out of order: it doesn't prove the slide was shown then.

The strictly-increasing rule (§4.4) holds for the assignment only, not for the final cues. The count
of `out_of_order` cues per sermon is how Q-G gets answered.

### 4.6 Repeat pass

The pastor may go back to a scripture without a new slide, so the file has one block for two
readings. After §4.5, for each entry with a placement:

- **Re-read:** each unused text candidate with coverage ≥ 0.55 and at least
  `repeat_min_matched_tokens` (**5**) matched tokens, whose span overlaps no placement, becomes a
  new cue flagged `repeat_read`.
- **Repeat mention:** each unused detection with a verse (not chapter-only) that matches the entry
  becomes a new cue flagged `repeat_mention`, unless it falls in the §4.3 merge window of a
  placement of the same entry. There it's the same reading being introduced, so it's absorbed and
  produces no cue. A `suppressed_duplicate` detection never becomes a repeat.

Repeats use the entry's reference, translation and text, never the provider's. Chapter-only
detections stay as `not_in_export`: the 2026-10-25 sermon has "Psalm 91" nine times, and each would
otherwise become a graphic.

### 4.7 Per-verse start times

For a text placement of a multi-verse entry, record the time of the first matched token in each
verse. To find them, `_Run` gains `matched_at`, the `(verse_token, window_token)` pairs; the
alignment itself doesn't change. Token counts per verse come from running `normalise_verse` on each
verse line separately. A verse with no matched token gets no time. [15](15-graphic-text-layout.md)
uses these times when a passage is split across graphics.

## 5. Building cues

| Placement | `classification` | Anchor and duration | `confidence` | `enabled` | Flags |
|---|---|---|---|---|---|
| Text, coverage ≥ 0.55 (± mention) | `read` | 05 §3 anchor; READ duration | `max(coverage, mention confidence)` | default rule | — |
| Text, 0.30–0.55, no mention | `paraphrase` | first matched word − lead-in; PARAPHRASE duration | `coverage` | default rule | `low_confidence` |
| Mention only | `paraphrase` | 05 §3 from the mention; PARAPHRASE duration | `0.8 × detection.confidence` | default rule | — |
| **Unplaced** | `paraphrase` | Midpoint between the neighbouring placed anchors (before the first: the neighbour minus its duration; after the last: the neighbour plus its duration); PARAPHRASE duration | `0.0` | **false** | `not_found_in_audio` |
| Out of order (§4.5) | `read` | As the first row | `coverage` | default rule | `out_of_order` |
| Re-read (§4.6) | `read` | As the first row | `coverage` | default rule (**ticked**) | `repeat_read` |
| Repeat mention (§4.6) | `paraphrase` | As mention only | `0.8 × detection.confidence` | **false** | `repeat_mention` |

For every entry cue, repeats included:

- `reference_display` is the export's reference line **verbatim**; `body` is the export body;
  `body_truncated` is false. A passage over `max_verses` is still flagged `long_passage`, but is
  **never truncated**: it is what was shown.
- `text_source` is `{"kind": "export", "translation": "<abbr>", "entry_index": n}`. Several cues
  can share one `entry_index`.
- `detection` is the merged mention's detection block, or absent if there was none.
- `origin` is `detected`.
- `verse_offsets_s` is present on a READ cue of a multi-verse entry: each later verse's start
  (§4.7) minus `source_anchor_s`, keyed by verse number, for example `{"7": 27.2, "8": 33.6}`.
- `max_read_duration_s` doesn't cap a READ cue of a multi-verse entry: the graphics run to
  `read_end_s` + `tail_pad_s`. The spike sermon's 2 Corinthians 4:6-9 took 57 seconds across its
  graphics, and a 45-second cap would cut the last verse short. The overlap sweep still applies.

**Detections that no entry consumed, and that §4.6 didn't turn into a repeat,** become cues exactly
as in v1 (provider text, the job's translation), but `enabled: false` with the flag `not_in_export`.
A detection consumed by an entry produces no second cue.

**Without a scripture file**, the pipeline is unchanged from v1.

## 6. Contract changes (Cue Document 1.1, API stays 1.0)

All additive, so a 1.0 reader can still read a 1.1 document (07 §5.2).

- `POST /jobs` `options.scripture_file`: absolute path, validated like `media_path`
  (`allowed_media_roots`). New input-error codes `scripture_file_not_found`,
  `scripture_file_unreadable` and `scripture_file_empty`.
- CLI: `versesync analyse … --scripture-file PATH`.
- Cue: optional `text_source` (`kind` ∈ `export | provider`, `translation`, `entry_index`
  for exports), and optional `verse_offsets_s` (§5).
- Flags: `not_in_export`, `not_found_in_audio` and `repeat_mention`, all in
  `DISABLED_BY_DEFAULT`; `repeat_read` and `out_of_order`, which leave a cue enabled.
- Document: optional `scripture_file` = `{ "path", "sha256", "entry_count" }`, so Journey B and
  the review list can show what the cues came from.
- Warnings: `export_reference_invalid` and `export_block_unreferenced`, with the line number.
- `schema_version` becomes `"1.1"`.

The transcript cache key (D17) is unchanged: the file is applied after transcription, so adding
or changing it re-runs in seconds.

## 7. Panel

- **Setup:** an optional *Scripture file (EasyWorship export)* picker under the media picker,
  defaulting to the media's folder. The chosen path goes in `options.scripture_file`.
- **Review list:**
  - an **EW** badge on export cues, with the translation from `text_source`;
  - unplaced rows read *"Not found in audio — set the time"* and open with the time field
    focused;
  - `not_in_export` cues are grouped, collapsed, under *Other mentions (N)*;
  - `repeat_read` and `repeat_mention` rows show a **Repeat** badge, and `out_of_order` rows an
    **Out of order** badge. They stay in timecode order with the rest.
- **Editing the reference on an export cue:** the re-resolve keeps the cue's own translation if it's
  in the Setup list; otherwise it uses `default_translation` (NKJV). The reference label shows which
  was used (D27).
- **Journey B:** nothing new. The Cue Document already holds the text and times.

## 8. Licensing (D26)

Text that comes from the export was already displayed under the church's EasyWorship licence for
this service. VerseSync uses it **only for this sermon's Cue Document**:

- it is never written to the Bible text cache (06 §4);
- it never adds a translation to `bible.translations` (06 §7);
- R-1's written-permission rule still governs every translation fetched from a provider.

## 9. Testing

- **Unit:** the parser against a public-domain sample laid out like VerseFlow's format, whose
  expected `reference_line`, `translation`, `body` and `word_count` were recorded by running
  VerseFlow's real parser once (the repo is public, so VerseFlow's own NKJV/TPT sample file is not
  copied), and a BOM/CRLF copy written at test time, giving byte-identical `body` strings; locator
  cases for a clean read, a paraphrase, a repeat, out-of-order entries and
  an unplaceable entry; DP determinism; two readings 21 seconds apart; a re-read with no slide; a
  repeated reference with no slide; a chapter-only mention that must not become a repeat.
- **Fixtures:** a synthetic public-domain export (KJV/WEB) and transcript laid out like the
  2026-10-25 file — mixed translations, two repeats, one allusion with no text match. The real
  file and transcript stay **out of the repo** (NIV and TPT text; pastoral sensitivity, R-12).
- **Human (T-51.H):** the 2026-10-25 sermon on the reference workstation. Pass if at least **9 of
  12** distinct entries are placed within **5 s** of their hand-checked time, both repeats land
  on their second occurrence, no `not_in_export` cue is enabled, and every repeat and out-of-order
  cue shows the file's translation.

## 10. Configuration

```yaml
scripture_file:
  text_min_coverage: 0.30
  candidates_per_entry: 5
  merge_before_s: 120
  merge_after_s: 20
  merge_bonus: 0.25
  mention_weight: 0.5
  repeat_min_matched_tokens: 5
```

These are spec defaults, chosen from one sermon; they ship untuned, like the rest (D24).
