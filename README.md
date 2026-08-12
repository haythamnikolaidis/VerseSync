# VerseSync

Automatically add scriptures to your Adobe Premiere timeline.

VerseSync is a Premiere Pro panel that transcribes a sermon locally, finds every scripture
reference the speaker mentions or reads, fetches the verse text, and places each one on the
timeline as a Motion Graphics Template — at the exact frame where the speaker begins.

Two clicks: **Analyse**, review, **Insert**.

## Status

**Specification complete. No production code yet.**

The full product requirements and technical plan live in **[`docs/`](docs/)**. Start with
[`docs/README.md`](docs/README.md) for the index, or go straight to
[`docs/00-prd.md`](docs/00-prd.md).

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
