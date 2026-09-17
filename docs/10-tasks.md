# 10 — Task Backlog

**Index only.** Every task has its own self-contained file in **[`tasks/`](tasks/)** — goal,
context, steps, files, done-when criteria and traps. Open the file before starting the work.

- **Build order, workstreams and staffing:** [13-technical-plan.md](13-technical-plan.md)
- **Task file conventions:** [tasks/README.md](tasks/README.md)

Estimates: **S** ≤ half a day · **M** ~1 day · **L** 2–3 days · **XL** ~1 week.

> Task IDs **T-01…T-36** are referenced by ID from [02](02-source-project-audit.md),
> [08](08-premiere-host-api.md) and [12](12-decisions-and-risks.md). **Do not renumber them.**
> **T-37…T-42** were added later as the foundation and contract tasks — they run *first*,
> despite the higher numbers. Read the Wave column, not the number.

---

## Wave 0 — Foundations and spikes

Everything else waits on this wave and nothing else does. Keep it short.

| ID | Task | Stream | Est | Prereqs |
|----|------|--------|-----|---------|
| [T-40](tasks/T-40-repo-scaffold-and-ci.md) | Repo scaffold and CI | 0 | M | — |
| [T-37](tasks/T-37-cue-document-schema-and-fixtures.md) | Cue Document JSON Schema + golden fixtures | 0 | M | T-40 |
| [T-38](tasks/T-38-mock-sidecar.md) | Mock sidecar | 0 | M | T-37 |
| [T-39](tasks/T-39-host-stub-and-vs-fixtures.md) | Host stub + `VS.*` fixtures | 0 | M | T-40 |
| [T-41](tasks/T-41-fixture-corpus-bootstrap.md) | Fixture corpus bootstrap | 0 | L | T-40 |
| [T-01](tasks/T-01-reference-assets.md) | Obtain and verify the reference assets | 0 | S | — *(external)* |
| [T-02](tasks/T-02-spike-word-timestamps.md) | **Spike:** word-level timestamps | S | M | T-01 |
| [T-03](tasks/T-03-spike-importmgt-absolute-insert.md) | **Spike:** `importMGT` at an absolute time | S | M | T-01 |
| [T-04](tasks/T-04-spike-media-segments.md) | **Spike:** source→sequence mapping | S | M | T-01 |

The spikes gate **only** T-07's defaults, T-25 and T-24 respectively — see
[13 §3](13-technical-plan.md) for the scoped-down gate and why it changed.

## Wave 1 — Parallel build

Six streams, none depending on another in this wave.

### Stream B — Sidecar platform

| ID | Task | Est | Prereqs |
|----|------|-----|---------|
| [T-05](tasks/T-05-sidecar-scaffold.md) | Sidecar scaffold | M | T-40 |
| [T-06](tasks/T-06-upstream-qt-free-engine.md) | Upstream refactor: Qt-free engine ⚠️ *other repo* | M | — |
| [T-07](tasks/T-07-transcription-in-sidecar.md) | Transcription in the sidecar | M | T-05, T-06 |
| [T-08](tasks/T-08-content-hashing-and-transcript-cache.md) | Content hashing + transcript cache | S | T-07 |

### Stream C — Detection

| ID | Task | Est | Prereqs |
|----|------|-----|---------|
| [T-09](tasks/T-09-canon-data.md) | Canon data | S | T-40 |
| [T-10](tasks/T-10-token-normalisation.md) | Token normalisation + spoken numbers | M | T-09, T-41 |
| [T-11](tasks/T-11-book-matching.md) | Book matching | M | T-09, T-41 |
| [T-12](tasks/T-12-the-grammar.md) | The grammar | L | T-10, T-11 |
| [T-13](tasks/T-13-canon-validation-and-confidence.md) | Canon validation + confidence | M | T-12 |

### Stream D — Bible text

| ID | Task | Est | Prereqs |
|----|------|-----|---------|
| [T-14](tasks/T-14-bible-provider-interface-and-local-adapter.md) | Provider interface + local adapter | M | T-09 |
| [T-15](tasks/T-15-api-bible-adapter.md) | API.Bible adapter *(Q-A blocks final verification)* | M | T-14 |
| [T-16](tasks/T-16-verse-cache.md) | Verse cache | S | T-14, T-15 |

### Stream E — Timing

