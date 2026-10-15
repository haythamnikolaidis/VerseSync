# T-44 · Vendor Faster-Whisper-Transcriber reference sources

**Executor** agent · **Size** XS · **Prereqs** T-43 · **Status** in-progress

| | |
|---|---|
| **Workstream** | 0 — Agent enablement |
| **Unblocks** | T-05.1, T-07.2, T-36.1 |
| **Spec** | [02-source-project-audit.md Part 2](../02-source-project-audit.md) |

## Goal

Make the transcriber code that the sidecar borrows from readable in this repository. That
covers the config pattern, CUDA setup ordering, model metadata and the installer.

## Steps

1. Attach `haythamnikolaidis/Faster-Whisper-Transcriber` with `add_repo` (read access). Clone
   it into the scratchpad and record the `main` SHA.
2. Copy these files, unmodified, into `reference/fwt/`, keeping their relative paths:
   `config/manager.py`, `config/config.yaml` (or the default config, wherever it lives),
   `core/cuda_setup.py`, `core/transcription/service.py`, `core/models/` (whole directory),
   `install.py`, and `requirements*.txt`. Find each file by name if the paths differ.
3. Add a "Faster-Whisper-Transcriber" section to `reference/README.md`, in the same format as
   T-43's. Commit: `T-44 [1/1] vendor transcriber sources`.

## Verify

`ls reference/fwt/core reference/fwt/config && ruff check sidecar tools tests`

## Done when

- [ ] The files are present and `reference/README.md` records the SHA.
- [ ] Nothing under `reference/` is linted or importable as a package (no `__init__.py` was
      added).
