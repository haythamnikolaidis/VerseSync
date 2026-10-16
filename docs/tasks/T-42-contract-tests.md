# T-42 · Contract tests (mock vs. real)

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | T-26.4's real-sidecar run · release |
| **Spec** | [07-sidecar-api.md](../07-sidecar-api.md) · [11-testing.md §5](../11-testing.md) |

## Goal

One test suite, run twice: once against `tools/mock_sidecar.py` and once against
`python -m versesync.sidecar`. It asserts that both satisfy the same contract, which is what
stops the fake the panel was built against from drifting away from the real thing.

## Subtasks

### T-42.1 · The suite, against the mock

**Executor** agent · **Size** S · **Prereqs** T-05.4, T-50 · **Status** done

- **Read:** [07 §1–4](../07-sidecar-api.md) · `tools/README.md` (the mock's flags and "Known
  simplifications")
- **Touches:** `tests/contract/conftest.py` (new) · `tests/contract/test_sidecar_contract.py` (new)
- **Steps:**
  1. Write a `server` fixture, parameterised over `["mock", "real"]`, that launches the process
     with `VERSESYNC_HOME=tmp_path` and `--no-lock-file` (mock) or a temp home (real). It parses
     the port from stdout and the token from the lock file or stdout. The real side is skipped
     until T-42.2. Commit.
  2. Every valid request sends `Origin: cep://com.versesync.panel` (D21). Assert **shape,
     status and ordering only, never content**:
     - every endpoint's status codes and required keys;
     - `401` with no token, with a wrong token, and with no `Origin`;
     - `X-VerseSync-Api` matches `^\d+\.\d+$`;
     - the error envelope has `code` in the [07 §3] list;
     - SSE is `progress`* then `done` for a happy job;
     - the phases are a subsequence of the canonical order;
     - progress never goes down and ends at 1.0;
     - `/result` returns `409` before done, then a schema-valid document (via
       `tools/validate_cue_document.py`);
     - `DELETE` leads to `cancelled`;
     - `GET /jobs/{id}/transcript` returns `409` before done, then a JSON array (D22, T-50).

     Run the mock with `--duration 2`, so the suite takes under 30 s. Commit.
- **Verify:** `pytest tests/contract -q -k mock`
- **Done when:**
  - [x] The suite passes against the mock.
  - [x] Deleting a required key from a response, simulated by a test-only response hook, makes
        it fail.

### T-42.2 · The suite, against the real sidecar, in CI

**Executor** agent · **Size** XS · **Prereqs** T-42.1, T-20.5 · **Status** done

- **Read:** this card · T-07's `fixture:` backend
- **Touches:** `tests/contract/conftest.py` · `.github/workflows/ci.yml`
- **Steps:**
  1. Enable the `real` parameter. Start the sidecar with a config that sets
     `transcription.backend: fixture:tests/fixtures/transcripts/numbers-and-ordinals.words.json`
     and uses the local provider. The `media_path` in requests is any existing temp file. Fix
     whichever side the **spec** says is wrong. If that's the mock, use the contract-change
     protocol. Commit.
  2. Make sure CI runs both parameters. They're already inside `pytest`, so check the run time
     stays reasonable. Commit.
- **Verify:** `pytest tests/contract -q`
- **Done when:**
  - [x] The identical suite passes against both servers, in CI.

## Traps

- Don't assert on cue *content*. The mock serves fixtures and the real sidecar serves real
  detections.
- If the real sidecar is right and the spec is wrong, don't loosen the test. Mark the task
  blocked and raise a contract task.
