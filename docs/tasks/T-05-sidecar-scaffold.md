# T-05 · Sidecar scaffold

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-40 |
| **Unblocks** | T-07, T-20, T-26 |
| **Spec** | [07-sidecar-api.md §1–2](../07-sidecar-api.md) · [03-architecture.md §3, §5](../03-architecture.md) |

## Goal

`python -m versesync.sidecar` starts, binds loopback on an ephemeral port, writes the lock
file, authenticates requests, and serves `GET /health`.

## Context you need

The panel owns the sidecar's lifetime ([03 §3](../03-architecture.md)) but the sidecar must be
independently runnable — that is what makes the CLI, the tests and support reproduction
possible (NFR-5).

Security here is a real requirement, not ceremony (NFR-4): a CEP panel is a Chromium context,
and any page it loads could otherwise reach a loopback service. Loopback binding **plus** a
per-launch token **plus** an `Origin` allowlist is the minimum bar.

T-38's mock already implements this contract — read it, and keep the two consistent.

## Steps

1. Package layout per [03 §5](../03-architecture.md): `sidecar/versesync/` with `__main__.py`,
   `server.py`, `config.py`.
2. HTTP server binding **`127.0.0.1` only**, `--port 0` for an ephemeral port. Never bind
   `0.0.0.0`.
3. Bearer auth from `secrets.token_urlsafe(32)`, generated per launch. Missing or wrong token →
   `401`, no body. `/health` is the only unauthenticated route.
4. `Origin` allowlist for the panel's CEP origin; reject others.
5. `X-VerseSync-Api: 1.0` on every response.
6. Lock file at `%APPDATA%\VerseSync\sidecar.json` per [07 §1.1](../07-sidecar-api.md), with
   **user-only ACLs**. Refuse to start if a live sidecar already holds the lock; clear it if the
   recorded PID is dead.
7. `GET /health` returning the [07 §2](../07-sidecar-api.md) shape, with `status` ∈
   `starting | ready | busy | degraded`.
8. Idle self-exit after a configurable period (default 30 min) with no jobs and no clients.
9. Structured logging to a file, with the path reported in errors ([03 §8](../03-architecture.md)).
10. `config.py` — YAML config following Faster-Whisper-Transcriber's `config/manager.py`
    pattern. **Credentials load here and are never logged or serialised.**

## Files

- `sidecar/versesync/{__main__.py,server.py,config.py}`
- `tests/test_server_auth.py`, `tests/test_lockfile.py`

## Done when

- [ ] `curl` gets a health response with the token, `401` without it.
- [ ] Two sidecars cannot both claim the lock; a stale lock (dead PID) is cleared.
- [ ] The bound socket is loopback-only (assert it in a test).
- [ ] Idle self-exit fires.
- [ ] The relevant parts of T-42's contract suite pass.

## Traps

- The token must be regenerated per launch, never persisted across runs.
- `status: degraded` is a real state, not an error — no GPU or an unreachable provider means
  "will serve, but tell the editor why" ([09 §2](../09-ui-spec.md)).

## Status

- **Met** — `curl` gets a health response with the token, `401` without it: `tests/test_server_auth.py`
  (`test_health_is_unauthenticated_and_has_the_contract_shape`, `test_protected_route_without_token_is_401_with_no_body`,
  `test_wrong_token_is_401_with_no_body`, `test_subprocess_end_to_end` against `python -m versesync.sidecar`).
  `/health` is the unauthenticated route; every other route needs the bearer token and an allowlisted `Origin`.
- **Met** (POSIX) / **Deferred** (Windows ACL) — Two sidecars cannot both claim the lock; a stale lock (dead PID) is cleared:
  `tests/test_lockfile.py` (`test_second_sidecar_cannot_claim_a_live_lock`, `test_stale_lock_with_a_dead_pid_is_cleared`,
  `test_concurrent_processes_race_for_the_lock`). **Deferred — needs a Windows machine** for the user-only ACL
  and the Windows PID-liveness probe (the `icacls` command line is unit-tested with a stub). Steps:
  1. `python -m versesync.sidecar --print-token`.
  2. `icacls %APPDATA%\VerseSync\sidecar.json` shows only the current user with `(F)` and no inherited entries.
  3. In a second terminal run the same command: it exits with code 3 and "already running".
  4. Kill the first with `taskkill /F /PID <pid>` (the lock stays behind), start again: it starts and replaces the lock.
- **Met** — The bound socket is loopback-only: `test_socket_is_bound_to_loopback_only`,
  `test_server_has_no_way_to_choose_a_host`.
- **Met** — Idle self-exit fires: `test_idle_self_exit_fires`, `test_idle_exit_waits_for_active_jobs_and_clients`,
  `test_requests_reset_the_idle_clock`, and the subprocess exits 0 and releases its lock in `test_subprocess_end_to_end`.
- **Deferred — needs T-42** (`tests/contract/` does not exist yet). Steps once it lands: run
  `pytest tests/contract` against `python -m versesync.sidecar --print-token` and confirm the `/health`, `401`,
  `Origin` rejection and `X-VerseSync-Api` assertions pass.
