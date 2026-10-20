# Error reproduction (T-32.1, T-32.2)

One row per catalogue key in [`sidecar/versesync/errors.py`](../../sidecar/versesync/errors.py), the
single table behind the [07 §3](../07-sidecar-api.md) error codes. A key is a `code`, or
`code.variant` where one code has several causes. `{braces}` in a message are filled in at run time.
[`tests/test_error_catalogue.py`](../../tests/test_error_catalogue.py) triggers every row through
the real server and checks the message for traceback text.

| Key | HTTP | How to trigger it | Expected message | Hint |
|---|---|---|---|---|
| `bad_request` | 400 | POST `/resolve` with `{"reference": "Romans 8"}` (a chapter with no verse). | {problem} | none |
| `bad_request.body_not_object` | 400 | POST `/resolve` with the body `[]`. | The request body must be a JSON object. | none |
| `bad_request.body_too_large` | 413 | POST `/resolve` with `Content-Length` of 1 GiB. | The request body is too large. | none |
| `bad_request.invalid_json` | 400 | POST `/resolve` with the body `{not json`. | The request body is not valid JSON. | none |
| `bad_request.invalid_length` | 400 | POST `/resolve` with `Content-Length: -1`. | The Content-Length header is invalid. | none |
| `bad_request.media_outside_roots` | 400 | POST `/jobs` for a file outside `server.allowed_media_roots`. | That media file is outside the folders VerseSync may read. | Pick a file from one of the allowed media folders. |
| `bad_request.media_path_missing` | 400 | POST `/jobs` with only a `translation_id`. | The request needs a media_path. | none |
| `bad_request.method_not_allowed` | 405 | `DELETE /models`. | {method} is not allowed here. | none |
| `bad_request.no_endpoint` | 404 | `GET /nowhere`. | No such endpoint. | none |
| `bad_request.options_not_object` | 400 | POST `/jobs` with `"options": []`. | options must be a JSON object. | none |
| `bad_request.reference_missing` | 400 | POST `/resolve` with the body `{}`. | A reference (text or object) is required. | none |
| `bad_request.translation_missing` | 400 | POST `/jobs` with only a `media_path`. | The request needs a translation_id. | none |
| `unauthorized` | 401 | Any authenticated route without the bearer token or `Origin` header. The 401 is deliberately bodyless (see `tests/test_server_auth.py`), so this wording is catalogued but not sent. | VerseSync did not accept this request's credentials. | Restart VerseSync so the panel and the sidecar share a fresh token. |
| `media_not_found` | 404 | POST `/jobs` with a `media_path` that does not exist. | The media file could not be found: {path} | Check that the drive is connected and the file has not moved. |
| `media_unreadable` | 400 | POST `/jobs` for a file the sidecar may not read (the test makes hashing raise `PermissionError`). | The media file could not be read: {path} | Check that the file is not open in another program and that you can read it. |
| `model_load_failed` | in job | A job whose backend raises `TranscriptionError("model_load_failed", ...)` (the test uses `FakeBackend(error=...)`). The backend's own message is shown. | The transcription model could not be loaded: {reason} | Try a smaller model, or switch to CPU. |
| `transcription_failed` | in job | A job whose backend raises `TranscriptionError("transcription_failed", ...)`. The backend's own message is shown. | The audio could not be transcribed: {reason} | Check that the media file has an audio track, then try again. |
| `provider_unavailable` | 503 | `GET /translations` while the Bible provider cannot be reached. The provider's message is shown. | {reason} | Check your internet connection, or switch to a local Bible text. |
| `provider_unavailable.not_configured` | 503 | `GET /translations` on a sidecar started without a provider. | No Bible text provider is configured. | Choose a Bible text provider in the VerseSync settings. |
| `translation_not_licensed` | 400 | POST `/resolve` with an unknown `translation_id`. The provider's message is shown. | {reason} | Choose a translation your Bible text provider is licensed to show. |
| `job_not_found` | 404 | `GET /jobs/job_nope`. | No job with id {job_id} | Start the analysis again. |
| `job_not_found.result_gone` | 404 | Delete a finished job's result file from `$VERSESYNC_HOME/jobs/<id>/`, then `GET /jobs/<id>/result`. | The result of that job is no longer available. | Start the analysis again. |
| `job_not_finished` | 409 | `GET /jobs/<id>/result` while the job is still running. | Job {job_id} is {state}, not done. | Wait for the job to finish. |
| `cancelled` | in job | `DELETE /jobs/<id>` on a running job; the `failed` event on `/jobs/<id>/events` carries it. | The job was cancelled. | none |
| `internal` | 500 | A route handler that raises an unexpected exception. The cause goes to the log only. | Something went wrong inside VerseSync. | Check the VerseSync log for details. |
| `internal.job` | in job | A job whose backend raises an unexpected exception. The cause is in `detail`, never in the message. | VerseSync hit an unexpected problem while analysing the media. | Check the VerseSync log for details, then try again. |

`in job` rows travel inside a `200` job snapshot or a `failed` event rather than an HTTP error;
the HTTP column of the other rows is the status the sidecar returns.

## Panel and host failure states (T-32.2)

One row per failure in [03 §8](../03-architecture.md) and [09 §7](../09-ui-spec.md). Each is reproduced
by a test in [`tests/panel/failure-states.test.js`](../../tests/panel/failure-states.test.js), which drives
the real panel on jsdom and asserts the text below. Sidecar rows use the real
[`tools/mock_sidecar.py`](../../tools/mock_sidecar.py) process and its flags (`python tools/mock_sidecar.py
--duration 2 <flag>`, see [`tools/README.md`](../../tools/README.md)). Host rows use the stub host
(`?hostSequence=` and `?hostSegments=` in the panel URL, or `VS.__setScenario`) or `VerseSync.jsx` on the
fake Premiere. The panel shows a job failure in the review area as the sidecar's `message`, its `hint`
beneath it, and a **Retry** button.

