# 10 — Task Backlog

Each task is **self-contained**: a developer with no prior context should be able to pick one
up, read the linked spec section, and finish it. Tasks are ordered so dependencies come first.
Every task lists **Goal · Prereqs · Steps · Files · Done when · Est.**

Estimates: **S** = ≤ half a day · **M** = ~1 day · **L** = 2–3 days · **XL** = ~1 week.

> Before any host (`.jsx`) task, read [08](08-premiere-host-api.md) **and** VerseFlow's
> `docs/planning/02-adobe-research.md`. Before detection work, read
> [04](04-reference-detection.md). Before timing work, read [05](05-timing-and-placement.md).

---

## Milestone M1 — Spikes (hard gate)

**Nothing else starts until these three answer their questions.** Each one can invalidate a
major design decision, and each is cheap compared to discovering the answer in week six.

### T-01 · Obtain and verify the reference assets · S
**Goal:** A real `.mogrt`, a real sermon media file, and a sequence containing it, on the dev
machine.
**Steps:** Get `AV_Quote_04.mogrt` from the client (it is deliberately not in either repo).
Place at `assets/test/AV_Quote_04.mogrt`. Get at least one full sermon media file with its
Premiere project. Verify the VerseFlow panel still installs and inserts, per its README — that
is the known-good baseline everything is measured against.
**Done when:** VerseFlow inserts 10 scriptures from `assets/sample-scriptures.txt` into a real
sequence on the dev machine.

### T-02 · Spike: word-level timestamps on real sermon audio · M
**Goal:** Know whether Faster-Whisper's word timestamps are accurate enough for a ±0.5 s anchor.
**Prereqs:** T-01.
**Steps:**
1. Hand-label the start time of 30 scripture mentions in one sermon, to the frame.
2. Transcribe with `word_timestamps=True` on `large-v3`, `large-v3-turbo` and
   `distil-whisper-large-v3`, with and without `vad_filter=True`.
3. Measure the error distribution of matched word starts against the labels.
4. A/B the `initial_prompt` from [04](04-reference-detection.md) §2 for book-name accuracy, and
   settle `condition_on_previous_text`.
5. Record transcription wall-time per model for NFR-2.
**Files:** `spikes/word_timestamps/`.
**Done when:** A written result recommending a default model, quantization, VAD settings and
prompt strategy — with the measured p50/p90 timestamp error.
**Gate:** If p90 error exceeds ~0.5 s on the best configuration, stop. The product promise is
not deliverable as specified and the anchor tolerance or the approach must change.

### T-03 · Spike: `importMGT` at an absolute time on a populated track · M
**Goal:** Answer the question in [08](08-premiere-host-api.md) §6.1 — **overwrite or ripple?**
**Prereqs:** T-01.
**Steps:**
1. Build a sequence with clips on V1–V3 and known content after 00:05:00.
2. `importMGT` at 00:02:00 on V3 where a clip already exists. Record whether the existing clip
   is overwritten, split, or pushed right, and whether anything on other tracks moves.
3. Repeat on an empty track and past the end of the sequence.
4. Test `_setClipDuration` extending a clip's `end` into an adjacent clip.
5. Test inserting 20 cues out of order, and descending.
**Files:** `spikes/absolute_insert/`.
**Done when:** Documented behaviour for each case, and a recommendation: proceed as specified,
require an empty track, insert descending, or fall back to VerseFlow's Option B (pre-render +
`overwriteClip`).
**Gate:** M1 does not pass without an answer here. It determines the entire Premiere-side design.

### T-04 · Spike: source→sequence mapping from a real sequence · M
**Goal:** Confirm `VS.getMediaSegments` is buildable and characterise its edge cases.
**Prereqs:** T-01.
**Steps:** Walk `videoTracks`/`audioTracks`, read `clip.projectItem.getMediaPath()`,
`clip.start`, `clip.end`, `clip.inPoint`, `clip.getSpeed()`. Verify on: a straight cut, a
trimmed clip, the same media used twice, a detached audio clip, a speed-changed clip, a merged
clip, a multicam clip, and a nested sequence.
**Files:** `spikes/media_segments/`.
**Done when:** A table of which cases resolve, which do not, and exactly what `getMediaPath()`
returns for each. Feeds [05](05-timing-and-placement.md) §5.3 and [08](08-premiere-host-api.md) §4.

---

## Milestone M2 — Headless pipeline (no Premiere)

Everything here is testable from a terminal. This is where the product's actual value gets built.

