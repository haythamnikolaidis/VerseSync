# 10 — Task Backlog

**Index only.** Every task's card lives in an epic file in **[`tasks/`](tasks/)**: one file per
original task ID, with that epic's atomic subtasks inside it. The card holds the goal, what to
read, which files it touches, the steps, how to verify, and the done-when checklist.

- **Agents start here:** [tasks/AGENT.md](tasks/AGENT.md), the operating protocol. Then run
  `python tools/plan.py next`.
- **Why the plan looks like this:** [13-technical-plan.md §11](13-technical-plan.md#11-autonomous-agent-execution).
- **Card conventions:** [tasks/README.md](tasks/README.md).

**Sizes (agent tasks):** **XS** is under ~100 changed lines including tests · **S** is
~100–300 · nothing larger. Every agent task is meant to fit comfortably in one session, and each
of its Steps in a fraction of one.

> **IDs.** T-01…T-42 are referenced by ID from [02](02-source-project-audit.md),
> [08](08-premiere-host-api.md) and [12](12-decisions-and-risks.md), so **don't renumber them.**
> When a task was too big to be atomic, its ID became an **epic** with subtasks `T-NN.1`,
> `T-NN.2` and so on. A subtask `T-NN.H` is the **human** verification for that epic.
> T-43…T-50 were added by the agent-execution rework. A prereq that names an epic means "every
> subtask of that epic".

---

## Execution queue

The order an agent works in. `plan.py next` picks the **first** agent row whose prereqs are all
`done`. The order is a topological sort of the dependency graph, grouped into phases, so every
row comes after all of its prereqs. **Human** rows are listed where they become possible; agents
skip them. `python tools/plan.py validate` checks this table against the cards.

| # | ID | Task | Executor | Size | Prereqs | Phase |
|---|----|------|----------|------|---------|-------|
| 1 | [T-46](tasks/T-46-agent-environment.md) | Agent environment bootstrap | agent | XS | — | 0 |
| 2 | [T-43](tasks/T-43-vendor-verseflow-reference.md) | Vendor VerseFlow reference sources | agent | XS | — | 0 |
| 3 | [T-44](tasks/T-44-vendor-transcriber-reference.md) | Vendor Faster-Whisper-Transcriber reference sources | agent | XS | T-43 | 0 |
| 4 | [T-47](tasks/T-47-contract-sequence-identity.md) | Contract: host API 1.1, sequence identity (R-13) | agent | S | — | 0 |
| 5 | [T-50](tasks/T-50-contract-transcript-endpoint.md) | Contract: transcript retrieval (`words_ref`) | agent | S | — | 0 |
| 6 | [T-45.1](tasks/T-45-fake-premiere-dom.md) | JSX loader, sequence/track/clip model | agent | S | T-43 | 0 |
| 7 | [T-45.2](tasks/T-45-fake-premiere-dom.md) | `importMGT`, MGT components, undo groups, CSXS events | agent | S | T-45.1 | 0 |
| 8 | [T-09.1](tasks/T-09-canon-data.md) | Bundle the public-domain KJV text | agent | S | — | 1 |
| 9 | [T-09.2](tasks/T-09-canon-data.md) | Generate `canon.json` | agent | S | T-09.1 | 1 |
| 10 | [T-09.3](tasks/T-09-canon-data.md) | `Canon` loader and shared core types | agent | S | T-09.2 | 1 |
| 11 | [T-10.1](tasks/T-10-token-normalisation.md) | Spoken-number and ordinal parser | agent | S | T-09.3 | 1 |
| 12 | [T-10.2](tasks/T-10-token-normalisation.md) | `Token` and the normalisation pass | agent | S | T-10.1 | 1 |
| 13 | [T-10.3](tasks/T-10-token-normalisation.md) | Search string, offset map and span round-trip | agent | S | T-10.2 | 1 |
| 14 | [T-11.1](tasks/T-11-book-matching.md) | Tier 1: exact and alias matching with ordinal prefixes | agent | S | T-10.3 | 1 |
| 15 | [T-11.2](tasks/T-11-book-matching.md) | Tier 2: curated ASR-confusion table | agent | XS | T-11.1 | 1 |
| 16 | [T-11.3](tasks/T-11-book-matching.md) | Tier 3: fuzzy matching and the short-name restriction | agent | S | T-11.2 | 1 |
| 17 | [T-12.1](tasks/T-12-the-grammar.md) | Pre-pass, grammar view, framework and P1/P2/P9 | agent | S | T-11.3 | 1 |
| 18 | [T-12.2](tasks/T-12-the-grammar.md) | P3–P8: keyword and comma forms | agent | S | T-12.1 | 1 |
| 19 | [T-12.3](tasks/T-12-the-grammar.md) | P10, and P11/P12 context carry | agent | S | T-12.2 | 1 |
| 20 | [T-12.4](tasks/T-12-the-grammar.md) | Psalms concatenation, chapter-only, and the bootstrap corpus check | agent | S | T-12.3 | 1 |
| 21 | [T-13.1](tasks/T-13-canon-validation-and-confidence.md) | Canon validation rules | agent | S | T-12.4 | 1 |
| 22 | [T-13.2](tasks/T-13-canon-validation-and-confidence.md) | Confidence scoring | agent | XS | T-13.1 | 1 |
| 23 | [T-13.3](tasks/T-13-canon-validation-and-confidence.md) | Duplicate suppression, snippets and `detect()` | agent | S | T-13.2 | 1 |
| 24 | [T-14.1](tasks/T-14-bible-provider-interface-and-local-adapter.md) | Types, protocol and error taxonomy | agent | XS | T-09.3 | 1 |
| 25 | [T-14.2](tasks/T-14-bible-provider-interface-and-local-adapter.md) | `format.py` and the VerseFlow round-trip test | agent | S | T-14.1, T-43 | 1 |
| 26 | [T-14.3](tasks/T-14-bible-provider-interface-and-local-adapter.md) | `local.py` over the bundled KJV | agent | S | T-14.2 | 1 |
| 27 | [T-05.1](tasks/T-05-sidecar-scaffold.md) | `paths.py` and `config.py` | agent | S | T-44 | 1 |
| 28 | [T-16](tasks/T-16-verse-cache.md) | Verse cache | agent | S | T-14.3, T-05.1 | 1 |
| 29 | [T-48.1](tasks/T-48-resolver.md) | `parse_reference()` for editor-typed references | agent | XS | T-13.3 | 1 |
| 30 | [T-48.2](tasks/T-48-resolver.md) | `resolve_detections()` | agent | S | T-48.1, T-16 | 1 |
| 31 | [T-17.1](tasks/T-17-read-span-alignment.md) | Alignment normalisation, window and token equality | agent | XS | T-14.3, T-13.3 | 1 |
| 32 | [T-17.2](tasks/T-17-read-span-alignment.md) | Greedy aligner, multi-start, classification | agent | S | T-17.1 | 1 |
| 33 | [T-17.3](tasks/T-17-read-span-alignment.md) | Calibration against the bootstrap corpus | agent | S | T-17.2 | 1 |
| 34 | [T-18](tasks/T-18-anchors-and-durations.md) | Anchors and durations | agent | S | T-17.2, T-43 | 1 |
| 35 | [T-19.1](tasks/T-19-cue-document-assembly.md) | Cue builder | agent | S | T-18, T-48.2 | 1 |
| 36 | [T-19.2](tasks/T-19-cue-document-assembly.md) | Document assembly, sibling transcript, validation in the code path | agent | S | T-19.1 | 1 |
| 37 | [T-19.3](tasks/T-19-cue-document-assembly.md) | `run_pipeline()`: words to Cue Document, offline | agent | S | T-19.2 | 1 |
| 38 | [T-05.2](tasks/T-05-sidecar-scaffold.md) | Lock file | agent | S | T-05.1 | 2 |
| 39 | [T-05.3](tasks/T-05-sidecar-scaffold.md) | HTTP server core: bind, auth, Origin, headers, errors, `/health`, `/shutdown` | agent | S | T-05.2 | 2 |
| 40 | [T-05.4](tasks/T-05-sidecar-scaffold.md) | Entry point, logging, idle self-exit | agent | S | T-05.3 | 2 |
| 41 | [T-07.1](tasks/T-07-transcription-in-sidecar.md) | `transcribe.py`: options, backend protocol, fixture and fake backends | agent | S | T-05.1, T-09.3 | 2 |
| 42 | [T-08](tasks/T-08-content-hashing-and-transcript-cache.md) | Content hashing and transcript cache | agent | S | T-07.1 | 2 |
| 43 | [T-20.1](tasks/T-20-job-orchestration-and-sse.md) | Progress accounting and the job registry | agent | S | T-05.4 | 2 |
| 44 | [T-20.2](tasks/T-20-job-orchestration-and-sse.md) | Job runner | agent | S | T-20.1, T-08, T-19.3, T-16 | 2 |
| 45 | [T-20.3](tasks/T-20-job-orchestration-and-sse.md) | Job endpoints | agent | S | T-20.2, T-50 | 2 |
| 46 | [T-20.4](tasks/T-20-job-orchestration-and-sse.md) | SSE endpoint | agent | S | T-20.3 | 2 |
| 47 | [T-20.5](tasks/T-20-job-orchestration-and-sse.md) | `/models`, `/translations`, `/resolve`, and `/health` status | agent | S | T-20.3, T-48.1 | 2 |
| 48 | [T-21.1](tasks/T-21-cli.md) | `detect`, `resolve` and `analyse` commands | agent | S | T-20.2, T-48.1 | 2 |
| 49 | [T-21.2](tasks/T-21-cli.md) | CLI and HTTP parity test | agent | XS | T-21.1, T-20.4 | 2 |
| 50 | [T-42.1](tasks/T-42-contract-tests.md) | The suite, against the mock | agent | S | T-05.4, T-50 | 2 |
| 51 | [T-42.2](tasks/T-42-contract-tests.md) | The suite, against the real sidecar, in CI | agent | XS | T-42.1, T-20.5 | 2 |
| 52 | [T-15.1](tasks/T-15-api-bible-adapter.md) | Client, response parsing, translations | agent | S | T-14.3 | 2 |
| 53 | [T-15.2](tasks/T-15-api-bible-adapter.md) | Batching, retry and error mapping | agent | S | T-15.1 | 2 |
| 54 | [T-15.H](tasks/T-15-api-bible-adapter.md) | Real key, real translations (Q-A) | **human** | — | T-15.2 | 2 |
| 55 | [T-06.1](tasks/T-06-upstream-qt-free-engine.md) | Extract `core/transcription/engine.py` | agent | S | T-44 | 2 |
| 56 | [T-06.2](tasks/T-06-upstream-qt-free-engine.md) | Route `TranscriptionService` through the engine; delete dead code | agent | S | T-06.1 | 2 |
| 57 | [T-07.2](tasks/T-07-transcription-in-sidecar.md) | faster-whisper adapter via the upstream engine | agent | S | T-07.1, T-06.2 | 2 |
| 58 | [T-07.H](tasks/T-07-transcription-in-sidecar.md) | GPU workstation verification | **human** | — | T-07.2 | 2 |
| 59 | [T-06.H](tasks/T-06-upstream-qt-free-engine.md) | Upstream GUI parity check | **human** | — | T-06.2 | 2 |
| 60 | [T-23.1](tasks/T-23-host-sequence-fields-playhead.md) | `VerseSync.jsx` skeleton, ES3 lint, `ping`, `getSequenceInfo`, `setPlayhead` | agent | S | T-45.1, T-47 | 3 |
| 61 | [T-23.2](tasks/T-23-host-sequence-fields-playhead.md) | `VS.getMogrtFields` (ported unchanged) | agent | S | T-23.1, T-45.2 | 3 |
| 62 | [T-24](tasks/T-24-host-get-media-segments.md) | Host: `VS.getMediaSegments` | agent | S | T-23.1 | 3 |
| 63 | [T-25.1](tasks/T-25-host-insert-cues.md) | `insertCues` input validation (everything before the undo group) | agent | S | T-23.2 | 3 |
| 64 | [T-25.2](tasks/T-25-host-insert-cues.md) | `insertCues` placement loop | agent | S | T-25.1 | 3 |
| 65 | [T-25.3](tasks/T-25-host-insert-cues.md) | `VS.validateTrack` | agent | XS | T-25.1 | 3 |
| 66 | [T-22.1](tasks/T-22-panel-scaffold-and-bridge.md) | Panel skeleton: manifest, debug file, `index.html`, CSS, `main.js`, jsdom | agent | S | T-43 | 4 |
| 67 | [T-22.2](tasks/T-22-panel-scaffold-and-bridge.md) | `bridge.js` port | agent | S | T-22.1 | 4 |
| 68 | [T-22.H](tasks/T-22-panel-scaffold-and-bridge.md) | Panel loads in Premiere | **human** | — | T-22.2, T-23.1 | 4 |
| 69 | [T-25.H](tasks/T-25-host-insert-cues.md) | Host verification on real Premiere (covers T-23, T-24, T-25 and D20) | **human** | — | T-25.2, T-25.3, T-24, T-22.H | 3 |
| 70 | [T-26.1](tasks/T-26-panel-sidecar-client.md) | Node transport and client core | agent | S | T-22.1 | 4 |
| 71 | [T-26.2](tasks/T-26-panel-sidecar-client.md) | Discovery, launch, health polling, lifecycle states | agent | S | T-26.1 | 4 |
| 72 | [T-26.3](tasks/T-26-panel-sidecar-client.md) | Job watcher: SSE, polling fallback, rejoin after reload | agent | S | T-26.2 | 4 |
| 73 | [T-26.4](tasks/T-26-panel-sidecar-client.md) | Integration against the real mock process | agent | S | T-26.3 | 4 |
| 74 | [T-49](tasks/T-49-panel-smoke-harness.md) | Panel smoke harness (headless Chromium) | agent | S | T-22.2, T-26.1 | 4 |
| 75 | [T-27.1](tasks/T-27-panel-setup-ui.md) | `state.js`: persistence, smart defaults, Analyse blockers | agent | S | T-22.2 | 4 |
| 76 | [T-27.2](tasks/T-27-panel-setup-ui.md) | Setup view (part 1): media, template, field mapping | agent | S | T-27.1 | 4 |
| 77 | [T-27.3](tasks/T-27-panel-setup-ui.md) | Setup view (part 2): translation, track, duration, lead-in, Analyse | agent | S | T-27.2, T-26.1 | 4 |
| 78 | [T-27.4](tasks/T-27-panel-setup-ui.md) | Status strip and progress view | agent | S | T-27.3, T-26.3, T-49 | 4 |
| 79 | [T-28.1](tasks/T-28-panel-time-mapping.md) | Tick helpers, snapping, timecode, `duration.js` port | agent | S | T-22.1 | 4 |
| 80 | [T-28.2](tasks/T-28-panel-time-mapping.md) | Segment map: source→sequence, inverse, flags | agent | S | T-28.1, T-47 | 4 |
| 81 | [T-28.3](tasks/T-28-panel-time-mapping.md) | Overlap sweep | agent | XS | T-28.2 | 4 |
| 82 | [T-28.4](tasks/T-28-panel-time-mapping.md) | `mapCueDocument`, manual offset, worked example | agent | S | T-28.3 | 4 |
| 83 | [T-29.1](tasks/T-29-panel-review-list.md) | `cues.js` model | agent | S | T-22.1 | 4 |
| 84 | [T-29.2](tasks/T-29-panel-review-list.md) | Save, load, and VerseFlow `.txt` export | agent | XS | T-29.1, T-43 | 4 |
| 85 | [T-29.3](tasks/T-29-panel-review-list.md) | Collapsed rows | agent | S | T-29.1, T-28.4 | 4 |
| 86 | [T-29.4](tasks/T-29-panel-review-list.md) | The Analyse → review flow (makes the screen demoable) | agent | S | T-29.3, T-27.4 | 4 |
| 87 | [T-29.5](tasks/T-29-panel-review-list.md) | List header and actions | agent | S | T-29.4, T-29.2 | 4 |
| 88 | [T-29.6](tasks/T-29-panel-review-list.md) | Expanded row (read-only parts) | agent | S | T-29.5, T-50 | 4 |
| 89 | [T-29.7](tasks/T-29-panel-review-list.md) | Reference editing and re-resolve | agent | S | T-29.6 | 4 |
| 90 | [T-29.8](tasks/T-29-panel-review-list.md) | Timing edits: nudges, set-to-playhead, duration override | agent | S | T-29.6 | 4 |
| 91 | [T-29.9](tasks/T-29-panel-review-list.md) | Add cue, placement alternatives, empty and edge states | agent | S | T-29.7, T-29.8 | 4 |
| 92 | [T-30.1](tasks/T-30-panel-insert-orchestration.md) | Pre-insert validation, payload, overwrite confirmation | agent | S | T-29.5, T-25.1 | 4 |
| 93 | [T-30.2](tasks/T-30-panel-insert-orchestration.md) | Insert execution, progress, summary, partial re-run | agent | S | T-30.1, T-25.2, T-25.3 | 4 |
| 94 | [T-30.H](tasks/T-30-panel-insert-orchestration.md) | Journey A on a real workstation | **human** | — | T-30.2, T-25.H, T-07.H, T-20.5 | 4 |
| 95 | [T-31.1](tasks/T-31-journey-b-rerun.md) | Recut scenarios, automated | agent | S | T-30.2, T-20.4 | 5 |
| 96 | [T-31.H](tasks/T-31-journey-b-rerun.md) | Journey B on a real workstation | **human** | — | T-31.1, T-30.H | 5 |
| 97 | [T-32.1](tasks/T-32-error-surface-pass.md) | Sidecar error catalogue | agent | S | T-20.5 | 5 |
| 98 | [T-32.2](tasks/T-32-error-surface-pass.md) | Panel failure states and never-settling promises | agent | S | T-32.1, T-30.2 | 5 |
| 99 | [T-32.H](tasks/T-32-error-surface-pass.md) | Manual failure-mode pass | **human** | — | T-32.2, T-30.H | 5 |
| 100 | [T-33.1](tasks/T-33-accuracy-harness.md) | Golden-file tests | agent | S | T-21.1 | 5 |
| 101 | [T-35.1](tasks/T-35-performance-pass.md) | Container-measurable budgets as tests | agent | S | T-30.2, T-21.1 | 5 |
| 102 | [T-35.H](tasks/T-35-performance-pass.md) | Reference workstation numbers | **human** | — | T-35.1, T-30.H | 5 |
| 103 | [T-36.1](tasks/T-36-install-and-documentation.md) | Sidecar installer | agent | S | T-07.2, T-44 | 5 |
| 104 | [T-36.2](tasks/T-36-install-and-documentation.md) | Panel installer | agent | XS | T-22.1 | 5 |
| 105 | [T-36.3](tasks/T-36-install-and-documentation.md) | README and INSTALL | agent | S | T-36.1, T-36.2, T-35.1, T-32.1 | 5 |
| 106 | [T-36.H](tasks/T-36-install-and-documentation.md) | Clean-machine install | **human** | — | T-36.3, T-35.H | 5 |
| 107 | [T-51.1](tasks/T-51-scripture-file-import.md) | Scripture file: export parser | agent | S | T-14.2, T-13.1 | 6 |
| 108 | [T-51.2](tasks/T-51-scripture-file-import.md) | Contract: Cue Document 1.1 | agent | S | T-51.1 | 6 |
| 109 | [T-51.3](tasks/T-51-scripture-file-import.md) | Entry locator | agent | S | T-51.1, T-17.2, T-13.3 | 6 |
| 110 | [T-51.4](tasks/T-51-scripture-file-import.md) | Pipeline integration | agent | S | T-51.2, T-51.3, T-19.3 | 6 |
| 111 | [T-51.5](tasks/T-51-scripture-file-import.md) | API and CLI | agent | XS | T-51.4 | 6 |
| 112 | [T-51.6](tasks/T-51-scripture-file-import.md) | Panel: picker and review list | agent | S | T-51.5, T-29.3 | 6 |
| 113 | [T-51.H](tasks/T-51-scripture-file-import.md) | Real sermon with its export | **human** | — | T-51.6 | 6 |
| 114 | [T-52.1](tasks/T-52-media-from-sequence.md) | Host: `VS.listSequenceMedia` | agent | S | T-24 | 7 |
| 115 | [T-52.2](tasks/T-52-media-from-sequence.md) | Panel: the Media dropdown | agent | S | T-52.1, T-27.1 | 7 |
| 116 | [T-52.H](tasks/T-52-media-from-sequence.md) | Media dropdown on the real sermon project | **human** | — | T-52.2 | 7 |

**Phases.**

| Phase | Covers |
|-------|--------|
| **0** | Agent enablement: reference sources vendored, a fake Premiere DOM, the environment bootstrap, and two contract fixes (D20, D22). |
| **1** | The whole detection → resolution → timing → Cue Document pipeline, run offline from fixture word arrays. Ends with `run_pipeline()`. |
| **2** | The HTTP sidecar around that pipeline, the CLI, contract tests against the mock, the API.Bible adapter, and the transcription backends. |
| **3** | `VerseSync.jsx`, tested under Node against the fake DOM. |
| **4** | The CEP panel, built against the mock sidecar and the host stub, and finally integrated with the real `VerseSync.jsx` on the fake DOM. |
| **5** | Journey B, error surfaces, golden files, performance budgets, installers and documentation. |
| **6** | Scripture file import (D26): the EasyWorship export as the first source of cues and verse text. See [14](14-scripture-file-import.md). |
| **7** | Post-v1 improvements raised during human verification: picking the media from the sequence (raised in Journey A, step 30). |

## Human tasks

These need Premiere, Windows, a GPU, real sermon media, an API key, or a person's judgement.
They verify agent work on real hardware, and **together they are the release gate**
([11 §7](11-testing.md)). `python tools/plan.py next --human` lists the ones that are ready.

| ID | What | Gates |
|----|------|-------|
| [T-06.H](tasks/T-06-upstream-qt-free-engine.md) | Upstream GUI parity, then merge the upstream PR | release |
| [T-07.H](tasks/T-07-transcription-in-sidecar.md) | GPU transcription: determinism, cancellation, OOM message | release |
| [T-15.H](tasks/T-15-api-bible-adapter.md) | **Q-A**: licensed translations, real API key, recorded fixtures | release |
| [T-22.H](tasks/T-22-panel-scaffold-and-bridge.md) | The panel loads in Premiere, and Node `http` works there (D21) | T-25.H |
| [T-25.H](tasks/T-25-host-insert-cues.md) | Every `VS.*` call on real Premiere, including D20's `sequenceID` stability | T-30.H |
| [T-30.H](tasks/T-30-panel-insert-orchestration.md) | **Journey A** end to end on a real sermon, plus the five-count **accuracy spot-check** (D24) | release |
| [T-31.H](tasks/T-31-journey-b-rerun.md) | **Journey B** on a real recut | release |
| [T-32.H](tasks/T-32-error-surface-pass.md) | Failure modes on real Premiere | release |
| [T-35.H](tasks/T-35-performance-pass.md) | NFR-2 numbers on the reference workstation | release |
| [T-36.H](tasks/T-36-install-and-documentation.md) | Clean-machine install from the README | release |

## Deferred past v1 (D24, 2026-10-15)

Not built in v1. Stakeholders accepted the detection-accuracy risk, paraphrased scripture
especially, rather than wait for a labelled corpus. `plan.py` never offers these tasks, and no
active task depends on them. See [12](12-decisions-and-risks.md) D24 and
[13 §11.5](13-technical-plan.md).

| ID | Task | Why deferred |
|----|------|--------------|
| [T-33.2](tasks/T-33-accuracy-harness.md) | `accuracy_harness.py`: M1, M2, M3, plus diff mode | There's no corpus to measure against. |
| [T-33.H](tasks/T-33-accuracy-harness.md) | Build the full labelled corpus (≥ 10 sermons, ≥ 300 utterances) | No annotator capacity. |
| [T-34.1](tasks/T-34-threshold-tuning.md) | Sweep tooling and report | Needs the corpus. |
| [T-34.2](tasks/T-34-threshold-tuning.md) | Apply tuned constants | Needs the corpus. v1 ships the spec defaults. |

To reinstate them, set their status back to `todo`, add them to the queue after T-33.1, and run
`python tools/plan.py validate`.

## Done: Wave 0 (2026-10-11)

| ID | Task |
|----|------|
| [T-40](tasks/T-40-repo-scaffold-and-ci.md) | Repo scaffold and CI |
| [T-37](tasks/T-37-cue-document-schema-and-fixtures.md) | Cue Document JSON Schema and golden fixtures |
| [T-38](tasks/T-38-mock-sidecar.md) | Mock sidecar |
| [T-39](tasks/T-39-host-stub-and-vs-fixtures.md) | Host stub and `VS.*` fixtures |
| [T-41](tasks/T-41-fixture-corpus-bootstrap.md) | Fixture corpus bootstrap |
| [T-01](tasks/T-01-reference-assets.md) | Reference assets |
| [T-02](tasks/T-02-spike-word-timestamps.md) | Spike: word timestamps (the gate tripped, resolved as D19) |
| [T-03](tasks/T-03-spike-importmgt-absolute-insert.md) | Spike: `importMGT` overwrite (confirmed) |
| [T-04](tasks/T-04-spike-media-segments.md) | Spike: media segments |

## Dependency overview

```
PHASE 0   T-46  T-43 ─► T-44     T-47 (D20)   T-50 (D22)     T-43 ─► T-45.1 ─► T-45.2
             │
PHASE 1   T-09.1 ─► T-09.2 ─► T-09.3 ─► T-10.* ─► T-11.* ─► T-12.* ─► T-13.* ─┐
                                   └─► T-14.* ─────────────────────────────────┼─► T-48.* ─┐
          T-44 ─► T-05.1 ─► T-16 ──────────────────────────────────────────────┘           │
                                         T-13.3 + T-14.3 ─► T-17.* ─► T-18 ─► T-19.1 ◄─────┘
                                                                              └─► T-19.2 ─► T-19.3
PHASE 2   T-05.1 ─► T-05.2 ─► T-05.3 ─► T-05.4 ─► T-20.1 ─► T-20.2 ─► T-20.3 ─► T-20.4 ─► T-20.5
          T-07.1 ─► T-08 ─────────────────────────────┘        T-21.*  T-42.*  T-15.*  T-06.* ─► T-07.2
PHASE 3   T-45 + T-47 ─► T-23.1 ─► T-23.2 ─► T-25.1 ─► T-25.2 / T-25.3        T-23.1 ─► T-24
PHASE 4   T-22.1 ─► T-22.2 ─► T-26.* ─► T-49 ─► T-27.* ─┐
          T-22.1 ─► T-28.* ─────────────────────────────┼─► T-29.1 … T-29.9 ─► T-30.1 ─► T-30.2
                                     T-25.* ────────────────────────────────────────────┘
PHASE 5   T-31.1  T-32.*  T-33.1 (golden files)  T-35.1  T-36.*
```
