# T-21 · CLI

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Unblocks** | T-33 |
| **Spec** | [07-sidecar-api.md §6](../07-sidecar-api.md) |

## Goal

Run the pipeline from a terminal, with no HTTP and no Premiere. This is how detection gets
iterated on, how the accuracy harness runs, and how support issues get reproduced (NFR-5).

## Subtasks

### T-21.1 · `detect`, `resolve` and `analyse` commands

**Executor** agent · **Size** S · **Prereqs** T-20.2, T-48.1 · **Status** done

- **Read:** [07 §6](../07-sidecar-api.md)
- **Touches:** `sidecar/versesync/cli.py` (new) · `cli/versesync_cli.py` (a shim calling
  `versesync.cli.main`) · `tests/test_cli.py` (new)
- **Commands:**
  ```
  python -m versesync.cli detect  <words.json> [--out detections.json]          # JSON list of Detection.to_json()
  python -m versesync.cli resolve "<reference>" [--translation kjv]             # Passage.to_json() to stdout
  python -m versesync.cli analyse <media|words.json> [--translation kjv] --out cues.json
        [--config cfg.yaml] [--job-id ID] [--generated-at ISO]
  ```
  `analyse` with a `.words.json` input skips transcription and uses the same job metadata
  defaults the `fixture:` backend uses. `--job-id` and `--generated-at` make the output
  deterministic for tests.
- **Steps:**
  1. Write `detect` and `resolve` by calling `detect()` and `parse_reference` + `LocalProvider`.
     Exit codes: 0 for OK, 2 for bad input (with the editor message on stderr), 1 for internal
     errors. Commit.
  2. Write `analyse` as a thin wrapper over the **same** job phases (`hash_media`, the backend,
     `run_pipeline`) by calling the T-20.2 functions directly. There must be **no pipeline
     logic in `cli.py`**. Commit.
  3. Tests: `detect` on a fixture produces JSON; `resolve "Jude 5:1"` exits 2 with the message;
     `analyse` on a fixture `.words.json` produces a schema-valid document. Commit.
- **Verify:** `pytest tests/test_cli.py -q`
- **Done when:**
  - [x] All three commands work as documented, with no GPU.

### T-21.2 · CLI and HTTP parity test

**Executor** agent · **Size** XS · **Prereqs** T-21.1, T-20.4 · **Status** in-progress

- **Read:** [07 §6](../07-sidecar-api.md) (the last paragraph)
- **Touches:** `tests/test_cli_parity.py` (new)
- **Steps:**
  1. For one T-41 fixture, run `analyse` through the CLI, and run a job over HTTP with the
     `fixture:` backend, using the same job id and `generated_at` (injected into both). Compare
     the two Cue Documents for equality, ignoring `job.media_path`. Commit.
- **Verify:** `pytest tests/test_cli_parity.py -q`
- **Done when:**
  - [ ] The documents are identical.

## Traps

- If you find yourself writing pipeline logic in `cli.py`, stop. It belongs in
  `sidecar/versesync/`, where both entry points call it.