### T-05 · Sidecar scaffold · M
**Goal:** `python -m versesync.sidecar` serves `/health`, writes the lock file, authenticates.
**Prereqs:** M1 passed.
**Steps:** Project layout per [03](03-architecture.md) §5. HTTP server with bearer auth, origin
allowlist, loopback-only bind, ephemeral port, lock file with user-only ACLs, idle self-exit,
structured logging. `GET /health` per [07](07-sidecar-api.md) §2.
**Done when:** `curl` gets a health response with the token and `401` without it; two sidecars
cannot both claim the lock.

### T-06 · Upstream refactor: Qt-free transcription engine · M
**Goal:** Close **Gap 2** from [02](02-source-project-audit.md) §2.2 in
`Faster-Whisper-Transcriber`.
**Steps:** Extract `core/transcription/engine.py` with `transcribe_with_words(model,
audio_path, *, batch_size, vad_filter, vad_parameters, initial_prompt, language, temperature,
progress) -> Transcript`. No Qt imports. Refactor `TranscriptionService` to call it. Delete the
dead `core/service.py` (Gap 7). Add `word_timestamp_quality` to `ModelMetadata` (Gap 5).
**Done when:** The existing GUI behaves identically, and `transcribe_with_words` runs from a
plain script with no `QApplication`.
**Note:** This is a PR against the upstream repo. Keep it minimal and additive.

### T-07 · Transcription in the sidecar · M
**Prereqs:** T-05, T-06.
**Steps:** Wire `core.cuda_setup` (before anything else), `load_model`, and
`transcribe_with_words`. Word array with `(text, start, end, probability)`. Progress callback
by segment end ÷ media duration. Cooperative cancellation. `temperature=0`, fixed seed, per
[05](05-timing-and-placement.md) §10.
**Done when:** The CLI transcribes a 45-minute file, emits a word array, reports progress, and
cancels within 5 s.

### T-08 · Content hashing and transcript cache · S
**Steps:** SHA-256 over first 8 MB + last 8 MB + file size. Cache the word array with the model
and options used. Invalidate on any option change that would alter the transcript.
**Done when:** A second run on the same file returns in < 2 s with `cache_hit: true`.

### T-09 · Canon data · S
**Goal:** `detect/data/canon.json` — 66 books with canonical name, OSIS id, aliases, chapter
count and verses per chapter.
**Steps:** Generate from a public-domain source, check it in, add a test asserting the totals
(1,189 chapters; Psalm 119 has 176 verses; Jude has 1 chapter; Obadiah has 21 verses).
**Done when:** The table validates and loads in < 50 ms.

### T-10 · Token normalisation and spoken-number parsing · M
**Prereqs:** T-09.
**Steps:** [04](04-reference-detection.md) §3 in full — `Token` with word back-references,
normalisation pipeline, spoken-number parser to 176 including compounds and hundreds, ordinal
handling, the search-string + offset-map construction.
**Done when:** Unit tests cover the §3.1 table including "one hundred and nineteen", "twenty
eight", "first Corinthians"; timestamps round-trip from a token span back to source seconds.

