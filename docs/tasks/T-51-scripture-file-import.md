# T-51 · Scripture file import (EasyWorship export)

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Unblocks** | — |
| **Spec** | [14-scripture-file-import.md](../14-scripture-file-import.md) · D26 in [12](../12-decisions-and-risks.md) |

## Goal

When the editor supplies the EasyWorship export for a sermon, its entries become the cues: each
is located in the transcript by its **text**, and its reference, translation and verse text are
used **verbatim**. Detection and the Bible API become the fallback.

## Context

The v1 pipeline finds scripture by its spoken reference and fetches the job's translation.
On 2026-10-25 that gave 34 cues, 33 of them PARAPHRASE in the wrong translation, while the
export's text located 9 of 12 readings at coverage ≥ 0.69 (14 §1). The algorithm reuses
`align_from`, `normalise_verse` and `tokens_equal` from `timing/align.py` unchanged; what is new
is searching the whole transcript, and one in-order assignment over the file.

Without a scripture file, nothing changes. Every v1 golden file must still pass byte for byte.

## Subtasks

### T-51.1 · Export parser

**Executor** agent · **Size** S · **Prereqs** T-14.2, T-13.1 · **Status** todo

- **Read:** [14 §2, §3](../14-scripture-file-import.md) · `reference/verseflow/js/scripture-parser.js`
- **Touches:** `sidecar/versesync/scripture_file.py` (new) · `tests/test_scripture_file.py` (new) ·
  `tests/fixtures/scripture_files/` (new)
- **Steps:**
  1. Write `ExportEntry` and `parse_scripture_file(path, canon)` as specified in 14 §3, with the
     two warnings and the `scripture_file_empty` error. Commit.
  2. Fixtures: VerseFlow's `sample-scriptures.txt` copied as-is, plus a **UTF-8-BOM, CRLF**
     copy, plus a synthetic public-domain file laid out like 2026-10-25 (mixed translations, two
     repeats, a stray line before the first entry, one invalid book). Tests: both copies give
     identical entries; `body` matches VerseFlow's `_finalize` output for every sample entry;
     repeats are kept as separate entries; each warning carries its line number. Commit.
- **Verify:** `pytest tests/test_scripture_file.py -q`
- **Done when:**
  - [ ] `body` is byte-identical to VerseFlow's parser on the sample file.
  - [ ] BOM and CRLF make no difference.

### T-51.2 · Contract: Cue Document 1.1

**Executor** agent · **Size** S · **Prereqs** T-51.1 · **Status** todo

- **Read:** [14 §6](../14-scripture-file-import.md) · [07 §2, §3, §5.2](../07-sidecar-api.md)
- **Touches:** `schemas/cue-document.schema.json` · `docs/07-sidecar-api.md` ·
  `sidecar/versesync/cues.py` · `tools/mock_sidecar.py` · `panel/js/cues.js` ·
  `tests/fixtures/cue-documents/` · contract tests
- **Steps:**
  1. Schema 1.1: optional cue `text_source`, the two new flags, optional document
     `scripture_file`, and the two warning codes. Update 07 to match. Add both flags to
     `DISABLED_BY_DEFAULT`. Commit.
  2. Add a mock-sidecar scenario `export` and a golden document using every new field. Check
     that the panel reader accepts 1.1, and still accepts 1.0. Commit.
- **Verify:** `pytest -q` · `npm test`
- **Done when:**
  - [ ] Every 1.0 fixture still validates.
  - [ ] The panel reads the `export` scenario without warnings.

### T-51.3 · Entry locator

**Executor** agent · **Size** S · **Prereqs** T-51.1, T-17.2, T-13.3 · **Status** todo

- **Read:** [14 §4, §10](../14-scripture-file-import.md) · [05 §4.1, §10](../05-timing-and-placement.md)
- **Touches:** `sidecar/versesync/timing/locate.py` (new) · `sidecar/versesync/config.py` ·
  `tests/test_locate.py` (new)
- **Steps:**
  1. `text_candidates(entry, tokens, cfg)`: the span-capped search of 14 §4.1, keeping the best
     per neighbourhood. `mention_candidates(entry, detections)`: 14 §4.2, including chapter-only
     detections. `merge(...)`: 14 §4.3. Add the `scripture_file` config section. Commit.
  2. `assign(entries, candidates) -> list[Placement | None]`: the DP of 14 §4.4. Tests:
     - a clean read at coverage 1.0;
     - a repeat that has to take its later mention;
     - two entries whose best candidates are out of order, where the DP keeps the larger total;
     - an entry with no candidate, left unplaced;
     - identical input gives identical output.

     Commit.
  3. **Performance.** 30 entries against `long-sermon-filler` in under 1 s. Commit.
