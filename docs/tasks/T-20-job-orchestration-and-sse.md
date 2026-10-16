# T-20 · Job orchestration and SSE

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Unblocks** | T-21.2, T-42.2 |
| **Spec** | [07-sidecar-api.md §2–4](../07-sidecar-api.md) |

## Goal

Put `hash → transcribe (or cache) → run_pipeline` behind the HTTP and SSE contract, with live
progress and clean cancellation. **This is where the sidecar becomes whole.**

## Context

`run_pipeline` (T-19.3) already joins detection, resolution and timing. This epic adds the job
layer around it. `tools/mock_sidecar.py` already speaks this exact contract, and the panel was
built against it. **When in doubt, match the mock's observable behaviour.** T-42 will hold you
to it.

## Subtasks

### T-20.1 · Progress accounting and the job registry

**Executor** agent · **Size** S · **Prereqs** T-05.4 · **Status** done

- **Read:** [07 §2](../07-sidecar-api.md) (`GET /jobs/{id}`) · [07 §4](../07-sidecar-api.md)
- **Touches:** `sidecar/versesync/jobs.py` (new) · `tests/test_jobs_progress.py` (new)
- **Interface:**
  ```python
  PHASE_WEIGHTS = (("hashing", .02), ("transcribing", .80), ("detecting", .05),
                   ("resolving", .10), ("timing", .03))
  class Progress:
      def __init__(self, skip: frozenset[str] = frozenset()): ...    # renormalises remaining weights
      def update(self, phase: str, fraction: float) -> float          # returns the overall 0..1, monotonic
  @dataclass
  class Job:
      id: str; status: str; phase: str | None; progress: float; message: str | None
      error: dict | None; cache_hit: bool; created: float; result_path: Path | None
      def snapshot(self) -> dict          # the GET /jobs/{id} body
  class JobRegistry:
      def create(self, **kw) -> Job; def get(self, job_id: str) -> Job   # ApiError 404 job_not_found
      def subscribe(self, job_id) -> Queue; def publish(self, job_id, event: str, data: dict) -> None
      def active_count(self) -> int
  ```
- **Steps:**
  1. Write `Progress`. The overall value **never goes down**: phase fractions are clamped, and a
     phase change can't reduce the total. When a phase is skipped, its weight is renormalised
     away, so the bar still ends at exactly 1.0. Commit.
  2. Write `Job`, `JobRegistry` and a publish/subscribe queue for each job. Job ids look like
     `job_<26-char ULID-like>`, using an injectable id factory. Tests:
     - progress never goes down;
     - with `transcribing` skipped, the bar still ends at 1.0;
     - an unknown job gives `job_not_found`.

     Commit.
- **Verify:** `pytest tests/test_jobs_progress.py -q`
- **Done when:**
  - [x] Progress never goes down and ends at exactly 1.0, with or without a skipped phase.

### T-20.2 · Job runner

**Executor** agent · **Size** S · **Prereqs** T-20.1, T-08, T-19.3, T-16 · **Status** done

- **Read:** [07 §3](../07-sidecar-api.md) (the code list) · [06 §3.2](../06-bible-text-service.md)
- **Touches:** `sidecar/versesync/jobs.py` · `tests/test_job_runner.py` (new)
- **Interface:**
  `def run_job(job: Job, req: dict, *, config: Config, backend: Backend, provider: BibleProvider, registry: JobRegistry, clock) -> None`.
  It runs on a worker thread and fills in `job.status`, `job.error` and `job.result_path`.
- **Steps:**
  1. Run the phases:
     - **hashing:** `hash_media`.
     - **transcribing:** check `TranscriptCache` first. On a hit, set `cache_hit` and skip the
       phase. Otherwise run `backend.transcribe`, then `put` the result. Honour
       `use_cache: false`.
     - **detecting / resolving / timing:** `run_pipeline`.

     Write the document with `write_document` under `app_home()/jobs/<id>/cues.json`.
     Publish a `progress` event on every phase change, at most twice a second within a phase
     (with an injected clock). Finish with exactly one terminal event: `done` with
     `{job_id, cue_count}`, or `failed` with `{job_id, error}`. Commit.
  2. Map errors to the [07 §3] envelope:
     - a missing file is `media_not_found`;
     - an unreadable file is `media_unreadable`;
     - `TranscriptionError` passes its `code` through;
     - `TranslationNotLicensed` is `translation_not_licensed`, raised **before** hashing;
     - `Cancelled` sets `status=cancelled`, writes no result, and doesn't populate the
       transcript cache;
     - anything else is `internal`.

     Tests using `FakeBackend` and `LocalProvider`:
     - a happy run;
     - a cache-hit run, with no `transcribing` phase, ending at 1.0;
     - a provider that fails every fetch still gives a **done** job, with `text_unavailable`
       cues and a `provider_partial` warning;
     - a cancel mid-transcription gives `cancelled` within 1 s of fake time.

     Commit.