### T-11 · Book matching · M
**Prereqs:** T-09.
**Steps:** Three tiers per [04](04-reference-detection.md) §4.1 — exact/alias, curated
confusion table, fuzzy (Levenshtein + Double Metaphone). Implement the **number-follows gate**
and the exact-only restriction for short high-frequency book names.
**Done when:** The negative fixtures ("he lost his job", "faith without works acts dead", "mark
my words") produce zero matches, and the seed confusion entries all resolve.

### T-12 · The grammar · L
**Prereqs:** T-10, T-11.
**Steps:** Patterns P1–P12 in priority order, with span consumption, context carry with its
window, and the Psalms concatenation ambiguity emitting alternatives.
**Done when:** Every row of the [04](04-reference-detection.md) §4 table is covered by a passing
test, including context-carried verses and the window expiring.

### T-13 · Canon validation and confidence · M
**Prereqs:** T-12.
**Steps:** [04](04-reference-detection.md) §5 rejection rules; §6 confidence formula with
weights as named constants; duplicate suppression with cooldown.
**Done when:** Impossible references are rejected, confidence is deterministic, and suppression
collapses repeats correctly.

### T-14 · Bible provider interface + local adapter · M
**Steps:** `BibleProvider` protocol, error taxonomy, `local.py` reading a bundled
public-domain translation, `format.py` implementing [06](06-bible-text-service.md) §2.
**Done when:** The **round-trip test passes** — a `Passage` rendered to VerseFlow `.txt` format
and parsed by VerseFlow's `scripture-parser.js` regex yields identical reference/translation/body.
**Note:** Building `local.py` first means the whole test suite runs offline.

### T-15 · API.Bible adapter · M
**Prereqs:** T-14.
**Steps:** `api_bible.py`, `GET /translations`, OSIS-id passage fetch, markup stripping,
batching, rate-limit backoff, typed errors, attribution and `cache_allowed` metadata.
**Done when:** Real passages fetch and format identically to the local adapter's output for the
same translation.
**Blocked by:** open question **Q-A** for anything beyond public-domain translations.

### T-16 · Verse cache · S
**Steps:** SQLite keyed per [06](06-bible-text-service.md) §4, honouring per-translation
`cache_allowed`. Clear-cache action.
**Done when:** A warm cache issues zero network calls; a `cache_allowed: false` translation
always refetches.

### T-17 · Read-span alignment · L
**Prereqs:** T-12, T-14.
**Steps:** [05](05-timing-and-placement.md) §4 — alignment normalisation, monotonic greedy
matcher with skip budget, multi-start search, coverage, read start/end, classification.
**Done when:** On the fixture corpus, hand-labelled readings score ≥ 0.6 and paraphrases
≤ 0.35, with no overlap between the two distributions. If they overlap, tune and document.

### T-18 · Anchors and durations · M
**Prereqs:** T-17.
**Steps:** [05](05-timing-and-placement.md) §3 — anchor rule with lookbehind, lead-in, READ and
PARAPHRASE duration branches (the latter using VerseFlow's constants verbatim), corroboration
confidence bonus.
**Done when:** The §9 worked example reproduces exactly.

### T-19 · Cue Document assembly · S
**Steps:** [07](07-sidecar-api.md) §5 schema with `schema_version`, all fields, flags,
alternatives, separate transcript file.
**Done when:** A document validates against a checked-in JSON Schema and round-trips.

### T-20 · Job orchestration and SSE · M
**Prereqs:** T-07, T-13, T-15, T-18, T-19.
**Steps:** `POST /jobs`, `GET /jobs/{id}`, SSE `/events`, `DELETE`, `/resolve`, weighted phase
progress per [07](07-sidecar-api.md) §4, error taxonomy §3.
**Done when:** A full job runs end-to-end over HTTP with live progress and clean cancellation.

### T-21 · CLI · S
**Prereqs:** T-20.
**Steps:** `analyse`, `detect`, `resolve` per [07](07-sidecar-api.md) §6, calling the same
pipeline functions as the service.
**Done when:** A test asserts CLI and HTTP produce identical Cue Documents for the same input.

---

## Milestone M3 — Panel and host

### T-22 · Panel scaffold + bridge · S
**Steps:** Layout per [03](03-architecture.md) §5. Vendor `CSInterface.js`. Manifest with bundle
id `com.versesync.panel`, `.debug` port. Port VerseFlow's `bridge.js` including the explicit
`loadJSX()` and the `EvalScript error.` sentinel handling.
**Done when:** Panel loads in Premiere and `VS.ping` returns.

### T-23 · Host: sequence info, field discovery, playhead · M
**Prereqs:** T-22.
**Steps:** Port VerseFlow's `VerseFlow.jsx` to `VerseSync.jsx` — one file, JSON polyfill, `var
fn =` convention. Implement `VS.ping`, `VS.getSequenceInfo` (extended with `timebase`,
`frameRate`, `zeroPointTicks`), `VS.getMogrtFields` (unchanged logic), `VS.setPlayhead`.
**Done when:** Field discovery returns both `Text` fields of `AV_Quote_04.mogrt` with distinct
indices and group-qualified labels.

### T-24 · Host: `VS.getMediaSegments` · M
**Prereqs:** T-04, T-23.
**Steps:** [08](08-premiere-host-api.md) §4, implementing whatever T-04 established. Path
normalisation, video + audio tracks, speed detection, `unsupported` reporting.
**Done when:** All T-04 cases return the documented result on a real sequence.

### T-25 · Host: `VS.insertCues` + `VS.validateTrack` · L
**Prereqs:** T-03, T-23.
**Steps:** [08](08-premiere-host-api.md) §6 and §8, implementing whatever T-03 established.
One undo group, sorted-input assertion, per-cue failure isolation, `actualStartTicks` read-back,
`com.versesync.progress` events.
**Done when:** 20 cues land at 20 distinct absolute times with correct text and durations, and
one Ctrl+Z removes all of them.

### T-26 · Panel: sidecar client · M
**Prereqs:** T-05, T-22.
**Steps:** `sidecar.js` — lock-file discovery, launch, health polling, bearer auth, SSE with
polling fallback, version handshake, the full lifecycle in [03](03-architecture.md) §3.
**Done when:** The panel starts a sidecar cold, survives a panel reload mid-job, and reports
every failure state from [09](09-ui-spec.md) §2.

### T-27 · Panel: setup UI · M
**Prereqs:** T-23, T-26.
**Steps:** [09](09-ui-spec.md) §3 in full, including VerseFlow's smart mapping defaults,
`pickFileCEP`, persistence, and per-control enablement reasons.
**Done when:** Every persisted setting survives a Premiere restart and Analyse enables exactly
per the stated conditions.

### T-28 · Panel: time mapping · L
**Prereqs:** T-24, T-26.
**Steps:** `timemap.js` — source→sequence resolution with the 0/1/n candidate rules, frame
snapping, overlap sweep, flag assignment for `cut_from_edit`, `multiple_placements`,
`speed_change_unsupported`. Manual-offset fallback.
**Done when:** Unit tests (pure JS, no Premiere) cover every case in
[05](05-timing-and-placement.md) §5 and §8, including the worked example in §9.

### T-29 · Panel: review list · XL
**Prereqs:** T-27, T-28.
**Steps:** [09](09-ui-spec.md) §5 — rows, flags, expansion, reference editing with `/resolve`,
frame nudging, playhead set and jump, manual add, bulk actions, save/load, VerseFlow `.txt`
export.
**Done when:** Every FR-6 requirement demonstrably works on a real analysis of a real sermon.

### T-30 · Panel: insert orchestration · M
**Prereqs:** T-25, T-29.
**Steps:** Validation, `VS.validateTrack` confirmation, payload build and sort, progress
events, summary with per-cue failures, retained review state.
**Done when:** Journey A completes end-to-end on a real sermon.

---

## Milestone M4 — Re-run and resilience

### T-31 · Journey B · M
**Prereqs:** T-28, T-08.
**Steps:** Cache-hit path through the UI; re-derive all anchors against the current edit;
`cut_from_edit` detection after a recut.
**Done when:** Recutting a sequence and re-analysing returns in < 5 s with correctly updated
anchors and cut cues flagged.

### T-32 · Error surface pass · M
**Steps:** Every row of [03](03-architecture.md) §8 and [09](09-ui-spec.md) §7 implemented and
manually triggered.
**Done when:** Each failure is reproducible on demand and produces the specified message.

---

## Milestone M5 — Hardening

### T-33 · Accuracy harness · L
**Prereqs:** T-21, the corpus from [11](11-testing.md) §3.
**Steps:** `tools/accuracy_harness.py` computing M1 recall, M2 precision and M3 anchor accuracy
against hand labels; per-sermon and aggregate reporting; a diff mode against a previous run.
**Done when:** It runs from one command and prints the three metrics.

### T-34 · Threshold tuning · M
**Prereqs:** T-33.
**Steps:** Tune the confidence weights ([04](04-reference-detection.md) §6), the read-coverage
threshold ([05](05-timing-and-placement.md) §4.2), the fuzzy distance bounds and the context
window against the corpus. Document every chosen value **with the measurement that chose it**.
**Done when:** M1 ≥ 90%, M2 ≥ 85%, M3 ≥ 90%, and the constants carry a comment citing the data.

### T-35 · Performance pass · M
**Steps:** Verify NFR-2 on the reference workstation: transcription ≤ 4 min for 45 min of audio,
pipeline ≤ 15 s, cached re-run ≤ 5 s, 40-cue insert without freezing. Tune `batch_size`.
**Done when:** Measured numbers are recorded in the repo README.

### T-36 · Install and documentation · M
**Steps:** Sidecar venv installer following `install.py`'s pinned-wheel pattern; panel install
per VerseFlow's debug-mode instructions; a README covering both, the config file, credentials,
and the licensing obligations from [06](06-bible-text-service.md) §5.
**Done when:** A clean Windows workstation goes from nothing to a completed Journey A using only
the README.

---

## Dependency summary

```
T-01 ─┬─ T-02 ─────────────────────────► T-07
      ├─ T-03 ─────────────────────────► T-25
      └─ T-04 ─────────────────────────► T-24

T-05 ─── T-07 ─── T-08
T-06 ─── T-07
T-09 ─┬─ T-10 ─┬─ T-12 ─── T-13 ─┐
      └─ T-11 ─┘                 ├─── T-20 ─── T-21 ─── T-33 ─── T-34
T-14 ─┬─ T-15 ─── T-16 ──────────┤
      └─ T-17 ─── T-18 ─── T-19 ─┘

T-22 ─┬─ T-23 ─┬─ T-24 ─── T-28 ─┬─ T-29 ─── T-30 ─── T-31
      │        └─ T-25 ──────────┘
      └─ T-26 ─── T-27 ──────────┘
```

The two chains — sidecar (T-05…T-21) and Premiere (T-22…T-30) — are independent after M1 and can
run in parallel by different people. They meet at T-29.
