# Reference sources

Read-only copies of code from other repositories. They are never deployed, linted or
imported. Ports copy code out of them; nothing refers to them at runtime.

## reference/verseflow/

- Source repo: `haythamnikolaidis/VerseFlow`
- Commit: `aa7b9159af6fc215066c501a92f9b07596cf73ae` (`aa7b915`)
- Vendored: 2026-10-15

Files are byte-identical to the source commit and keep their relative paths.

| File | Description |
|---|---|
| `verseflow/jsx/VerseFlow.jsx` | ExtendScript host code that runs inside Premiere Pro. |
| `verseflow/js/bridge.js` | Panel-side bridge that calls host functions through CSInterface. |
| `verseflow/js/duration.js` | Duration constants and helpers. |
| `verseflow/js/state.js` | Panel state container. |
| `verseflow/js/scripture-parser.js` | Scripture reference parser. |
| `verseflow/js/lib/CSInterface.js` | Adobe CSInterface library for CEP panels. |
| `verseflow/css/style.css` | Panel stylesheet. |
| `verseflow/CSXS/manifest.xml` | CEP extension manifest. |
| `verseflow/index.html` | Panel entry page. |
| `verseflow/docs/planning/02-adobe-research.md` | Notes on Adobe CEP and Premiere scripting behaviour. |
| `verseflow/README.md` | VerseFlow project readme. |

## reference/fwt/

- Source repo: `haythamnikolaidis/Faster-Whisper-Transcriber`
- Commit: `8d46a0986e27b14135ccb63b7fd6683ad950dbac` (`8d46a09`)
- Vendored: 2026-10-15

Files are byte-identical to the source commit and keep their relative paths. The source repo has
no `requirements*.txt`, so none is vendored. `core/models/__init__.py` is part of the copied
directory and is not an addition of this repo.

| File | Description |
|---|---|
| `fwt/config/manager.py` | Config load, merge and save pattern. |
| `fwt/config.yaml` | Default configuration. |
| `fwt/core/cuda_setup.py` | CUDA setup ordering. |
| `fwt/core/transcription/service.py` | Transcription service around faster-whisper. |
| `fwt/core/models/` | Model loader, manager and metadata. |
| `fwt/install.py` | Installer. |
