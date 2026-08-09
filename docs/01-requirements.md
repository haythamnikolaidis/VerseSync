# 01 — Requirements

The definitive list of what VerseSync must do. Every requirement has an ID so tasks in
[10-tasks.md](10-tasks.md) and cases in [11-testing.md](11-testing.md) can reference it.

Requirements inherited unchanged from VerseFlow are marked **[VF]** and cite the VerseFlow
requirement they carry over; they still apply and still need testing, but no new design work.

---

## Functional requirements

### FR-1 — Session setup

- **FR-1.1** The panel provides a **Select media file** control opening a native file picker
  filtered to common audio/video extensions (`.wav .mp3 .m4a .aac .flac .mp4 .mov .mxf`).
- **FR-1.2** The panel provides a **Select MOGRT** control filtered to `.mogrt`. **[VF FR-1.1]**
- **FR-1.3** The selected MOGRT's editable text fields are discovered at runtime and offered
  in two dropdowns, **Reference field** and **Scripture text field**, labelled with their
  group ("Description ▸ Text"). Fields are targeted by **stable index**, never by display
  name. **[VF FR-3]**
- **FR-1.4** If the MOGRT exposes no editable text fields, show a clear warning that
  After Effects–authored templates are required. **[VF FR-1.3]**
- **FR-1.5** The panel provides a **Translation** selector listing the translations available
  from the configured Bible provider for the configured credentials.
- **FR-1.6** The panel provides a **Target video track** dropdown listing the active
  sequence's video tracks, defaulting to the topmost. **[VF FR-6.6]**
- **FR-1.7** MOGRT path, field mapping, translation, target track and lead-in persist between
  sessions, keyed by MOGRT path where applicable, so a repeat run needs only the media file.
- **FR-1.8** The panel reports sidecar status (starting / ready / unreachable) and Premiere
  status (sequence open / not) at all times, and disables **Analyse** with an explanatory
  message when either is not satisfied.

### FR-2 — Transcription

- **FR-2.1** On **Analyse**, the sidecar transcribes the selected media file locally producing
  **word-level timestamps** — every word carries a start time, an end time and a confidence.
- **FR-2.2** Transcription runs on CUDA when available and falls back to CPU, honouring the
  model, quantization and device settings inherited from Faster-Whisper-Transcriber.
- **FR-2.3** Progress is reported to the panel continuously as a percentage plus a phase label
  (*Transcribing / Detecting / Resolving verses / Timing*), and includes an estimate of time
  remaining once ≥10% complete.
- **FR-2.4** A running analysis can be cancelled from the panel; cancellation releases the
  model and any temporary files.
- **FR-2.5** Transcripts are cached keyed by the media file's **content hash**, so re-running
  on the same file skips transcription entirely.
- **FR-2.6** The decoder is biased toward scripture vocabulary (see
  [04-reference-detection.md](04-reference-detection.md) §2) to improve book-name recognition.
- **FR-2.7** Voice-activity detection is applied so long silences do not produce hallucinated
  text or drift the timestamps.

### FR-3 — Reference detection

- **FR-3.1** The pipeline detects scripture references in the transcript across all forms
  enumerated in [04-reference-detection.md](04-reference-detection.md) §4, including spoken
  numbers ("John three sixteen"), explicit forms ("John chapter 3 verse 16"), ordinal book
  names ("First Corinthians", "Second Timothy"), ranges ("verses 19 through 20"), and
  context-carried references ("…and verse 5 says…").
- **FR-3.2** Every detection resolves to a canonical reference — book, chapter, verse start,
  optional verse end — plus the **token span** it came from and therefore its start and end
  timestamps in source time.
- **FR-3.3** Detections are validated against the canon: a book must exist, its chapter must
  exist, and its verse must exist in that chapter. Invalid detections are discarded.
- **FR-3.4** Every surviving detection carries a **confidence score** in `[0,1]` derived from
  book-match quality, ASR word confidence, and the structural completeness of the match.
- **FR-3.5** Book names are matched fuzzily to survive ASR errors, but only when followed by a
  plausible chapter/verse pattern, so common English words ("job", "mark", "acts") do not
  generate false positives on their own.
- **FR-3.6** Repeat mentions of the same reference within a configurable cooldown (default
  **60 s**) are suppressed by default and shown in the review list as suppressed rows the
  editor can re-enable.

