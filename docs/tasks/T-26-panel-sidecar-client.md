# T-26 · Panel: sidecar client

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | T-27, T-29.4, T-49 |
| **Spec** | [03-architecture.md §3](../03-architecture.md) · [07 §1–3](../07-sidecar-api.md) · [09 §2](../09-ui-spec.md) |

## Goal

`sidecar.js` discovers, launches, authenticates and talks to the sidecar, and survives every way
it can fail. It's built and tested against the **mock sidecar** (`tools/mock_sidecar.py`).

## Context

The sidecar **outlives the panel**. Closing the panel doesn't kill it, reopening the panel
reattaches to it, and a job that's running survives a panel reload. Risk R-9 is that this
friction strands a non-technical user, so every failure needs a clear message and a log path.
A spinner that never resolves is not acceptable.

**Transport (D21):** Node's `http` module, with the `Origin` header set explicitly to
`cep://com.versesync.panel`. Browser pages can't forge `Origin`, so the allowlist still protects
the sidecar. The real sidecar's default `allowed_origins` is `["cep://com.versesync.panel"]`
(set by T-05.1). The mock accepts any non-empty origin.

```javascript
// transport interface (Node http adapter here; the stub adapter is T-49)
transport.request({ method, port, path, headers, body }) -> Promise<{ status, headers, json }>   // never rejects; network error → status 0
transport.stream({ port, path, headers }, onEvent(eventName, dataObj), onEnd(reason)) -> { close() }
// client
VSSidecarClient.create({ transport, port, token }) -> client
client.health() / models() / translations() / startJob(req) / job(id) / result(id) / transcript(id)
      / cancel(id) / resolve(refOrObj, translationId) / shutdown()
   -> Promise<{ ok:true, data } | { ok:false, error:{ code, message, hint, status } }>    // never rejects
```

## Subtasks

### T-26.1 · Node transport and client core

**Executor** agent · **Size** S · **Prereqs** T-22.1 · **Status** done

- **Read:** [07 §1.2, §1.3, §2, §3](../07-sidecar-api.md)
- **Touches:** `panel/js/sidecar.js` (new) · `tests/panel/sidecar-client.test.js` (new)
- **Steps:**
  1. Write `createNodeTransport(http)` (UMD, injected `http`) with SSE parsing in `stream()`:
     lines are `event:` and `data:`, with a blank line ending each event. Write
     `VSSidecarClient`:
     - it adds the bearer token and the `Origin` header to every request except `/health`;
     - a non-2xx envelope becomes `{ok:false, error}`;
     - a status-0 network error becomes `{ok:false, error:{code:'unreachable'}}`;
     - an `X-VerseSync-Api` major version other than 1 becomes `code:'api_version_mismatch'`.

     Commit.
  2. Tests use a throwaway Node `http` server written inside the test file: the auth header is
     sent; `/health` is sent without one; the error envelope is mapped; a closed port gives
     `unreachable`; the version mismatch is caught; SSE frames are parsed, including ones split
     across chunks. Commit.
- **Verify:** `node --test tests/panel/sidecar-client.test.js`
- **Done when:**
  - [x] No method ever rejects, and every error path has a test.

### T-26.2 · Discovery, launch, health polling, lifecycle states

**Executor** agent · **Size** S · **Prereqs** T-26.1 · **Status** done

- **Read:** [03 §3](../03-architecture.md) · [07 §1.1](../07-sidecar-api.md) ·
  [09 §2](../09-ui-spec.md) (the status table)
- **Touches:** `panel/js/sidecar.js` · `tests/panel/sidecar-lifecycle.test.js` (new)
- **Interface:**
  ```javascript
  VSSidecar.createLifecycle({ fs, childProcess, env, platform, clientFactory, now, sleep,
                              launchCommand /* [exe, ...args] */, healthTimeoutMs: 30000 })
  lifecycle.connect() -> Promise<{ state, client?, detail? }>
  // state ∈ 'ready' | 'degraded' | 'unreachable' | 'version_mismatch' ; onState(cb) also emits 'starting'
  lifecycle.restart() -> Promise<…>    // POST /shutdown, wait, launch
  ```
