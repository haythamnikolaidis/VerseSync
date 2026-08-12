# T-42 · Contract tests (mock vs. real)

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 2 |
| **Estimate** | M |
| **Prereqs** | T-20, T-38 |
| **Unblocks** | the mock-to-real swap in Wave 2 |
| **Spec** | [07-sidecar-api.md](../07-sidecar-api.md) · [11-testing.md §5](../11-testing.md) |

## Goal

One test suite, run twice — against the **mock sidecar** (T-38) and the **real sidecar**
(T-20) — asserting they satisfy the same contract. This is what stops the fake the panel was
built against from drifting away from the thing it ships against.

## Context you need

Streams B–E build the real sidecar while stream F builds the panel against the mock. They meet
in Wave 2. Without this suite, that meeting is where you discover three weeks of divergence.
See [13 §9](../13-technical-plan.md).

## Steps

1. `tests/contract/` — a suite parameterised over a base URL and token, so the same tests point
   at either server.
2. Assert the contract, not the content:
   - every endpoint's response shape and status codes ([07 §2](../07-sidecar-api.md))
   - `401` with no token and with a wrong token; `Origin` rejection
   - `X-VerseSync-Api` present and correctly formed
   - the error body shape and that every emitted `code` is in the [07 §3](../07-sidecar-api.md)
     list
   - the SSE event sequence: `progress`* then exactly one `done` or `failed`
   - phase order `hashing → transcribing → detecting → resolving → timing`, and that progress
     is monotonic and ends at 1.0
   - `GET /jobs/{id}/result` returns `409` before the job is done, then a **schema-valid** Cue
     Document (reuse T-37's validator)
   - `DELETE` produces `cancelled` status
3. Wire both runs into CI. The mock run is fast and always on; the real run may need a
   `@slow` marker and a fixture media file.
4. When the suites disagree, the **spec decides** which side is wrong — then fix that side.

## Files

- `tests/contract/test_sidecar_contract.py`
- `.github/workflows/ci.yml` (add both runs)

## Done when

- [ ] The identical suite passes against `tools/mock_sidecar.py` and against
      `python -m versesync.sidecar`.
- [ ] Removing a required field from either server's response fails the suite.
- [ ] Both runs are wired into CI.

## Traps

- Do not assert on cue *content* — the mock serves fixtures and the real sidecar serves real
  detections. Assert shape, status, ordering and schema validity only.
- If a real-sidecar behaviour turns out to be right and the spec wrong, follow the contract
  change protocol ([13 §8](../13-technical-plan.md)) — update spec, schema, fixtures and mock
  together. Do not quietly loosen the test.
