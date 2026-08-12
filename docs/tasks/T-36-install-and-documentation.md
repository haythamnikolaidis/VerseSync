# T-36 · Install and documentation

| | |
|---|---|
| **Workstream** | H — Quality & release |
| **Wave** | 3 |
| **Estimate** | M |
| **Prereqs** | T-30, T-35 |
| **Unblocks** | release |
| **Spec** | [06 §5](../06-bible-text-service.md) · [02 §2.1](../02-source-project-audit.md) · VerseFlow `README.md` |

## Goal

A clean Windows workstation goes from nothing to a completed Journey A using **only the
README**.

## Context you need

Risk R-9 is that the two-process design strands a non-technical user. The install is the first
place that risk shows up — the editor's mental model is "copy a folder", and we are asking for a
Python environment as well. It has to be one command.

## Steps

1. **Sidecar installer** following `Faster-Whisper-Transcriber`'s `install.py` **pinned-wheel
   pattern**: pinned wheels per Python version (cp311/312/313), GPU vs CPU torch, CUDA runtime
   pins. Do not invent a new approach — that pattern is proven on these machines.
2. **Panel install** per VerseFlow's debug-mode instructions: the `PlayerDebugMode` registry
   keys for CSXS 11 and 12, and copying to
   `%APPDATA%\Adobe\CEP\extensions\VerseSync`.
3. **README** covering:
   - both installs, start to finish
   - the config file and every option
   - **credentials** — where the Bible API key goes, and that it never leaves the machine except
     as a verse-reference request
   - the **licensing obligations** from [06 §5](../06-bible-text-service.md), including required
     attribution text per translation
   - the **privacy statement**: transcription is entirely local; the only outbound traffic is
     verse *references*, never audio and never transcript text (risk R-12, NFR-4)
   - the measured performance numbers from T-35 with the reference spec
   - troubleshooting for each failure state, with the sidecar log path
4. Verify on a **genuinely clean** machine — no Python, no CUDA, no prior Adobe extensions.

## Files

- `install.py`, `README.md`, `docs/INSTALL.md`

## Done when

- [ ] A clean Windows workstation reaches a completed Journey A using only the README.
- [ ] The installer handles both GPU and CPU-only machines.
- [ ] Attribution requirements per translation are documented.
- [ ] The privacy statement is present and accurate.
- [ ] Every failure state has a troubleshooting entry with the log path.

## Traps

- "Clean machine" means clean. Testing on a dev box with CUDA already installed proves nothing,
  and the CUDA path is exactly where installs break.
- Attribution is a **licensing obligation**, not documentation polish
  ([06 §5](../06-bible-text-service.md)). Some translations require specific wording on screen or
  in the product.
- Note that VerseFlow's README went stale about its own file layout
  ([02 §1.3](../02-source-project-audit.md)). Document what the code does, and re-check at
  release.