| Failure | How to trigger it | Expected on screen | Test |
|---|---|---|---|
| Sidecar will not launch | The launch command cannot be spawned, the child reports an error, or no lock file appears within 30 s. | Status strip `✕ transcription service unavailable`; **Details** holds the log path (`%APPDATA%\VerseSync\logs\sidecar.log`). **Analyse** is disabled, reason `Transcription service isn't ready.` | `sidecar will not launch (...)` (three rows) |
| Load-and-insert with the sidecar down | As above, then choose a template and press **Load cue document** in the review area. | The rows load and **Insert** places them: `Placed 18 of 18. Ctrl+Z removes the graphics one at a time.` The status strip stays `✕`. A file that cannot be read says `That file could not be read.` beside the button. | `with the sidecar down, a saved cue document still loads and inserts`, `Load cue document says why ...` |
| Sidecar dies mid-job | Mock flag `--die-mid-job`, then **Analyse**. | `The VerseSync sidecar is not responding.` / hint `Check that the sidecar is running, then try again.` / **Retry** (which fails the same way while the sidecar is down). | `the sidecar dies mid-job ...` |
| Model fails to load | Mock flag `--fail model_load_failed`, then **Analyse**. | `Could not load large-v3-turbo on cuda: out of memory (9.1 GB free, ~10.4 GB required).` / hint `Try large-v3-turbo with float16, or switch to CPU.` / **Retry**. With the real sidecar the text is the catalogue's `model_load_failed` row. | `the model fails to load ...` |
| Media file unreadable | `POST /jobs` for a file the sidecar may not read (`media_unreadable`), or a job that fails in transcription (`transcription_failed`). The mock has no flag for it, so the test serves the catalogue's text through a fake client. | `The media file could not be read: <path>` / hint `Check that the file is not open in another program and that you can read it.` / **Retry**. No result is fetched and no rows appear. | `the media is unreadable ...`, `the media has no audio ...` |
| Bible provider down | Mock flag `--fail provider_unavailable`, then **Analyse**. | A successful job: 12 rows, `text unavailable` flags, a banner `The Bible text could not be fetched for some cues.` with **Retry text fetch**, and no failure box. With the provider still down, **Retry text fetch** shows the provider's message and unlocks the button after one request. | `the Bible provider is down ...`, `Retry text fetch with the provider still down ...` |
| No sequence open | Panel URL `?stub=1&hostSequence=sequence-none`, or close every sequence in Premiere. | Status strip `▲ no sequence open`. **Analyse** is disabled, reason `Open a sequence in Premiere first.` **Insert** after the sequence closes shows the same sentence (from the host, or from setup once **Refresh** is pressed) and never calls `insertCues`. **Load cue document** shows it with a **Retry**. | `no sequence open: ...` (two rows) |
| Media not in the sequence | Panel URL `?stub=1&hostSegments=segments-none`, then **Analyse**. | `SERMON_A014.MXF isn't in this sequence.` and `Enter a start timecode manually`. A valid timecode (`01:00:00:00`) lists the rows with `Positions come from the start timecode you entered, so they are approximate if the audio was cut.` | `the media is not in the sequence ...` |
| MOGRT has no editable fields | Choose a template whose Essential Graphics panel has no text properties. | `No editable text fields were found in this template. Templates must be authored in After Effects with text layers exposed as Essential Graphics properties.` **Analyse** is disabled, reason `This template has no editable text fields.` **Insert** shows the same reason and never calls `insertCues`. | `the MOGRT has no editable fields ...` |
| One `importMGT` fails mid-batch | The host's `importMGT` returns null for one cue (the fake's `failImportFor`, or a missing MGT component). | `Placed 17 of 18 — 1 failed, see details. Ctrl+Z removes the graphics one at a time.` Details list the cue and the host's message; **Retry failed** inserts only it. The undo log holds one `begin` and one `end`. | `one importMGT fails mid-batch ...` |

### Never-settling promises

A promise that never settles leaves a spinner up with no message, which is worse than an error, so
every long-lived call ends in a message. The audit (T-32.2 step 2) found and closed these:

| Gap | Fix | Test |
|---|---|---|
| A sidecar that accepts a connection and never answers left `client.*` pending forever. | The transport gives up after 60 s (`REQUEST_TIMEOUT_MS`) and the client reports `unreachable`. | `a frozen sidecar ends in an error ... (POST /jobs is never answered)` |
| A job event stream that goes silent (a frozen sidecar) stopped progress with nobody polling. | The stream is dropped after 60 s without a byte (`STREAM_IDLE_MS`, four of the sidecar's 15 s keepalives), which starts the poll, which times out. | `a frozen sidecar ends in an error ... (the event stream ...)` |
| A rejecting `startJob`, `job` or `result` left the progress view up. | `analyse`, `onJobDone` and `watchJob` end in a handler that shows `Unexpected error: <message>`. | `a client call that rejects ends the analysis ...` |
| A rejecting host call left setup, Analyse or Insert locked. | Every chain in `main.js`, `setup.js` and `review.js` ends in a handler that unlocks and says what happened. | `a bridge call that rejects ...`, `a row edit and a text retry that reject ...` |

Not changed on purpose: `bridge.call` has no timeout. A host that has stopped answering is Premiere
itself being busy or hung, and a timeout would unlock the panel while an `insertCues` batch may still
be writing, so a second **Insert** would place every cue twice. `tests/panel/failure-states.test.js`
wraps every bridge, client and lifecycle call in a 5 s watchdog and fails a test that ends with a call
pending or a spinner visible, and its last test pins the three `new Promise` sites that were reviewed.
