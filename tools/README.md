# tools/

## `validate_cue_document.py` (T-37)

CLI and importable validator for the Cue Document schema. See `schemas/cue-document.schema.json`
and `tests/fixtures/cue-documents/`.

```
python tools/validate_cue_document.py tests/fixtures/cue-documents/*.json
```

## `mock_sidecar.py` (T-38)

Speaks the real sidecar HTTP + SSE contract ([07](../docs/07-sidecar-api.md)) and the real
process lifecycle ([03](../docs/03-architecture.md) §3), serving the T-37 golden fixtures
instead of running a GPU pipeline. It is the panel's permanent test double, not a throwaway
prototype — **T-42** asserts it and the real sidecar satisfy the same contract suite.

```
python tools/mock_sidecar.py
```

prints the assigned port and bearer token, then blocks serving requests until Ctrl-C or
`POST /shutdown`.

### Flags

| Flag | Effect |
|------|--------|
| `--port N` | Fixed port instead of an OS-assigned ephemeral one. |
| `--scenario {happy,flagged,alternatives,empty}` | Which T-37 fixture a successful job resolves to (default `happy`). |
| `--duration N` | Wall-clock seconds for a job to run (default `20`). |
| `--fail model_load_failed` | The job fails immediately with the OOM example from [07 §3](../docs/07-sidecar-api.md). |
| `--fail provider_unavailable` | **Not a job failure.** Per [11-testing.md §5](../docs/11-testing.md), a provider outage still produces a successful job — this overrides `--scenario` and serves the `flagged` fixture's outcome (`text_unavailable` cues + a `provider_partial` warning). |
| `--degraded` | `GET /health` reports `status: "degraded"`, no GPU, provider unreachable. Independent of any job. |
| `--slow` | 5x the job duration. |
| `--die-mid-job` | **Kills the mock's own process** (`os._exit`) once a running job crosses 50% weighted progress, simulating a sidecar crash. The process is gone afterward — restart it for further testing. |
| `--drop-sse` | The SSE stream for a job closes after 2 `progress` events, before `done`, regardless of the job's real progress — so the panel's polling fallback (NFR-3) can be exercised. The job itself keeps running and finishes normally; poll `GET /jobs/{id}` to see that. |
| `--cache-hit` | Every job reports `cache_hit: true`, skips the `transcribing` phase, and the remaining phase weights are renormalised (so the job finishes in a few seconds — the "re-run visibly races through the bar" behaviour from [07 §4](../docs/07-sidecar-api.md)). |
| `--api-version X.Y` | Overrides the `X-VerseSync-Api` response header and the lock file's `api_version`, to exercise the panel's version-mismatch path. Default `1.0`. |
| `--allow-origin ORIGIN` (repeatable) | Restrict the Origin allowlist to specific values. Default: accept any *present* `Origin` header, reject a request with none. **The real CEP origin string isn't pinned down yet (T-22's job)** — tighten this once it is. |
| `--no-lock-file` | Don't read/write `%APPDATA%\VerseSync\sidecar.json`. Useful for running more than one mock at a time, or in automated tests. |

### The lock file and auth

By default the mock writes the real lock file at `%APPDATA%\VerseSync\sidecar.json`, with the
same shape a real sidecar would (`pid`, `port`, `token`, `api_version`, `sidecar_version`,
`started_at`), restricted to the current user via `icacls` on Windows (best-effort; never
fatal). Every request except `GET /health` needs:

- `Authorization: Bearer <token>` — the token printed at startup (and in the lock file).
- A non-empty `Origin` header.

Either missing or wrong gets a bare `401` with no body — the mock does not distinguish the two
in its response, matching [07 §1.2](../docs/07-sidecar-api.md)'s "missing or wrong token gets
401 with no body" for auth, extended the same way to Origin since the spec doesn't give Origin
rejection its own status code.

### Worked examples

```bash
# health is the only unauthenticated route
curl http://127.0.0.1:<port>/health

# everything else needs the token + an Origin header
curl -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     http://127.0.0.1:<port>/models

# start a job (media_path is never actually read by the mock)
curl -X POST -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     -H "Content-Type: application/json" \
     -d '{"media_path":"D:/x.mxf","translation_id":"de4e12af7f28f599-02"}' \
     http://127.0.0.1:<port>/jobs

# stream progress (Ctrl-C to stop watching; the job keeps running)
curl -N -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     http://127.0.0.1:<port>/jobs/<job_id>/events

# or poll
curl -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     http://127.0.0.1:<port>/jobs/<job_id>

# once done
curl -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     http://127.0.0.1:<port>/jobs/<job_id>/result

# cancel a running job
curl -X DELETE -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     http://127.0.0.1:<port>/jobs/<job_id>

# resolve a reference the fixtures already know about (anything in happy/flagged/
# alternatives/empty's cues or alternatives[], by "Book C:V" or {"book","chapter","verse"})
curl -X POST -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     -H "Content-Type: application/json" -d '{"reference":"Romans 8:28"}' \
     http://127.0.0.1:<port>/resolve

# graceful stop
curl -X POST -H "Authorization: Bearer <token>" -H "Origin: http://localhost" \
     http://127.0.0.1:<port>/shutdown
```

### Known simplifications (intentional, not bugs)

- `media_path` is never checked against the filesystem — `media_not_found` isn't one of T-38's
  required `--fail` scenarios, and the fixtures replace the whole pipeline anyway.
- `POST /resolve` only knows the references already present in the four T-37 fixtures (including
  their `alternatives[]`). Anything else is `bad_request`. It also does not do real per-verse
  decomposition — `verses[]` always carries a single entry covering the whole resolved body,
  even for a range; true per-verse splitting belongs to T-06/T-14.
- A failed or cancelled job emits no terminal SSE event — [07](../docs/07-sidecar-api.md)'s SSE
  example only shows `progress` and `done`, and inventing an undocumented event type for a
  frozen contract isn't this task's call to make. A client learns the outcome from
  `GET /jobs/{id}` or `/result`.

## `generate_web.py` (T-14)

Builds `sidecar/versesync/bible/data/web.json.gz`, the bundled World English Bible, from a pinned,
checksum-verified source fetched directly from eBible.org, and aligns it to the canon table. See
the module docstring and [06](../docs/06-bible-text-service.md) §3.3 for the source and the
versification differences.

```
python tools/generate_web.py                      # downloads the pinned source
python tools/generate_web.py --source FILE.zip     # use a local copy of it
```
