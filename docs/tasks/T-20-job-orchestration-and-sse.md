# T-20 · Job orchestration and SSE

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 2 |
| **Estimate** | M |
| **Prereqs** | T-07, T-08, T-13, T-16, T-19 |
| **Unblocks** | T-21, T-42 |
| **Spec** | [07-sidecar-api.md §2–4](../07-sidecar-api.md) |

## Goal

Join the five pipeline stages into one job, served over the HTTP + SSE contract with live
progress and clean cancellation. **This is the first task where the sidecar becomes a whole.**

## Context you need

Everything upstream has been built and unit-tested in isolation against fixtures. This task
wires them together and puts them behind the API the panel has been talking to (via the mock)
since Wave 0. Expect the seams to reveal mismatches — finding them is this task's job, and
**T-42** is what proves they are gone.

## Steps

1. `jobs.py` — job registry with lifecycle `queued | running | done | failed | cancelled`, and
   cooperative cancellation propagated into transcription.
2. Run the pipeline in phase order:
   `hashing → transcribing → detecting → resolving → timing`. On a cache hit, skip
   `transcribing`.
3. Implement weighted progress per [07 §4](../07-sidecar-api.md) — hashing 0.02, transcribing
   0.80, detecting 0.05, resolving 0.10, timing 0.03 — **renormalising** the remaining weights
   on a cache hit so the bar still ends at 1.0.
4. Implement the endpoints: `POST /jobs` (→ `202` with `job_id`, `cache_hit`,
   `estimated_duration_s`), `GET /jobs/{id}`, `GET /jobs/{id}/events` (SSE),
   `GET /jobs/{id}/result` (`409` unless done), `DELETE /jobs/{id}`, `POST /resolve`.
5. SSE: emit on every phase change and **at most twice a second** within a phase. Terminate with
   exactly one `done` or `failed` event.
6. `POST /resolve` — resolve a single reference on demand, for FR-6.3/FR-6.4. Accepts a string
   or a canonical object; the string form is parsed with the **same canon table detection
   uses**, so what an editor types is validated the same way.
7. Implement the full error taxonomy from [07 §3](../07-sidecar-api.md), with
   editor-readable `message` and an actionable `hint`.
8. Validate `media_path` against the session's allowed roots (NFR-4).

## Files

- `sidecar/versesync/jobs.py`, `sidecar/versesync/server.py` (extended)
- `tests/test_jobs.py`

## Done when

- [ ] A full job runs end to end over HTTP with live progress and produces a schema-valid Cue
      Document.
- [ ] Cancellation takes effect within ~5 s and reports `cancelled`.
- [ ] A cache-hit job races through the bar and still ends at exactly 1.0.
- [ ] `GET /result` returns `409` before completion.
- [ ] A provider outage still produces a **successful** job with flagged cues (FR-4.5).
- [ ] The panel, repointed from the mock to this, behaves identically.

## Traps

- Progress must be monotonic. A phase transition that briefly reduces the total is the most
  common bug here and looks broken to an editor.
- A provider failure is **not** a job failure. Only `TranslationNotLicensed` fails the job, and
  it fails fast at job start.
- The SSE stream will drop — CEP panels reload. The panel handles that (T-26), but do not
  assume a live client, and do not lose job state when the stream closes.
