# VerseSync — Product Requirements & Technical Plan

**This folder is the single source of truth for building VerseSync.** Read
[00-prd.md](00-prd.md) first for the product-level "what and why"; the numbered documents
after it are the engineering specification.

> **Status:** Specification complete, ready for implementation. No production code has been
> written — only illustrative snippets inside these documents.

---

## What we are building (one paragraph)

VerseSync is a dockable panel inside Adobe Premiere Pro. The editor points it at the sermon
media file and clicks one button. VerseSync transcribes the audio locally with
Faster-Whisper, finds every scripture reference the speaker mentions or reads, fetches the
verse text for each one from a Bible API, works out the exact moment on the timeline where
that scripture begins, and shows the editor a review list. One more click places every
scripture on the timeline as its own Motion Graphics Template instance, each starting at the
frame where the speaker begins reading or mentions the reference.

---

## Relationship to the two existing projects

| Project | Role in VerseSync | What we take |
|---------|-------------------|--------------|
| **VerseFlow** | Ancestor. Its planning package and host code are the proven foundation for everything that touches Premiere. | The `.mogrt` insert-and-fill technique, index-based field mapping, undo grouping, ticks math, duration model, panel/host architecture. |
| **Faster-Whisper-Transcriber** | Transcription engine. Becomes a headless sidecar service alongside its existing GUI. | Model loading, quantization/CUDA setup, the faster-whisper integration. |
| **VerseSync** (this repo) | The new product. Owns reference detection, timing, verse resolution, the review UI, and the panel that ships to editors. | — |

VerseFlow's placement model (sequential, from the playhead) is the one thing VerseSync
replaces outright: VerseSync places each graphic at an **absolute, computed timestamp**.

A full file-by-file audit of what is reusable, what needs changing, and what is missing is in
[02-source-project-audit.md](02-source-project-audit.md).

---

## Confirmed product decisions

These four are locked and everything in this package assumes them. Each links to the document
that carries the blast radius if it changes.

| # | Decision | Choice | Detail in |
|---|----------|--------|-----------|
| **D1** | **Verse text source** | **Online Bible API** (API.Bible primary, provider-adapter abstraction) with a local cache. | [06-bible-text-service.md](06-bible-text-service.md) |
| **D2** | **Product shape** | **One CEP panel + a local Python sidecar** on `127.0.0.1`. VerseFlow's insert logic is absorbed into VerseSync's host layer. | [03-architecture.md](03-architecture.md) |
| **D3** | **Audio input & time mapping** | **Editor points at the source media file.** Source-clip time is mapped to sequence time by walking the sequence's track items. | [05-timing-and-placement.md](05-timing-and-placement.md) |
| **D4** | **Human confirmation** | **Review list, then one-click insert.** Nothing lands on the timeline unreviewed. | [09-ui-spec.md](09-ui-spec.md) |

**Inherited from VerseFlow (unchanged):** CEP + ExtendScript host · AE-authored `.mogrt`
templates only · index-based field targeting · Premiere Pro 2026, Windows only · internal
distribution (unsigned, debug-mode install) · reference field carries the full
`1 Corinthians 6:19-20 (NKJV)` string, body field carries verse text with verse numbers
retained.

---

## How to read this package

Read in order if you are new. Then go to [13-technical-plan.md](13-technical-plan.md) for the
build order, and pick a task from [`tasks/`](tasks/).