- **Verify:** `pytest tests/test_locate.py -q`
- **Done when:**
  - [ ] Placement times are strictly increasing in file order.
  - [ ] The performance bound holds.

### T-51.4 · Pipeline integration

**Executor** agent · **Size** S · **Prereqs** T-51.2, T-51.3, T-19.3 · **Status** todo

- **Read:** [14 §5](../14-scripture-file-import.md) · [05 §3](../05-timing-and-placement.md)
- **Touches:** `sidecar/versesync/pipeline.py` · `sidecar/versesync/cues.py` ·
  `tests/test_pipeline_export.py` (new) · `tests/golden/`
- **Steps:**
  1. `run_pipeline(..., scripture_file: list[ExportEntry] | None = None)`. With entries: detect,
     locate, build one cue per entry by the table in 14 §5, interpolate the anchors of unplaced
     entries, then build the leftover detections as v1 cues with `not_in_export`. Entry text is
     never fetched, and never written to the Bible cache. Commit.
  2. A golden file for the synthetic fixture from T-51.1. Check that every v1 golden file is
     unchanged. Commit.
- **Verify:** `pytest tests/test_pipeline_export.py tests/test_golden.py -q`
- **Done when:**
  - [ ] Without a scripture file, the output is byte-identical to v1.
  - [ ] A test proves the provider is not called for entries.

### T-51.5 · API and CLI

**Executor** agent · **Size** XS · **Prereqs** T-51.4 · **Status** todo

- **Read:** [14 §6](../14-scripture-file-import.md)
- **Touches:** `sidecar/versesync/jobs.py` · `sidecar/versesync/cli.py` ·
  `tests/test_job_endpoints.py` · `tests/test_cli.py`
- **Steps:**
  1. Accept `options.scripture_file` on `POST /jobs`, validated like `media_path`, and add the
     three error codes. Parse after transcription, so a bad file fails fast on a cache hit.
     Add `analyse --scripture-file`, with these codes as input errors. Commit.
- **Verify:** `pytest tests/test_job_endpoints.py tests/test_cli.py -q`
- **Done when:**
  - [ ] Each of the three errors has a test over HTTP and over the CLI.

### T-51.6 · Panel: picker and review list

**Executor** agent · **Size** S · **Prereqs** T-51.5, T-29.3 · **Status** todo

- **Read:** [14 §7](../14-scripture-file-import.md) · [09](../09-ui-spec.md)
- **Touches:** `panel/js/setup.js` · `panel/js/review.js` · `panel/js/state.js` ·
  `panel/index.html` · `panel/css/` · `docs/09-ui-spec.md` · `tests/panel/`
- **Steps:**
  1. Setup: the optional picker, defaulting to the media's folder. Remember the last folder the
     way the media picker does. Send `options.scripture_file`. Commit.
  2. Review list: the **EW** badge with its translation, the unplaced-row prompt, and the
     collapsed *Other mentions (N)* group. Update 09. Test against the mock `export` scenario.
     Commit.
- **Verify:** `npm test`
- **Done when:**
  - [ ] Without a file, the panel behaves exactly as v1.
  - [ ] An unplaced cue can't be inserted until it has a time.

### T-51.H · Real sermon with its export

**Executor** human · **Size** — · **Prereqs** T-51.6 · **Status** todo

On the reference workstation, run Analyse on the 2026-10-25 *Lacking Nothing* lapel WAV with
`2026-10-25 - Scriptures.txt`, then Insert. Record the results in
`docs/qa/scripture-file-verification.md`:

1. At least **9 of 12** distinct entries are placed within **5 s** of their hand-checked
   times.
2. The repeats of James 1:4 and Psalm 91:15 land on their **second** occurrence.
3. Ezekiel 36:26 is either placed or shown as *Not found in audio*. It is never silently
   dropped.
4. No `not_in_export` cue is enabled, and the graphics show NIV, NKJV and TPT text exactly as
   in the export.

## Traps

- **Don't let `align_from` run to the end of the transcript.** Without the span cap, a short
  verse collects scattered matches across an hour of speech and scores falsely high.
- **Repeats are separate entries,** not duplicates to suppress. The congregation saw the slide
  twice.
- **Never truncate export text** (`long_passage` flags only). It is what was on screen.
- **Never put export text in the Bible cache** (D26).
