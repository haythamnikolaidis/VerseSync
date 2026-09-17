# 00 — Product Requirements Document

**Product:** VerseSync
**Version:** 1.0 (specification)
**Owner:** Product
**Status:** Approved for build, pending the M1 spike gate (see [10-tasks.md](10-tasks.md))

---

## 1. The problem

A sermon video contains anywhere from three to forty scripture references. Today, putting
those on screen is a manual, tedious, error-prone job:

1. Watch the sermon and write down every scripture the speaker mentions, with a timecode.
2. Look each one up in the right translation and copy the verse text into a document.
3. Build a graphic per scripture, or — with **VerseFlow** — batch-insert them and then drag
   each clip along the timeline to the right moment.

Step 1 takes as long as the sermon. Step 3 is where the real cost sits: VerseFlow already
solved *filling and inserting* the graphics, but it places them back-to-back from the
playhead, so an editor still repositions every single one by hand. For a 45-minute sermon
with 20 references, that is a 60–90 minute task per video, repeated weekly, and it is exactly
the kind of work where a mistimed or mismatched verse is embarrassing on a published video.

**VerseSync closes the last gap: knowing *when* each scripture belongs, automatically.**

---

## 2. What VerseSync is

A Premiere Pro panel that turns a sermon into a timed set of scripture graphics with two
clicks — *Analyse*, then *Insert* — and a review pass in between.

It composes three capabilities:

- **Listen.** Transcribe the sermon audio locally, with word-level timestamps, using the
  existing Faster-Whisper-Transcriber engine.
- **Understand.** Find every scripture reference in the transcript, however the speaker
  phrased it, resolve its verse text, and work out whether it was read aloud or paraphrased.
- **Place.** Convert each detection into a sequence timecode and insert a filled MOGRT there,
  reusing VerseFlow's proven insert technique.

---

## 3. Who it is for

| User | Context | What they need |
|------|---------|----------------|
| **Primary — the video editor** | Cuts the weekly sermon in Premiere on Windows. Comfortable in Premiere, not a developer. Works to a publish deadline. | To stop scrubbing the timeline hunting for scripture moments. Wants to trust the output enough to skim it, not re-check it. |
| **Secondary — the media lead** | Owns the church's brand templates and the publishing standard. | Consistent graphics, correct translations, correct attribution, nothing wrong going out. |
| **Operator — whoever installs it** | Sets up the editing workstation. | An install that is a folder copy plus a config file, not a build pipeline. |

**Non-users in v1:** live/streaming operators, mobile editors, macOS editors, anyone
without a CUDA GPU (CPU works, just slowly — see NFR-2).

---

## 4. Goals and non-goals

### Goals

- **G1 — Eliminate manual timing.** The editor never scrubs to find where a scripture belongs.
- **G2 — Eliminate manual lookup.** The editor never types or pastes verse text.
- **G3 — Be trustworthy by being visible.** Every automated decision is shown with its
  evidence (timecode, transcript snippet, confidence) before anything touches the timeline.
- **G4 — Handle paraphrase as a first-class case.** A speaker who says "Paul tells us in
  Romans 8 that nothing can separate us from God's love" gets the same graphic as one who
  reads the verse verbatim.
- **G5 — Be recoverable.** One Ctrl+Z undoes the batch. Re-running is cheap.

### Non-goals (v1)

- Real-time or live operation.
- Detecting scripture *allusions* with no spoken reference (e.g. quoting John 3:16 without
  ever naming it). Out of scope; see §9.
- Choosing or designing the graphic. The editor supplies a `.mogrt`, as in VerseFlow.
- Editing or removing graphics already on the timeline.
- Multi-language sermons, or translation of non-English audio.
- Replacing VerseFlow's manual `.txt` workflow, which stays available for hand-authored runs.

---

## 5. Success metrics

Measured against the QA corpus in [11-testing.md](11-testing.md) (10 real sermons, hand-labelled).