| File | Purpose |
|------|---------|
| [00-prd.md](00-prd.md) | **The PRD.** Problem, users, goals, success metrics, scope, journeys, release plan. |
| [01-requirements.md](01-requirements.md) | Numbered functional + non-functional requirements. The contract for "done". |
| [02-source-project-audit.md](02-source-project-audit.md) | What exists in VerseFlow and Faster-Whisper-Transcriber, what is reusable as-is, and every gap that must be closed. |
| [03-architecture.md](03-architecture.md) | The three processes, how they talk, folder layout, failure model. |
| [04-reference-detection.md](04-reference-detection.md) | The core algorithm: transcript → scripture references, with timestamps and confidence. |
| [05-timing-and-placement.md](05-timing-and-placement.md) | Anchor rules, read-vs-paraphrase detection, source→sequence time mapping, duration, collisions. |
| [06-bible-text-service.md](06-bible-text-service.md) | Bible API integration, provider adapters, caching, licensing obligations. |
| [07-sidecar-api.md](07-sidecar-api.md) | HTTP contract between the panel and the Python sidecar, plus the Cue Document schema. |
| [08-premiere-host-api.md](08-premiere-host-api.md) | The `VS.*` ExtendScript contract — what the panel can ask Premiere to do. |
| [09-ui-spec.md](09-ui-spec.md) | Panel layout, every control, and the review list. |
| [10-tasks.md](10-tasks.md) | **The backlog index.** Every task, by wave and stream. |
| [`tasks/`](tasks/) | **One file per task** — goal, context, steps, done-when, traps. Self-contained; this is where day-to-day work lives. |
| [11-testing.md](11-testing.md) | Unit, integration and manual QA strategy, plus the fixture corpus. |
| [12-decisions-and-risks.md](12-decisions-and-risks.md) | Decision log, risk register, and open questions still needing an answer. |
| [13-technical-plan.md](13-technical-plan.md) | **The build order.** Workstreams, waves, what unblocks whom, staffing, and working agreements. |

---

## Glossary

Terms inherited from VerseFlow (**CEP**, **ExtendScript/JSX**, **CSInterface**, **MOGRT**,
**Essential Graphics parameters**, **sequence**, **track item**, **playhead**) keep their
meanings — see VerseFlow's `docs/planning/README.md`. New to VerseSync:

- **Ticks** — Premiere's internal time unit. **254,016,000,000 ticks = 1 second.** All
  timeline math in VerseSync is in ticks.
- **Sidecar** — the local Python process that runs Faster-Whisper and the detection pipeline.
  It serves HTTP on `127.0.0.1` and is started and stopped by the panel.
- **Cue** — one detected scripture, resolved and timed: a reference, its verse text, an anchor
  time, a duration, a confidence score and its provenance. The unit the review list shows and
  the host inserts.
- **Cue Document** — the versioned JSON envelope holding all cues for one media file, plus the
  transcript and job metadata. The sidecar's output and the panel's input.
- **Anchor** — the sequence time at which a cue's graphic starts. The product's whole reason
  for existing is getting this right.
- **Source time** — a timestamp measured from the start of the media *file*. What Whisper
  returns.
- **Sequence time** — a timestamp measured from the start of the Premiere *sequence*. What
  `importMGT` needs. Converting between the two is [05](05-timing-and-placement.md)'s job.
- **Read span** — a run of transcript words that measurably matches the verse text, i.e. the
  speaker was reading it aloud rather than paraphrasing.
- **Word timestamp** — Faster-Whisper's per-word `(start, end, probability)`. The raw material
  for every anchor VerseSync computes.

---

## Definition of Done for the whole project

1. The editor selects a media file, a `.mogrt`, and a translation, then clicks **Analyse**.
2. VerseSync transcribes the audio locally and lists every scripture reference it found, each
   with a timecode, the matched transcript snippet, the resolved verse text, a read/paraphrase
   badge and a confidence score.
3. Every listed cue can be unchecked, corrected, re-timed, or deleted; a missed reference can
   be added by hand.
4. Clicking **Insert** places one MOGRT instance per approved cue, each starting on the frame
   where the speaker begins reading or mentions that scripture, with reference and verse text
   filled in correctly.
5. A single Ctrl+Z reverts the entire batch.
6. Re-running on an already-transcribed file skips transcription and returns in seconds.
7. Every failure mode — no sequence open, media not in the timeline, API unreachable, no
   editable MOGRT fields, sidecar down — is reported clearly and leaves the timeline
   untouched.