### FR-4 — Verse text resolution

- **FR-4.1** For each detection, the verse text is fetched for the selected translation from
  the configured Bible provider.
- **FR-4.2** Verse text is formatted to match VerseFlow's body convention exactly: verses
  joined into a single paragraph with **verse numbers retained**. **[VF D4]**
- **FR-4.3** The reference string written to the MOGRT is the canonical form with the
  translation in parentheses — `1 Corinthians 6:19-20 (NKJV)`. **[VF D4]**
- **FR-4.4** Verse text is cached locally, keyed by `(translation, book, chapter, verse
  range)`, subject to the provider's caching terms.
- **FR-4.5** If the provider is unreachable or a passage cannot be fetched, the cue still
  appears in the review list with its reference and timing, flagged **text unavailable**, and
  is excluded from insert by default.
- **FR-4.6** A passage longer than a configurable maximum (default **6 verses**) is flagged as
  **long passage**; its body text is truncated at the limit with an ellipsis and the row warns
  the editor.
- **FR-4.7** Any attribution text the provider's licence requires is stored with the
  translation and surfaced in the panel.

### FR-5 — Timing and placement

- **FR-5.1** Each cue's **anchor** is computed per [05-timing-and-placement.md](05-timing-and-placement.md)
  §3: the earlier of the reference mention start and the read-span start, minus the configured
  lead-in, snapped to the sequence's frame boundary.
- **FR-5.2** The pipeline classifies each cue as **READ** or **PARAPHRASE** by aligning the
  resolved verse text against the transcript words around the mention, and reports the
  alignment coverage.
- **FR-5.3** Duration is derived from the classification: a READ cue lasts until the end of the
  read span plus a tail pad; a PARAPHRASE cue uses VerseFlow's reading-speed model (160 wpm,
  +1.5 s, clamped 3–20 s). **[VF FR-4.3]**
- **FR-5.4** The editor can override duration globally with a fixed value. **[VF FR-4.2]**
- **FR-5.5** Source time is converted to sequence time by locating the selected media file's
  track items in the active sequence and mapping through each item's in-point and start.
- **FR-5.6** A detection whose source moment does not appear anywhere in the current edit is
  marked **cut from edit** and excluded from insert by default.
- **FR-5.7** A detection whose source moment appears more than once in the edit is anchored to
  the earliest occurrence and flagged, with the alternatives selectable in the review row.
- **FR-5.8** Overlapping cues are resolved by truncating the earlier cue to end a configurable
  gap (default 0.25 s) before the next anchor; if that would take it below a minimum visible
  duration (default 2 s), the row is flagged **overlap** for the editor to resolve.
- **FR-5.9** All computed times are snapped to whole frames using the sequence's timebase.

### FR-6 — Review list

- **FR-6.1** After analysis, every cue is listed in timecode order showing: enabled checkbox,
  sequence timecode, reference, READ/PARAPHRASE badge, confidence, duration, the transcript
  snippet that produced it, and any warning flags.
- **FR-6.2** Each row expands to show the full resolved verse text and the surrounding
  transcript context.
- **FR-6.3** The editor can, per row: enable/disable it, edit the reference (re-resolving the
  verse text), nudge the anchor by frames or set it to the current playhead, override the
  duration, and delete it.
- **FR-6.4** The editor can add a cue manually by entering a reference and taking the anchor
  from the playhead.
- **FR-6.5** Rows are colour-flagged for low confidence, overlap, long passage, text
  unavailable, cut from edit, and suppressed duplicate.
- **FR-6.6** Clicking a row's timecode moves the Premiere playhead to that time, so the editor
  can verify a cue against the actual audio without leaving the panel.
- **FR-6.7** The panel shows a running count of enabled cues, and the **Insert** button carries
  it ("Insert 17 scriptures"). **[VF FR-6.1]**
- **FR-6.8** The review state (edits, disables, manual additions) can be saved to and loaded
  from a Cue Document file, so a review pass survives closing Premiere.

### FR-7 — Insertion

- **FR-7.1** **Insert** places one MOGRT instance per enabled cue, each at its **absolute
  computed sequence time** on the selected video track.
- **FR-7.2** For each instance, the reference is written to the mapped reference field and the
  verse text to the mapped body field, by field index. **[VF FR-6.3]**
