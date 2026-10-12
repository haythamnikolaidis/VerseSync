# T-26 · Panel: sidecar client

| | |
|---|---|
| **Workstream** | F — Panel |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-22, T-38 |
| **Unblocks** | T-27 |
| **Spec** | [03-architecture.md §3](../03-architecture.md) · [07 §1–2](../07-sidecar-api.md) · [09 §2](../09-ui-spec.md) |

## Goal

`sidecar.js` — discover, launch, authenticate and talk to the sidecar, and survive every way it
can fail. Built entirely against the **mock sidecar** (T-38).

## Context you need

The panel owns the sidecar's lifetime, but not its lifespan: **the sidecar outlives the panel**.
Closing the panel does not kill it, reopening reattaches, and an in-flight job survives a panel
reload. Read [03 §3](../03-architecture.md) fully — the lifecycle is more subtle than "start a
process".

Risk R-9 is that this friction strands a non-technical user. Every failure needs a clear message
and a log path, never a spinner that never resolves.

## Steps

1. **Discovery:** read `%APPDATA%\VerseSync\sidecar.json`. If present and `GET /health` succeeds
   with the recorded token, attach. If `/health` fails or the PID is dead, delete the stale lock
   and launch.
2. **Launch:** `pythonw.exe -m versesync.sidecar` from the configured venv, detached, `--port 0`.
3. **Health polling** for up to **30 s** — model load can be slow on a cold start — showing
   *Starting transcription service…*.
4. **Auth:** `Authorization: Bearer <token>` on every request except `/health`.
5. **Version handshake:** compare the sidecar's `api_version`. On a **major** mismatch, offer to
   stop and relaunch it (`POST /shutdown`) rather than failing obscurely.
6. **SSE** with a **polling fallback on `GET /jobs/{id}`**. CEP panels reload; the stream will
   drop and that is normal, not an error (NFR-3).
7. Implement every status-strip state in [09 §2](../09-ui-spec.md): starting, ready, no
   sequence, unreachable (+ **Details** with the log path), degraded (CPU-only, provider
   unreachable).
8. **The insert path must keep working with the sidecar down.** An editor holding a reviewed Cue
   Document must never be blocked by a Python process ([03 §8](../03-architecture.md), FR-6.8).

## Files

- `panel/js/sidecar.js`
- `tests/js/test_sidecar.js`

## Done when

- [ ] The panel starts a sidecar cold and reaches ready.
- [ ] It reattaches to a running sidecar instead of launching a second one.
- [ ] A stale lock file (dead PID) is cleared and recovered from.
- [ ] It survives a **panel reload mid-job** and rejoins the running job.
- [ ] `--drop-sse` on the mock triggers the polling fallback transparently.
- [ ] Every failure state from [09 §2](../09-ui-spec.md) is reproducible using the mock's
      `--fail` flags and shows the specified message.
- [ ] With the sidecar stopped, loading and inserting a saved Cue Document still works.

## Traps

- Do not kill the sidecar when the panel closes. That breaks reattachment and throws away
  in-flight jobs.
- 30 s is a real number, not a placeholder — a cold CUDA model load genuinely takes that long.
  Timing out at 5 s will make the product look broken on first run.
- Treat `degraded` as usable-with-a-caveat, not as an error.

## Status

Implemented in `panel/js/sidecar.js`; tests in `tests/sidecar.test.js` (named to match the
`tests/**/*.test.js` glob that `npm test` runs). They drive the real `tools/mock_sidecar.py`
over HTTP and SSE, with a node platform standing in for CEP's process and file APIs. The
CEP-native platform (`cepPlatform`, backed by `window.cep.fs` / `window.cep.process`, no Node
flags needed in the manifest) is unit-tested against a fake `cep` object only.

- **The panel starts a sidecar cold and reaches ready.** Met against the mock ("cold start
  launches the sidecar and reaches ready"). **Deferred — needs Premiere and a real install:**
  install the panel and the sidecar venv at `%APPDATA%\VerseSync\venv`, make sure no
  `sidecar.json` exists, open the panel, and confirm the strip goes from "starting
  transcription service…" to "ready · cuda · <model>" (this exercises `cep.process.createProcess`
  launching `pythonw.exe`).
- **Reattaches to a running sidecar instead of launching a second one.** Met ("reopening the
  panel reattaches…", asserts one launch and an unchanged lock pid).
- **A stale lock file (dead PID) is cleared and recovered from.** Met (dead-pid and
  live-pid-dead-port tests).
- **Survives a panel reload mid-job and rejoins the running job.** Met ("a panel reload
  mid-job rejoins the running job"; job id persisted in storage). **Deferred — needs
  Premiere:** start an analysis, reload the panel (right-click, Reload), confirm the progress
  bar resumes.
- **`--drop-sse` triggers the polling fallback transparently.** Met ("--drop-sse switches to
  the polling fallback…").
- **Every failure state from 09 §2 is reproducible with the mock and shows the specified
  message.** Met at the view-model level: `computeStrip` is tested for starting, ready, no
  sequence, unreachable (with Details and log path), version mismatch and both degraded
  variants; `--degraded`, `--fail model_load_failed`, `--fail provider_unavailable`,
  `--die-mid-job`, `--api-version` and a never-healthy sidecar are each reproduced. **Deferred
  — needs Premiere:** rendering in the panel uses a single text line in `main.js`; the final
  strip UI and the Details/relaunch controls belong to the UI tasks.
- **With the sidecar stopped, loading and inserting a saved Cue Document still works.**
  Partially Met: `computeStrip` keeps Insert enabled whenever a sequence is open, and the
  host-stub insert runs with no sidecar client present. **Deferred — needs Premiere:** stop
  the sidecar (end `pythonw.exe` in Task Manager), reload the panel, load a saved Cue Document
  and insert it into a real sequence.

Notes: the log path (`%APPDATA%\VerseSync\logs\sidecar.log`) and venv location
(`%APPDATA%\VerseSync\venv\Scripts\pythonw.exe`) are defined as constants in `sidecar.js`
because no document pins them yet. SSE uses `fetch` streaming rather than `EventSource`, since
`EventSource` cannot send the `Authorization` header.
