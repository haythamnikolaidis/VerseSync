# Error reproduction (T-32.1)

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
