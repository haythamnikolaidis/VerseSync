# VerseSync

Automatically add scriptures to your Adobe Premiere timeline.

VerseSync is a Premiere Pro panel that transcribes a sermon locally, finds every scripture
reference the speaker mentions or reads, fetches the verse text, and places each one on the
timeline as a Motion Graphics Template — at the exact frame where the speaker begins.

Two clicks: **Analyse**, review, **Insert**.

## Install

Two commands, one for the sidecar and one for the panel. The full walk-through, every
configuration option and where credentials go are in **[`docs/INSTALL.md`](docs/INSTALL.md)**.

```
python install.py
powershell -ExecutionPolicy Bypass -File tools\install_panel.ps1
```

Restart Premiere Pro, then open **Window > Extensions > VerseSync**.

## Documentation

The full product requirements and technical plan live in **[`docs/`](docs/)**. Start with
[`docs/README.md`](docs/README.md) for the index, or go straight to
[`docs/00-prd.md`](docs/00-prd.md).
[`docs/13-technical-plan.md`](docs/13-technical-plan.md) is the build order. Individual tasks are
one file each in [`docs/tasks/`](docs/tasks/), indexed by [`docs/10-tasks.md`](docs/10-tasks.md).

## How it fits together

| Repo | Role |
|------|------|
| **VerseSync** (this one) | The product: reference detection, timing, verse resolution, the review UI, and the Premiere panel that ships to editors. |
| **VerseFlow** | Ancestor. Its proven `.mogrt` insert-and-fill technique, index-based field mapping, undo grouping and duration model are reused wholesale. |
| **Faster-Whisper-Transcriber** | Transcription engine, run headless as a local sidecar service. |

A file-by-file audit of what is reused from each — and every gap that must be closed — is in
[`docs/02-source-project-audit.md`](docs/02-source-project-audit.md).

## Target

Adobe Premiere Pro 2026 · Windows · internal distribution (unsigned, debug-mode install).

## Licensing

Attribution is a licensing obligation, not polish. Each translation carries the exact
attribution string its licence requires. The panel shows it beside the translation selector and
the Cue Document stores it. It is never inferred or paraphrased.

| Translation | Source | Attribution |
|---|---|---|
| King James Version (`kjv`) | Bundled with the sidecar | Public domain. |

Any other translation must have its attribution string configured verbatim from the provider's
terms; an unconfigured translation has an empty attribution. Obligations that follow from the
licences ([06 §5](docs/06-bible-text-service.md)):

- **Caching.** Verse text is cached only for translations whose `cache_allowed` is true. A
  translation configured without an explicit entry is not cached.
- **Quantity limits.** A passage is limited to `bible.max_verses_per_passage` verses (default 6).
- **No redistribution.** Verse text lives in the cache and on the timeline. A Cue Document
  contains verse text, so share it only where the translation's licence allows.

## Privacy

Transcription is entirely local. The audio never leaves the machine, and the sidecar listens
only on the loopback interface (`127.0.0.1`), behind a token generated for each launch. The only
outbound traffic VerseSync is designed to send is verse **references** (for example `John 3:16`)
to a Bible text provider, never audio, transcripts or timeline contents. The sidecar as shipped
uses the bundled King James Version and sends nothing at all. The API key, when one is used, is
read from an environment variable and is never written to the config, the Cue Document or the
log.

## Performance

Measured in the build container, which is **not** the reference workstation. They show that the
code sits well inside the NFR-2 budgets; the reference GPU and Premiere numbers are pending
T-35.H.

| Budget | Limit | Measured (container) |
|---|---|---|
| Detect, resolve and time a ~45-minute transcript | 15 s | 2.2 s |
| Hash a 4 GB media file | 1 s | 0.04 s |
| Cache-hit job, end to end over HTTP | 5 s | 0.10 s |
| Render 40 cues with 5 expanded | 300 ms | about 80 ms |
| One checkbox toggle | 16 ms | about 1.2 ms |

Details and the tests that enforce each budget: [`docs/qa/performance-results.md`](docs/qa/performance-results.md).

## Troubleshooting

The sidecar log is `%APPDATA%\VerseSync\logs\sidecar.log` (under `%VERSESYNC_HOME%` when that
is set). Check it first for any message below that says to. How to reproduce each row is in
[`docs/qa/error-reproduction.md`](docs/qa/error-reproduction.md).

### Messages from the sidecar

| You see | What to do |
|---|---|
| `The request body must be a JSON object.`, `The request body is not valid JSON.`, `The Content-Length header is invalid.`, `The request body is too large.`, `No such endpoint.`, `... is not allowed here.`, `A reference (text or object) is required.`, `The request needs a media_path.`, `The request needs a translation_id.`, `options must be a JSON object.` | A request the panel did not build correctly, so a panel and sidecar mismatch. Reinstall both from the same checkout and restart Premiere. If it persists, the log has the request. |
| `That media file is outside the folders VerseSync may read.` | Pick a file under one of `server.allowed_media_roots` in `config.yaml`. |
| `The media file could not be found: <path>` | Check that the drive is connected and the file has not moved. |
| `The media file could not be read: <path>` | Check that the file is not open in another program and that you can read it. |
| `The transcription model could not be loaded: <reason>` | Try a smaller `transcription.model`, or set `transcription.device: cpu`. |
| `The audio could not be transcribed: <reason>` | Check that the media file has an audio track, then try again. |
| `No Bible text provider is configured.` | Choose a Bible text provider in the VerseSync settings. |
| The provider's own message (provider unavailable) | Check your internet connection, or switch to a local Bible text. |
| The provider's own message (translation not licensed) | Choose a translation your Bible text provider is licensed to show. |
| `No job with id <id>`, `The result of that job is no longer available.` | Start the analysis again. |
| `Job <id> is <state>, not done.` | Wait for the job to finish. |
| `The job was cancelled.` | Nothing is wrong; you cancelled it. Analyse again if you want it. |
| `VerseSync did not accept this request's credentials.` | Restart VerseSync so the panel and the sidecar share a fresh token. |
| `Something went wrong inside VerseSync.` / `VerseSync hit an unexpected problem while analysing the media.` | Read the log for the cause, then try again. |

### Failures in the panel

| You see | What to do |
|---|---|
| Status strip `transcription service unavailable`, **Analyse** disabled | The sidecar did not start within 30 s. Open **Details** for the log path, read it, and check the venv is at `%APPDATA%\VerseSync\venv` (see [`docs/INSTALL.md`](docs/INSTALL.md)). A saved cue document can still be loaded and inserted meanwhile. |
| `The VerseSync sidecar is not responding.` | Check that the sidecar is running, then press **Retry**. |
| `Could not load <model> on <device>: ...` | Try the suggested precision, or switch to CPU, then **Retry**. |
| `The Bible text could not be fetched for some cues.` | The rows are kept, marked `text unavailable`. Press **Retry text fetch** once the provider is reachable. |
| Status strip `no sequence open` | Open a sequence in Premiere, then press **Refresh**. |
| `<file> isn't in this sequence.` | Enter the start timecode manually. Positions are then approximate if the audio was cut. |
| `No editable text fields were found in this template.` | Use a template authored in After Effects with its text layers exposed as Essential Graphics properties. |
| `Placed 17 of 18 - 1 failed, see details.` | Press **Retry failed** to insert only the failed cue. One Ctrl+Z reverts the whole batch. |
| `Unexpected error: <message>` | Read the log, then retry. |
| A request that stalls | After 60 s the panel reports the sidecar as unreachable, and a silent event stream is dropped after 60 s. Restart Premiere and check the log. |