- **Verify:** `pytest tests/test_job_runner.py -q`
- **Done when:**
  - [x] A provider outage is a successful job (FR-4.5).
  - [x] Cancellation leaves no cached transcript and no result.
  - [x] Exactly one terminal event is published per job.

### T-20.3 · Job endpoints

**Executor** agent · **Size** S · **Prereqs** T-20.2, T-50 · **Status** in-progress

- **Read:** [07 §2](../07-sidecar-api.md) (`POST /jobs`, `GET /jobs/{id}`, `/result`,
  `DELETE`)
- **Touches:** `sidecar/versesync/server.py` · `sidecar/versesync/sidecar.py` (wiring) ·
  `tests/test_job_endpoints.py` (new)
- **Steps:**
  1. Add the endpoints:
     - `POST /jobs` returns `202 {job_id, status, cache_hit, estimated_duration_s}`. Check the
       cache synchronously so that `cache_hit` is accurate. The estimate is the media duration
       times a per-device factor from config.
     - `media_path` must exist, and must sit under one of `server.allowed_media_roots` when that
       list isn't empty. Otherwise return `media_not_found` or `bad_request`.
     - `GET /jobs/{id}`, and `GET /jobs/{id}/result`, which returns `409 job_not_finished`
       unless the job is done.
     - `DELETE /jobs/{id}`, which cancels a running job and discards a finished one.

     Add `GET /jobs/{id}/transcript`, as defined by D22 ([T-50](T-50-contract-transcript-endpoint.md)).
     Commit.
  2. Write tests against a threaded server using the `fixture:` backend: the full lifecycle,
     `409` before done, `DELETE` leading to `cancelled`, and the media-root check. Commit.
- **Verify:** `pytest tests/test_job_endpoints.py -q`
- **Done when:**
  - [ ] A whole job runs over HTTP using the fixture backend and gives a schema-valid document.

### T-20.4 · SSE endpoint

**Executor** agent · **Size** S · **Prereqs** T-20.3 · **Status** todo

- **Read:** [07 §2](../07-sidecar-api.md) (`GET /jobs/{id}/events`) · `tools/mock_sidecar.py`
  (the SSE writer only)
- **Touches:** `sidecar/versesync/server.py` · `tests/test_sse.py` (new)
- **Steps:**
  1. Add `GET /jobs/{id}/events` with `text/event-stream`.
     - Immediately send the current snapshot as a `progress` event, then stream events from
       the job's queue.
     - Close after the terminal event.
     - A client disconnecting must not affect the job.
     - Subscribing to a job that's already finished sends one snapshot, then the terminal
       event.

     Commit.
  2. Tests:
     - the event sequence is `progress`*, then exactly one `done`;
     - the `progress` values never go down;
     - closing the client halfway leaves the job running to completion;
     - a late subscriber still gets the terminal event.

     Commit.
- **Verify:** `pytest tests/test_sse.py -q`
- **Done when:**
  - [ ] A dropped stream never loses the job's state (NFR-3).

### T-20.5 · `/models`, `/translations`, `/resolve`, and `/health` status

**Executor** agent · **Size** S · **Prereqs** T-20.3, T-48.1 · **Status** todo

- **Read:** [07 §2](../07-sidecar-api.md) (`/health`, `/models`, `/translations`, `/resolve`)
- **Touches:** `sidecar/versesync/server.py` · `sidecar/versesync/sidecar.py` ·
  `tests/test_misc_endpoints.py` (new)
- **Steps:**
  1. Add the endpoints:
     - `GET /models` lists the model table, with `word_timestamp_quality` taken from T-02.
     - `GET /translations` comes from the configured provider (local by default), via
       `Translation.to_json`.
     - `POST /resolve` takes a string or a dict, goes through `parse_reference`, then the
       caching provider, then `format_passage`, and returns `Passage.to_json()`.
       `InvalidReference` becomes `400 bad_request` with the editor message.
     - `/health` reports `busy` while a job runs, and `degraded` when the device is CPU or the
       provider is unreachable (checked by a cheap, cached `list_translations`). `active_jobs`
       is filled in.

     Commit.
  2. Tests:
     - `POST /resolve "Romans 8:28"` returns the body starting `28 And we know`;
     - `"Jude 5:1"` returns 400 with `Jude has only 1 chapter.`;
     - `/health` goes from `ready` to `busy` and back;
     - an unreachable provider gives `degraded`.

     Commit.
- **Verify:** `pytest tests/test_misc_endpoints.py -q`
- **Done when:**
  - [ ] Every endpoint in [07 §2] is implemented.

## Traps

- Progress must never go down. A phase transition that briefly lowers the total is the most
  common bug here.
- The only provider failure that fails a job is `TranslationNotLicensed`, and it fails at the
  start of the job.
- **The mock emits no terminal SSE event for failed or cancelled jobs** (see `tools/README.md`,
  "Known simplifications"). The real sidecar emits `failed`. T-42.1 asserts on the
  terminal-event shape only for `done`, and treats failed and cancelled jobs as "terminal state
  visible via `GET /jobs/{id}`", so both servers pass.