| # | Metric | Target | Why this number |
|---|--------|--------|-----------------|
| **M1** | **Reference recall** — of scriptures a human annotator marks as spoken, the share VerseSync surfaces in the review list. | **≥ 90%** | A missed reference costs the editor a full manual add; ten per cent is a tolerable residue for a skim-check. |
| **M2** | **Reference precision** — of cues VerseSync surfaces, the share that are genuinely correct. | **≥ 85%** | Below this the review list becomes work rather than a check. False positives are cheap to uncheck, so precision is targeted lower than recall deliberately. |
| **M3** | **Anchor accuracy** — cues whose anchor is within **±0.5 s** of the human-labelled start. | **≥ 90%** | Half a second is under the animate-in of a typical lower-third, so the error is invisible on screen. |
| **M4** | **Editor time per sermon** — wall-clock from opening the panel to graphics placed. | **≤ 10 min** for a 45-min sermon on the reference GPU workstation | Against a 60–90 min manual baseline. Includes transcription. |
| **M5** | **Review burden** — cues the editor edits or unchecks. | **≤ 20%** | If the editor changes more than one cue in five, the automation is not carrying its weight. |

M1–M3 are gated by the accuracy harness ([T-33](tasks/T-33-accuracy-harness.md)); a build that
regresses them does not ship.

---

## 6. The two user journeys

### Journey A — the weekly sermon (the 95% case)

1. Editor opens their sequence, opens **Window ▸ Extensions ▸ VerseSync**.
2. Panel reports the sidecar is running and a sequence is open.
3. Editor picks the **sermon media file** (the same file already in the timeline), the
   **`.mogrt`**, and the **translation**. Field mapping and target track carry over from last
   time.
4. Editor clicks **Analyse**. Progress runs through *Transcribing → Detecting → Resolving
   verses → Timing*. A 45-minute sermon takes ~2–4 minutes on the reference GPU.
5. The **review list** appears: 18 cues, each with timecode, reference, a READ or PARAPHRASE
   badge, confidence, and the transcript snippet that triggered it.
6. Editor skims. Two rows are flagged amber — one low confidence, one overlapping the next
   cue. They uncheck a duplicate mention and nudge one anchor by 8 frames.
7. Editor clicks **Insert 17 scriptures**. Graphics land on V3 at their computed timecodes.
8. Editor scrubs three spots to spot-check, then carries on cutting.

### Journey B — the re-run

The editor recuts the sermon, moving and trimming clips. They reopen the panel and click
**Analyse** again. VerseSync recognises the media file by content hash, restores the cached
transcript and detections instantly, **re-derives every anchor against the current edit**, and
shows the review list in under five seconds. Cues whose source moment has been cut out of the
edit are marked *cut from edit* and excluded by default.

Journey B is what makes VerseSync survive contact with a real edit, and it is a v1
requirement, not a nice-to-have.

---

## 7. What "at the right moment" means

This is the product's core promise, so it is defined precisely.

A cue's **anchor** is the earliest of:

