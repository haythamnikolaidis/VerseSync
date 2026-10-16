# T-06 · Upstream refactor: Qt-free transcription engine

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Repo** | ⚠️ **`haythamnikolaidis/Faster-Whisper-Transcriber`**, not this one |
| **Unblocks** | T-07.2 |
| **Spec** | [02-source-project-audit.md §2.2](../02-source-project-audit.md) (Gaps 1, 2, 5, 7) |

## Goal

Give the upstream transcriber a headless entry point that returns **word-level timestamps**, so
the sidecar can use it without a Qt event loop.

## Context

Today, `core/transcription/service.py` throws timing away, and the only entry point builds a
`QApplication`. This is a **PR against the upstream repo**. Keep it minimal and additive.
Upstream stays a dictation tool that happens to expose a good engine.

**Agent note:** attach the repo with `add_repo` (push access), work on a branch there, and open
the PR there. The commit-subject convention still applies (`T-06.1 [1/2] …`), so `plan.py` can
see progress. Because `plan.py` only scans *this* repo's remotes, add a status-only commit here
when the upstream PR merges.

## Subtasks

### T-06.1 · Extract `core/transcription/engine.py`

**Executor** agent · **Size** S · **Prereqs** T-44 · **Status** done

- **Read:** [02 §2.2](../02-source-project-audit.md) Gaps 1, 2 and 6 ·
  `reference/fwt/core/transcription/service.py`
- **Touches (upstream):** `core/transcription/engine.py` (new) · `tests/test_engine.py` (new)
- **Interface (upstream):**
  ```python
  @dataclass
  class Word: start: float; end: float; text: str; probability: float
  @dataclass
  class Transcript: words: list[Word]; language: str; duration: float
  def transcribe_with_words(model, audio_path, *, batch_size=None, vad_filter=True,
                            vad_parameters=None, initial_prompt=None, language=None,
                            temperature=0.0, condition_on_previous_text=True,
                            progress=None, cancel=None) -> Transcript
  ```
- **Steps:**
  1. Implement it with **no Qt imports**. Call `model.transcribe(..., word_timestamps=True)`
     and keep every `segment.words` entry, including its `probability`. Call
     `progress(segment.end / info.duration)` after each segment. Check `cancel()` between
     segments and raise `Cancelled` if it's set. Commit.
  2. Write a unit test with a fake model object that yields fake segments: words are kept,
     progress is monotonic, cancellation stops it, and importing the module doesn't import
     `PyQt*` or `PySide*` (assert on `sys.modules`). Commit.
- **Verify (upstream):** `pytest tests/test_engine.py -q`
- **Done when:**
  - [x] The engine runs with no `QApplication`, and its words carry `start`, `end`, `text` and
        `probability`.

### T-06.2 · Route `TranscriptionService` through the engine; delete dead code

**Executor** agent · **Size** S · **Prereqs** T-06.1 · **Status** todo

- **Read:** [02 §2.2](../02-source-project-audit.md) Gaps 5 and 7
- **Touches (upstream):** `core/transcription/service.py` · `core/models/metadata.py` ·
  `core/service.py` (deleted)
- **Steps:**
  1. Refactor `TranscriptionService` to call `transcribe_with_words` and join the word texts
     back into the text it returned before. Keep its behaviour identical. Commit.
  2. Delete `core/service.py`, after grepping to prove nothing imports it. Add
     `word_timestamp_quality` to `ModelMetadata`, seeded from
     `spikes/word_timestamps/RESULTS.md` §1 and §5 in *this* repo. Use `"unverified"` where the
     spike doesn't say. Commit. Open the upstream PR.
- **Verify (upstream):** the upstream test suite passes, and `python -c "import core.transcription.engine"`
  works with Qt uninstalled.
- **Done when:**
  - [ ] `core/service.py` is gone and nothing imports it.
  - [ ] The PR is open upstream, and its body says GUI parity needs T-06.H.

### T-06.H · Upstream GUI parity check

**Executor** human · **Size** — · **Prereqs** T-06.2 · **Status** todo

- On a Windows machine: record and transcribe in the upstream GUI, and confirm the behaviour is
  identical to before. Then merge the upstream PR, and tag the commit that the sidecar pins
  (T-07.2).

## Traps

- `core/cuda_setup.py` must run **before** any Qt import and before the model loads.
- Never enable `curate_text` on this path (Gap 8). It destroys the word-to-text correspondence.