| ID | Task | Est | Prereqs |
|----|------|-----|---------|
| [T-17](tasks/T-17-read-span-alignment.md) | Read-span alignment | L | T-12, T-14, T-41 |
| [T-18](tasks/T-18-anchors-and-durations.md) | Anchors and durations | M | T-17 |
| [T-19](tasks/T-19-cue-document-assembly.md) | Cue Document assembly | S | T-18, T-37 |

### Stream F — Panel *(critical path)*

| ID | Task | Est | Prereqs |
|----|------|-----|---------|
| [T-22](tasks/T-22-panel-scaffold-and-bridge.md) | Panel scaffold + bridge | S | T-39, T-40 |
| [T-26](tasks/T-26-panel-sidecar-client.md) | Sidecar client | M | T-22, T-38 |
| [T-27](tasks/T-27-panel-setup-ui.md) | Setup UI | M | T-26, T-39 |
| [T-28](tasks/T-28-panel-time-mapping.md) | Time mapping | L | T-22, T-39 |
| [T-29](tasks/T-29-panel-review-list.md) | **Review list** | **XL** | T-27, T-28 |

### Stream G — Host (ExtendScript)

| ID | Task | Est | Prereqs |
|----|------|-----|---------|
| [T-23](tasks/T-23-host-sequence-fields-playhead.md) | Sequence info, field discovery, playhead | M | T-22 |
| [T-24](tasks/T-24-host-get-media-segments.md) | `VS.getMediaSegments` | M | **T-04**, T-23 |
| [T-25](tasks/T-25-host-insert-cues.md) | `VS.insertCues` + `VS.validateTrack` | L | **T-03**, T-23 |

## Wave 2 — Integration

| ID | Task | Stream | Est | Prereqs |
|----|------|--------|-----|---------|
| [T-20](tasks/T-20-job-orchestration-and-sse.md) | Job orchestration and SSE | B | M | T-07, T-08, T-13, T-16, T-19 |
| [T-21](tasks/T-21-cli.md) | CLI | B | S | T-20 |
| [T-42](tasks/T-42-contract-tests.md) | Contract tests (mock vs. real) | H | M | T-20, T-38 |
| [T-30](tasks/T-30-panel-insert-orchestration.md) | Insert orchestration | F | M | T-25, T-29 |

**Exit:** Journey A completes end to end on a real sermon.

## Wave 3 — Hardening

| ID | Task | Stream | Est | Prereqs |
|----|------|--------|-----|---------|
| [T-31](tasks/T-31-journey-b-rerun.md) | Journey B — the re-run | H | M | T-08, T-28, T-30 |
| [T-32](tasks/T-32-error-surface-pass.md) | Error surface pass | H | M | T-30, T-31 |
| [T-33](tasks/T-33-accuracy-harness.md) | Accuracy harness | H | L | T-21, T-41 |
| [T-34](tasks/T-34-threshold-tuning.md) | Threshold tuning | H | M | T-33 |
| [T-35](tasks/T-35-performance-pass.md) | Performance pass | H | M | T-30, T-31 |
| [T-36](tasks/T-36-install-and-documentation.md) | Install and documentation | H | M | T-30, T-35 |

**Exit:** the release gates in [11 §7](11-testing.md) and the Definition of Done in
[README.md](README.md).

---

## Dependency summary

```
WAVE 0
  T-40 ─┬─► T-37 ──► T-38 ──────────────► stream F
        ├─► T-39 ────────────────────────► stream F
        └─► T-41 ────────────────────────► streams C, E, H
  T-01 ─┬─► T-02 ····(defaults)····► T-07
        ├─► T-03 ═══(gate)═════════► T-25
        └─► T-04 ═══(gate)═════════► T-24

WAVE 1                                            WAVE 2            WAVE 3
  B:  T-05 ──► T-07 ──► T-08 ──┐
  C:  T-09 ─┬► T-10 ─┬► T-12 ─► T-13 ─┤
            └► T-11 ─┘                ├──► T-20 ──► T-21 ──► T-33 ──► T-34
  D:  T-14 ──► T-15 ──► T-16 ─────────┤             │
  E:  T-17 ──► T-18 ──► T-19 ─────────┘             └──► T-42
  F:  T-22 ─┬► T-26 ──► T-27 ─┬► T-29 ─┐
            └► T-28 ──────────┘        ├──► T-30 ──► T-31 ──► T-32
  G:  T-23 ─┬► T-24 ─────────────────  │              └──► T-35 ──► T-36
            └► T-25 ───────────────────┘
```

**Critical path:** `T-40 → T-39 → T-22 → T-28 → T-29 → T-30 → T-31`. Protect stream F's start
date above everything else.