- the start timestamp of the **first word of the spoken reference** ("…in **John** three
  sixteen…"), and
- the start timestamp of the **read span**, when the speaker begins quoting the verse before
  naming it ("*For God so loved the world* — that's John 3:16").

…minus a configurable **lead-in** (default **0.5 s**) so the template's animate-in completes
by the time the words land, then snapped to the nearest frame boundary.

Full rules, including repeat mentions, chapter-only references and overlap resolution, are in
[05-timing-and-placement.md](05-timing-and-placement.md).

---

## 8. Scope

### In scope for v1

- English-language sermon audio, one media file per run.
- The 66-book Protestant canon.
- One `.mogrt` template per run, two mapped text fields (reference, body) — as VerseFlow.
- Local transcription (CUDA or CPU) with word-level timestamps.
- Reference detection covering spoken, written, ordinal, ranged and context-carried forms.
- Read-vs-paraphrase classification, driving duration.
- Verse text from a licensed Bible API, cached locally.
- Review list with per-cue enable, edit, re-time and delete, plus manual add.
- Absolute-timestamp insertion on a chosen video track, in one undo group.
- Transcript and detection caching keyed by media content hash.

### Out of scope for v1 (candidates for later)

| Deferred | Why | Revisit when |
|----------|-----|--------------|
| Allusion detection with no spoken reference | Requires semantic search over the whole Bible; high false-positive risk | After M1/M2 are stable |
| Multiple templates in one run (e.g. a different look for long passages) | Adds a mapping matrix to the UI | Requested by the media lead |
| Automatic chapter-only passage resolution | Needs whole-chapter alignment; specced but P2 | See [05](05-timing-and-placement.md) §6 |
| Speaker diarisation (ignore references in a reading by a second voice) | Extra model, unclear benefit | If false positives cluster there |
| macOS | VerseFlow is Windows-only; the sidecar is portable but CUDA setup is not | If an editor moves to Mac |
| UXP re-platform | Tracked as inherited risk R1 | When UXP can write MOGRT text |

---

## 9. Key product risks

The full register is in [12-decisions-and-risks.md](12-decisions-and-risks.md). The three that
could change the product:

- **Translation licensing (R-1, high).** D1 puts verse text behind a Bible API. The
  translations the church actually preaches from — NKJV and TPT in VerseFlow's sample data —
  may not be available under acceptable terms from any single provider. Mitigated by a
  provider-adapter abstraction and a local-store adapter that can be built in days if needed.
- **Detection quality on real audio (R-2, high).** Every metric above depends on Whisper
  hearing "Philippians" rather than "Philippines". Mitigated by book-name decoder biasing,
  canon validation, fuzzy matching, and — structurally — by D4's review list, which converts a
  detection error from a published mistake into a checkbox.
- **ExtendScript end-of-support (R-3, inherited high).** Adobe supports ExtendScript
  integrations only through approximately September 2026. VerseSync inherits VerseFlow's
  mitigation: everything touching Premiere sits behind the `VS.*` host contract, so a UXP port
  is contained to one layer. Note that VerseSync's value — detection and timing — lives
  entirely in the sidecar and survives any Premiere-side re-platform.

---

## 10. Release plan

| Milestone | Contents | Gate |
|-----------|----------|------|
| **M1 — Spikes** | Word timestamps from faster-whisper on real sermon audio; `importMGT` at an absolute time on a populated track; source→sequence mapping from a real sequence. | **Hard gate.** If absolute-time insert ripples the timeline or word timestamps are unusable, stop and re-plan. |
| **M2 — Headless pipeline** | Sidecar service; transcription with word timestamps; reference detection; Bible provider adapter; Cue Document output. Verified from the command line, no Premiere. | Detection metrics M1/M2 measured on the fixture corpus. |
| **M3 — Panel & host** | `VS.*` host layer; setup UI; review list; absolute-time batch insert; undo group. | Journey A end-to-end on one real sermon. |
| **M4 — Re-run & resilience** | Content-hash caching; re-anchoring against a changed edit; cut-from-edit detection; full error surface. | Journey B; the QA script in [11-testing.md](11-testing.md) passes. |
| **M5 — Hardening** | Accuracy harness across the 10-sermon corpus; performance pass; install documentation. | M1–M5 metrics met. |

---

## 11. Open questions

Carried in [12-decisions-and-risks.md](12-decisions-and-risks.md) §Open questions. The two
that need an answer before M2 completes:

- **Q-A — Which translations, from which provider?** Drives R-1 and the whole of
  [06](06-bible-text-service.md). Needs a licensing decision, not an engineering one.
- **Q-B — Default translation behaviour.** Does a project fix one translation, or should
  VerseSync honour a spoken cue ("…in the New King James…")? Specced as a project-level
  default with spoken override as P2; confirm that is the right shape.
