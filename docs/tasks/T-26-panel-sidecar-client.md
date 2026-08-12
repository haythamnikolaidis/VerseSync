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