- **Steps:**
  1. Implement it.
     - The lock-file path comes from `env.VERSESYNC_HOME`, or `env.APPDATA + '\\VerseSync'`,
       then `sidecar.json`.
     - If the lock is present, check that the PID is alive (`process.kill(pid, 0)`, injected)
       and that `/health` answers. If so, **attach**. Otherwise delete the stale lock and launch.
     - Launch **detached** (`spawn(..., {detached:true, stdio:'ignore'}).unref()`).
     - Poll `/health` every 500 ms for up to 30 s, emitting `starting`.
     - Give up as `unreachable`, with `detail` set to the log path
       (`<home>\logs\sidecar.log`).

     The default `launchCommand` is `[<venv>\Scripts\pythonw.exe, '-m', 'versesync.sidecar']`.
     Commit.
  2. Tests with fakes:
     - attach when the lock is live;
     - a stale lock (dead PID) is deleted and a launch happens;
     - health polling times out to `unreachable` at 30 s of fake time;
     - `degraded` health maps to the `degraded` state;
     - the sidecar is never killed when the panel unloads (no shutdown on dispose).

     Commit.
- **Verify:** `node --test tests/panel/sidecar-lifecycle.test.js`
- **Done when:**
  - [x] It reattaches instead of launching a second sidecar.
  - [x] A stale lock is recovered from.
  - [x] It times out at exactly 30 s, not 5 s.

### T-26.3 · Job watcher: SSE, polling fallback, rejoin after reload

**Executor** agent · **Size** S · **Prereqs** T-26.2 · **Status** done

- **Read:** [07 §2](../07-sidecar-api.md) (`/events` and `GET /jobs/{id}`) · NFR-3 in
  [01](../01-requirements.md)
- **Touches:** `panel/js/sidecar.js` · `tests/panel/job-watcher.test.js` (new)
- **Interface:**
  ```javascript
  VSSidecar.watchJob({ client, transport, storage, jobId, onProgress, onDone, onFailed, onCancelled,
                       pollMs: 1000, now, sleep }) -> { stop() }
  VSSidecar.rejoin({ storage, ... }) -> watcher | null      // resumes the job id saved in storage
  ```
- **Steps:**
  1. Implement it.
     - Save `activeJobId` to the injected storage on start, and clear it on any terminal state.
     - Subscribe to SSE. If the stream ends **without** a terminal event, fall back to polling
       `GET /jobs/{id}` until `status` is terminal. A failed or cancelled job is detected by
       polling, because the mock sends no terminal SSE event for those.
     - Progress is clamped so it never goes down on the panel side either.

     Commit.
  2. Tests with a fake transport:
     - a happy SSE run;
     - the stream drops after 2 events, then polling completes the job;
     - a failed job is reported through polling;
     - `rejoin` after a simulated reload picks the job up from storage.

     Commit.
- **Verify:** `node --test tests/panel/job-watcher.test.js`
- **Done when:**
  - [x] A dropped stream is transparent to the caller.
  - [x] A panel reload mid-job rejoins the job.

### T-26.4 · Integration against the real mock process

**Executor** agent · **Size** S · **Prereqs** T-26.3 · **Status** todo

- **Read:** `tools/README.md` (the mock's flags)
- **Touches:** `tests/panel/sidecar-mock-integration.test.js` (new) ·
  `tests/panel/helpers/spawn-mock.js` (new)
- **Steps:**
  1. Write a helper that spawns `python3 tools/mock_sidecar.py --port 0 <flags>` with
     `APPDATA` and `VERSESYNC_HOME` set to a temp dir. It parses the port and token from stdout,
     and kills the process in `after()`. Commit.
  2. Tests that use the real lifecycle, client and watcher with `launchCommand` pointed at the
     mock:
     - cold start reaches ready;
     - a second `connect()` attaches (only one process);
     - `--drop-sse` completes through polling;
     - `--fail model_load_failed` surfaces the exact OOM message;
     - `--api-version 2.0` gives `version_mismatch`;
     - `--die-mid-job` leads to `unreachable` on the next poll;
     - `--degraded` gives the `degraded` state.

     Skip the whole file with a clear message if `python3` isn't on `PATH`. Commit.
- **Verify:** `node --test tests/panel/sidecar-mock-integration.test.js`
- **Done when:**
  - [ ] Every listed mock scenario passes end to end.

## Traps

- Don't kill the sidecar when the panel closes.
- Thirty seconds is a real number: a cold CUDA model load genuinely takes that long.
- `degraded` means usable with a caveat. It isn't an error.
- **The insert path must keep working with the sidecar down** (FR-6.8). Nothing in `main.js`
  should gate Insert on the client.
