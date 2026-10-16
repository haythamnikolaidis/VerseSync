# T-07 · Transcription in the sidecar

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Unblocks** | T-08, T-20.2 |
| **Spec** | [02 §2.2](../02-source-project-audit.md) · [04 §2](../04-reference-detection.md) · [05 §10](../05-timing-and-placement.md) · `spikes/word_timestamps/RESULTS.md` §1 |

## Goal

The sidecar turns a media file into a `list[Word]`, reports progress, and can be cancelled
partway through. It does this behind a **backend interface**, so everything except one adapter
can be built and tested with no GPU.

## Context

**Everything downstream consumes only the word array.** The real faster-whisper backend
(T-07.2) is a thin adapter. Two more backends make the rest of the sidecar testable in CI:

- `FixtureBackend` replays a T-41 `*.words.json` (`transcription.backend: fixture:<path>`).
  T-42.2 uses it to run the **real** sidecar's contract tests with no GPU.
- `FakeBackend` is used in unit tests, with scripted words, delays and failures.

**Defaults, per T-02** (`spikes/word_timestamps/RESULTS.md` §1 and decision D19):

| Setting | Value |
|---------|-------|
| model | `distil-large-v3` |
| quantization | `float16` on CUDA |
| `vad_filter` | `True` |
| `initial_prompt` | `SCRIPTURE_PROMPT` ([04 §2](../04-reference-detection.md)) |
| `condition_on_previous_text` | `True` |
| `temperature` | `0` with no fallback ladder |
| `language` | `en` |

⚠️ The original T-07 card said "expected `large-v3-turbo`, **not** distil". **T-02 measured
otherwise, and its result wins.** The model stays configurable.

## Subtasks

### T-07.1 · `transcribe.py`: options, backend protocol, fixture and fake backends

**Executor** agent · **Size** S · **Prereqs** T-05.1, T-09.3 · **Status** done

- **Read:** [04 §2](../04-reference-detection.md) · [07 §4](../07-sidecar-api.md) (the
  `transcribing` weight) · `spikes/word_timestamps/RESULTS.md` §1 (the table only)
- **Touches:** `sidecar/versesync/transcribe.py` (new) · `sidecar/versesync/config.py` (fill in
  the `transcription` defaults) · `tests/test_transcribe.py` (new)
- **Interface:**
  ```python
  SCRIPTURE_PROMPT: str                       # verbatim from 04 §2
  @dataclass(frozen=True)
  class TranscribeOptions:
      model: str = "distil-large-v3"; device: str = "cuda"; quantization: str = "float16"
      batch_size: int | None = 8; language: str = "en"; vad_filter: bool = True
      vad_parameters: dict | None = None; initial_prompt: str | None = SCRIPTURE_PROMPT
      condition_on_previous_text: bool = True; temperature: float = 0.0
      def cache_key(self) -> dict            # every field that changes the transcript (T-08)
  class TranscriptionError(Exception): code: str; message: str; hint: str | None
  class Backend(Protocol):
      def transcribe(self, media_path: Path, opts: TranscribeOptions,
                     progress: Callable[[float], None], is_cancelled: Callable[[], bool]) -> tuple[list[Word], float]
      # returns (words, media_duration_s)
  def get_backend(config: Config) -> Backend     # 'faster_whisper' (default) | 'fixture:<path>' | 'fake'
  class FixtureBackend: ...                      # replays words; simulated progress; honours cancel
  ```
- **Steps:**
  1. Write the options, the error, the protocol, `get_backend`, `FixtureBackend` and a
     `FakeBackend` for tests. `faster_whisper` is imported lazily, only by T-07.2's adapter.
     Commit.
  2. Tests:
     - `FixtureBackend` returns the fixture's words and reports progress that never goes down
       and ends at 1.0;
     - cancellation raises `Cancelled` within one progress tick;
     - `cache_key` changes when the model changes and stays the same when nothing relevant
       does;
     - `SCRIPTURE_PROMPT` matches 04 §2 character for character.

     Commit.
- **Verify:** `pytest tests/test_transcribe.py -q`
- **Done when:**
  - [x] The defaults match the table above.
  - [x] The fixture backend can be selected through config.

### T-07.2 · faster-whisper adapter via the upstream engine

**Executor** agent · **Size** S · **Prereqs** T-07.1, T-06.2 · **Status** todo

- **Read:** [02 §2.2](../02-source-project-audit.md) Gaps 3–6 · `reference/fwt/core/cuda_setup.py`
- **Touches:** `pyproject.toml` (add an optional extra `transcribe` that pins the upstream
  package by git URL and the T-06 commit, plus `faster-whisper`) ·
  `sidecar/versesync/transcribe.py` · `tests/test_transcribe_fw.py` (new)
- **Steps:**
  1. Write `FasterWhisperBackend`.
     - Call `core.cuda_setup` **first**.
     - Load the model with the upstream `load_model` and call `transcribe_with_words`, using
       `BatchedInferencePipeline` through `batch_size`.
     - Map the progress callback.
     - `curate_text` is **never** enabled.
     - Model-load failures become `TranscriptionError(code="model_load_failed")`, with a
       message an editor can read, in this exact shape:
       `Could not load <model> on <device>: out of memory (<free> GB free, ~<need> GB required)`.
       Use the free and total VRAM from `torch.cuda.mem_get_info` when it's available.

     Commit.
  2. Write tests that **monkeypatch** the upstream module and `torch`, so they need no GPU:
     - the call order puts `cuda_setup` before `load_model`;
     - `curate_text` is never passed;
     - an OOM exception produces the exact message format.

     Commit.
- **Verify:** `pytest tests/test_transcribe_fw.py -q`
- **Done when:**
  - [ ] The adapter is covered with no GPU.
  - [ ] The OOM message matches the format above.

### T-07.H · GPU workstation verification

**Executor** human · **Size** — · **Prereqs** T-07.2 · **Status** todo

On the reference workstation, against a real 45-minute sermon:

- the CLI (`python -m versesync.cli analyse …`) produces a word array, and progress never goes
  down;
- cancelling takes effect within 5 s;
- two runs produce **identical** words;
- forcing an OOM (with a too-large model or batch) shows the `model_load_failed` message.

Record the results in `docs/qa/transcription-verification.md`.

## Traps

- A CPU-only run on 45 minutes of audio can take longer than the sermon itself (R-10). Warn
  about it; don't let it grind silently.
- The word `probability` has to survive into the array, because confidence scoring uses it.
