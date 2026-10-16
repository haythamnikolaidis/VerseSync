# T-05 · Sidecar scaffold

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Unblocks** | T-07, T-08, T-16, T-20, T-42 |
| **Spec** | [07-sidecar-api.md §1–3](../07-sidecar-api.md) · [03-architecture.md §3, §8](../03-architecture.md) |

## Goal

`python -m versesync.sidecar` starts and binds loopback on an ephemeral port. It writes the lock
file, authenticates requests, and serves `GET /health` and `POST /shutdown`.

## Context

Security here is a real requirement (NFR-4). A CEP panel is a Chromium context, so loopback
binding, a per-launch token and an `Origin` allowlist are the minimum bar.
**`tools/mock_sidecar.py` already implements this contract.** Read its auth, lock-file and
`Handler` code, and match its behaviour. Don't import from it: it's a test double, and the real
sidecar mustn't depend on one.

**Origin (D21):** the panel talks to the sidecar through Node's `http` module and sets
`Origin: cep://com.versesync.panel` explicitly (see [T-26](T-26-panel-sidecar-client.md)). The
real sidecar's default `server.allowed_origins` is therefore `["cep://com.versesync.panel"]`.
The mock accepts any non-empty Origin, so the contract tests (T-42) send this value to both.

## Subtasks

### T-05.1 · `paths.py` and `config.py`

**Executor** agent · **Size** S · **Prereqs** T-44 · **Status** done

- **Read:** [05 §2](../05-timing-and-placement.md) (the config table) ·
  [06 §8](../06-bible-text-service.md) · `reference/fwt/config/manager.py` (the
  load/merge-defaults pattern only)
- **Touches:** `pyproject.toml` (add `PyYAML>=6`) · `sidecar/versesync/paths.py` (new) ·
  `sidecar/versesync/config.py` (new) · `tests/conftest.py` (add an `app_home` fixture) ·
  `tests/test_config.py` (new)
- **Interface:**
  ```python
  # paths.py
  def app_home() -> Path       # $VERSESYNC_HOME, else %APPDATA%\VerseSync (win32), else ~/.local/share/versesync; mkdir -p
  def lock_path() -> Path      # app_home()/sidecar.json
  def cache_dir() -> Path      # app_home()/cache
  def log_path() -> Path       # app_home()/logs/sidecar.log
  # config.py
  @dataclass(frozen=True)
  class Config:
      transcription: dict; detection: dict; timing: dict; bible: dict; server: dict
      def secret(self, env_name_key: str) -> str | None   # reads the env var NAMED in config; never stored
  def load_config(path: Path | None = None) -> Config     # defaults ← app_home()/config.yaml ← path
  ```
  The defaults are the [05 §2] table, [06 §8] `bible:`, `server: {idle_exit_s: 1800,
  allowed_origins: ["cep://com.versesync.panel"], allowed_media_roots: []}`, and `transcription` defaults left as an empty
  dict for T-07.1 to fill.
- **Steps:**
  1. Write `paths.py` and its tests. Commit.
  2. Write `config.py`: a deep merge of defaults with the YAML file, plus `secret()`.
     `Config.__repr__` must not include any secret value. Test it. Commit.
- **Verify:** `pytest tests/test_config.py -q`
- **Done when:**
  - [x] `VERSESYNC_HOME` overrides the home directory, and every test uses `tmp_path`.
  - [x] Credentials are read from the environment by variable name, and they never appear in
        `repr`, in logs, or in `config.yaml`.

### T-05.2 · Lock file

**Executor** agent · **Size** S · **Prereqs** T-05.1 · **Status** done

- **Read:** [07 §1.1](../07-sidecar-api.md) · `tools/mock_sidecar.py` (the lock-file functions
  only; grep for `lock`)
- **Touches:** `sidecar/versesync/lockfile.py` (new) · `tests/test_lockfile.py` (new)
- **Interface:**
  ```python
  @dataclass(frozen=True)
  class LockInfo: pid: int; port: int; token: str; api_version: str; sidecar_version: str; started_at: str
  class LockHeld(Exception): info: LockInfo
  def pid_alive(pid: int) -> bool              # os.kill(pid, 0) on POSIX; ctypes OpenProcess on win32
  def acquire(info: LockInfo) -> None          # raises LockHeld if a live PID holds it; clears a stale one
  def release(pid: int) -> None                # deletes only if the file still holds this pid
  def read() -> LockInfo | None
  ```