- **FR-7.3** Each instance's timeline length equals its resolved duration. **[VF FR-6.4]**
- **FR-7.4** The whole batch is wrapped in a single undo group; one Ctrl+Z reverts it.
  **[VF NFR-3]**
- **FR-7.5** Insertion must not ripple or otherwise move existing clips on any track.
- **FR-7.6** Progress is shown as N of M; the panel stays responsive. **[VF FR-6.5]**
- **FR-7.7** Per-instance failures are recorded and summarised at the end; the editor is always
  told exactly what landed and what did not. **[VF FR-7.2]**

### FR-8 — Configuration

- **FR-8.1** Provider credentials, model and device settings, lead-in, tail pad, duration
  bounds, cooldown, confidence threshold and gap are all configurable in a config file, with
  the commonly-adjusted ones (lead-in, duration mode, translation) exposed in the panel.
- **FR-8.2** API credentials are never written to the Cue Document, the transcript cache, or
  any log.

---

## Non-functional requirements

### NFR-1 — Target environment

- **Premiere Pro 2026, Windows only**, matching VerseFlow. CSXS manifest 11+/12. **[VF NFR-1]**
- Sidecar: Python 3.11–3.13, matching Faster-Whisper-Transcriber's supported range.
- Reference workstation for performance targets: NVIDIA GPU with ≥8 GB VRAM, CUDA 12.8.

### NFR-2 — Performance

- Transcription of a 45-minute sermon completes in **≤ 4 minutes** on the reference GPU
  workstation with `large-v3-turbo` and batched inference. CPU-only is supported but
  unbounded; the panel warns before starting a CPU run over 10 minutes of audio.
- Detection, verse resolution and timing together complete in **≤ 15 s** for a 45-minute
  transcript, excluding network time for uncached verse fetches.
- A cached re-run (Journey B) returns the review list in **≤ 5 s**.
- Insert of 40 cues completes without freezing the panel; per-instance `importMGT` speed is
  Premiere-bound, so show progress rather than optimise. **[VF NFR-2]**

### NFR-3 — Robustness

- The timeline is never left partially modified without the editor being told. **[VF NFR-3]**
- The sidecar never crashes the panel: every call is timed out and every failure is a
  user-facing message, not a hang.
- A sidecar restart mid-session is recoverable — jobs are persisted, and the panel reconnects.
- Analysis is idempotent: running it twice on the same media and edit yields the same cues.

### NFR-4 — Security

- The sidecar binds **`127.0.0.1` only**, on an ephemeral port, and requires a bearer token
  generated per launch and shared via a lock file with user-only permissions.
- The sidecar never accepts a media path outside directories the editor selected in the
  session.
- No sermon audio, transcript or verse text leaves the machine except the verse-reference
  lookups sent to the configured Bible provider.

### NFR-5 — Maintainability

- Panel logic (JS), host logic (JSX) and pipeline logic (Python) are cleanly separated behind
  the two documented contracts, [07](07-sidecar-api.md) and [08](08-premiere-host-api.md).
  **[VF NFR-4]**
- Detection, timing and verse resolution are **pure, Premiere-free and Qt-free** Python,
  runnable and testable from the command line with no Adobe software installed.
- Bible providers sit behind one adapter interface; adding or swapping a provider touches one
  module.
- No hard-coded MOGRT field names. **[VF NFR-4]**

### NFR-6 — Distribution

- **Internal use only.** Unsigned CEP extension, debug-mode install, as VerseFlow. **[VF NFR-5]**
- The sidecar installs into its own virtual environment via the existing `install.py` pattern;
  the panel discovers and launches it.

### NFR-7 — Accuracy

- The metrics M1–M3 in [00-prd.md](00-prd.md) §5 are requirements, not aspirations. The
  accuracy harness (T-30) runs against the fixture corpus and a regression below target blocks
  release.

---

## Out of scope (v1)

- Allusion detection without a spoken reference.
- Multiple MOGRT templates in one run.
- Non-English audio, and translation of foreign-language audio.
- Editing or removing graphics already on the timeline. **[VF, out of scope]**
- Automatic resolution of chapter-only references to the verses actually read (specced P2 in
  [05](05-timing-and-placement.md) §6).
- Speaker diarisation.
- macOS, and any Premiere version other than 2026.
- Localisation of the panel UI. **[VF, out of scope]**
- Audio-track placement of graphics. **[VF, out of scope]**
