# T-38 · Mock sidecar

| | |
|---|---|
| **Workstream** | 0 — Foundations |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | T-37 |
| **Unblocks** | T-26, T-27, T-29, T-30 — the whole panel stream |
| **Spec** | [07-sidecar-api.md §1–4](../07-sidecar-api.md) · [03-architecture.md §3](../03-architecture.md) |

## Goal

A standalone server that speaks the **real** sidecar HTTP + SSE contract but serves the golden
fixtures from T-37. It lets the entire panel be built and demoed with no Python pipeline, no
CUDA and no Premiere.

## Context you need

This is a test double, not a throwaway prototype. It stays in the repo for the life of the
project as the panel's test fixture, and **T-42** asserts it and the real sidecar satisfy the
same contract suite. Build it to be correct, not clever.

## Steps

1. `tools/mock_sidecar.py` — implement every endpoint in [07 §2](../07-sidecar-api.md):
   `/health`, `/models`, `/translations`, `POST /jobs`, `GET /jobs/{id}`,
   `GET /jobs/{id}/events` (SSE), `GET /jobs/{id}/result`, `DELETE /jobs/{id}`,
   `POST /resolve`, `POST /shutdown`.
2. Implement the **full lifecycle** from [03 §3](../03-architecture.md), not just the routes:
   ephemeral port, lock file at `%APPDATA%\VerseSync\sidecar.json`, per-launch bearer token,
   `Origin` allowlist, `X-VerseSync-Api` header. The panel's lifecycle code (T-26) is tested
   against this, so a shortcut here becomes a bug there.
3. Simulate a job realistically: run the phase sequence `hashing → transcribing → detecting →
   resolving → timing` over a configurable wall-clock duration (default ~20 s), emitting SSE
   `progress` events at the weights in [07 §4](../07-sidecar-api.md), then `done`.
4. Serve the T-37 fixture selected by a `--scenario` flag.
5. **Failure scenarios are the point** — add flags to force each one, so stream F can build the
   error surface ([09 §7](../09-ui-spec.md)) without waiting for real failures:
   `--fail model_load_failed`, `--fail provider_unavailable`, `--degraded`, `--slow`,
   `--die-mid-job`, `--drop-sse` (to exercise the polling fallback), `--cache-hit`,
   `--api-version 2.0` (to exercise the version-mismatch path).
6. Document every flag in `tools/README.md`.

## Files

- `tools/mock_sidecar.py`
- `tools/README.md`

## Done when

- [ ] `curl` against every endpoint returns responses matching [07](../07-sidecar-api.md),
      including `401` without a token.
- [ ] A simulated job streams progress and ends with a schema-valid Cue Document.
- [ ] Every `--fail` scenario reproduces on demand.
- [ ] `--drop-sse` causes the stream to close mid-job so the polling fallback can be tested.

## Traps

- Do not skip the token, the lock file or the `Origin` check because "it's only a mock" — those
  are exactly the parts of T-26 that need exercising, and they are security requirements (NFR-4).
- Progress must be *weighted* per [07 §4](../07-sidecar-api.md), not linear, or the panel's
  progress bar will be tuned against the wrong curve.