- **Steps:**
  1. Implement it. Writes are atomic (temp file plus `os.replace`). On win32, restrict the file
     to the current user with `icacls`, best-effort and never fatal, the same way the mock
     does. Commit.
  2. Tests: acquire then acquire again raises `LockHeld`; a lock held by a dead PID (use a PID
     known to be dead, such as one from a finished `subprocess`) gets cleared; `release` doesn't
     delete another process's lock. Commit.
- **Verify:** `pytest tests/test_lockfile.py -q`
- **Done when:**
  - [x] Two sidecars can't both hold the lock, and a stale lock is cleared.

### T-05.3 · HTTP server core: bind, auth, Origin, headers, errors, `/health`, `/shutdown`

**Executor** agent · **Size** S · **Prereqs** T-05.2 · **Status** in-progress

- **Read:** [07 §1.2, §1.3, §2 (`/health`, `/shutdown`), §3](../07-sidecar-api.md) ·
  `tools/mock_sidecar.py` (the `Handler` auth path and the error-envelope helper only)
- **Touches:** `sidecar/versesync/server.py` (new) · `tests/test_server_auth.py` (new)
- **Interface:**
  ```python
  API_VERSION = "1.0"
  class ApiError(Exception):   # rendered as the 07 §3 envelope
      def __init__(self, status: int, code: str, message: str, *, hint: str | None = None,
                   detail: str | None = None, retryable: bool = False): ...
  class SidecarServer:
      def __init__(self, config: Config, token: str, port: int = 0): ...   # binds 127.0.0.1 ONLY
      port: int
      def route(self, method: str, pattern: str, handler, *, auth: bool = True) -> None  # pattern like "/jobs/{id}"
      def health(self) -> dict          # overridable provider of the /health body
      def serve_forever(self) -> None; def shutdown(self) -> None
  ```
- **Steps:**
  1. Write `SidecarServer` on `ThreadingHTTPServer`, with a small router.
     - Every request except `/health` needs the right bearer token and a present, allowlisted
       `Origin`. Otherwise it gets a bare `401` with no body.
     - `X-VerseSync-Api: 1.0` goes on **every** response.
     - `ApiError` becomes the JSON envelope. Any other exception becomes a `500` `internal`
       envelope, with nothing leaked.

     Commit.
  2. Add `GET /health`, in the 07 shape (`status` defaults to `starting`, then `ready`), and
     `POST /shutdown`. Tests, against a server started on a thread:
     - token present gives 200, and missing or wrong gives 401;
     - a missing `Origin` gives 401;
     - the API header is present on 200, 401 and 404 responses;
     - the bound address is `127.0.0.1` (assert `server.server_address[0]`);
     - an unknown route gives a 404 envelope.

     Commit.
- **Verify:** `pytest tests/test_server_auth.py -q`
- **Done when:**
  - [ ] Every assertion above passes.
  - [ ] The server never binds `0.0.0.0`.

### T-05.4 · Entry point, logging, idle self-exit

**Executor** agent · **Size** S · **Prereqs** T-05.3 · **Status** todo

- **Read:** [03 §3](../03-architecture.md) (the lifecycle) · [03 §8](../03-architecture.md) (the
  log path in errors)
- **Touches:** `sidecar/versesync/sidecar.py` (new) · `sidecar/versesync/__main__.py` (new;
  delegates to `sidecar.main`) · `tests/test_sidecar_process.py` (new)
- **Steps:**
  1. Write `main(argv)`. It parses `--port` (default 0) and `--config`, generates the token with
     `secrets.token_urlsafe(32)` **once per launch**, starts the server, acquires the lock with
     the real port, and logs to `log_path()` with rotation. It prints
     `VERSESYNC_READY port=<p>` to stdout once it's listening. It handles SIGINT/SIGTERM and
     `/shutdown` by releasing the lock. Commit.
  2. Add idle self-exit: after `server.idle_exit_s` with no in-flight jobs (a hook that T-20
     fills in, defaulting to 0) and no request, shut down cleanly. Tests run the module as a
     subprocess with `VERSESYNC_HOME=tmp_path`:
     - it prints READY, `/health` answers, and the lock file has the port;
     - `/shutdown` exits with code 0 and removes the lock;
     - with `idle_exit_s: 1` in the config, the process exits by itself within 5 s;
     - a second instance exits non-zero with a clear "already running" message.

     Commit.
- **Verify:** `pytest tests/test_sidecar_process.py -q`
- **Done when:**
  - [ ] `python -m versesync.sidecar` works and `python -m versesync` is an alias for it.
  - [ ] Idle exit, shutdown, and refusing a second instance are all tested.
  - [ ] The token is never written to the log.

## Traps

- The token is regenerated on every launch and never persisted anywhere except the user-only
  lock file.
- `degraded` is a real state, not an error. T-20.5 computes it.
