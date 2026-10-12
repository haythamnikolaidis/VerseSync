# T-06 · Qt-free transcription engine (ported into the sidecar)

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-05 (the sidecar package exists) |
| **Unblocks** | T-07 |
| **Spec** | [02-source-project-audit.md §2.2](../02-source-project-audit.md) (Gaps 1, 2, 5, 7) |
| **Repo** | This repo. The engine is ported from `haythamnikolaidis/Faster-Whisper-Transcriber` @ `8d46a09` (read-only reference); nothing is changed upstream. |

## Goal

Give the sidecar a headless transcription engine that returns **word-level timestamps** and
needs no Qt event loop. Per owner decision 5 it is built inside `sidecar/versesync/engine/` by
porting the relevant upstream code, not contributed upstream as a PR.

## Context you need

Upstream's `core/transcription/service.py` throws timing away entirely:

```python
for segment in segments:
    text_parts.append(segment.text)          # start/end discarded
```

…and its only entry point builds a `QApplication` and shows a window. VerseSync's entire premise
is timestamps, so the ported engine keeps them and has no GUI dependency. These are **Gap 1 and
Gap 2** in [02 §2.2](../02-source-project-audit.md), and both are marked blocking.

## Steps

1. Port into `sidecar/versesync/engine/` from upstream `core/transcription`,
   `core/cuda_setup.py`, `core/models/metadata.py`, `core/models/loader.py` and
   `core/quantization.py`. Keep attribution in the module headers. No Qt imports anywhere.
2. `transcribe.py`: a pure function, no signals:

   ```python
   def transcribe_with_words(model, audio_path, *, batch_size=None, vad_filter=True,
                             vad_parameters=None, initial_prompt=None, language=None,
                             temperature=0.0, condition_on_previous_text=True,
                             progress=None, cancel=None) -> Transcript
   ```

3. Call `model.transcribe(..., word_timestamps=True)` and **retain `segment.words`** — each a
   `Word(text, start, end, probability)`. The probability feeds confidence scoring in
   [04 §6](../04-reference-detection.md), so it is not dropped.
4. Support cooperative cancellation (`cancel` polled between segments) and a `progress`
   callback keyed on segment end ÷ total duration (Gap 6).
5. Do not port `core/service.py` (Gap 7) or the Qt `TranscriptionService`.
6. Add `word_timestamp_quality` to `ModelInfo` (Gap 5) so the panel can warn when a model is a
   poor fit. Seeded from T-02's measurements (`good`), `"unverified"` otherwise.

## Files

- `sidecar/versesync/engine/` — `transcribe.py`, `types.py`, `errors.py`, `loader.py`,
  `cuda_setup.py`, `metadata.py`, `quantization.py`
- `tests/test_engine.py` (injected fake model; no weights are downloaded)
- `pyproject.toml` — `faster-whisper`, `psutil`

## Done when

- [ ] ~~The existing GUI behaves identically.~~ Not applicable after owner decision 5: upstream is not modified.
- [ ] `transcribe_with_words` runs from a plain script with **no `QApplication`**.
- [ ] Returned words carry `start`, `end`, `text` and `probability`.
- [ ] Cancellation takes effect within a few seconds.
- [ ] No Qt code is present in the engine and nothing imports `core/service.py`.

## Traps

- `setup_cuda_if_available()` must be called **before** `faster_whisper` / `ctranslate2` is
  imported and before model loading. The engine imports both lazily to allow this; T-07 must
  call it first.
- Do not enable `curate_text` anywhere on this path (Gap 8). It re-tokenises and rejoins the
  text, destroying the one-to-one correspondence with the word list that every timestamp
  depends on.
- Resist scope creep. Anything VerseSync-specific (defaults, prompt, job handling) belongs in
  T-07 and later.

## Status

- **Not applicable** — "The existing GUI behaves identically": the upstream project is not
  modified after owner decision 5, so there is no upstream GUI behaviour to preserve.
- **Met** — "`transcribe_with_words` runs from a plain script with no `QApplication`":
  `tests/test_engine.py::test_engine_runs_without_qt` runs it in a fresh interpreter and
  asserts that no Qt module and no `faster_whisper` module was imported.
- **Met** — "Returned words carry `start`, `end`, `text` and `probability`":
  `test_words_carry_start_end_text_probability` (against a fake model; also covers skipping
  words without timing and blank words).
- **Met** — "Cancellation takes effect within a few seconds": the check runs before decoding
  and between segments (`test_cancel_stops_between_segments`,
  `test_cancel_before_start_never_calls_the_model`), so latency is one segment's decode time.
  **Deferred — needs a GPU and real audio** to measure that latency: run `transcribe_with_words`
  with a real model on a long file, set the cancel flag from another thread, and time the
  exception.
- **Met** — "No Qt code in the engine; nothing imports `core/service.py`":
  `test_no_qt_imports_in_source` scans the package; `core/service.py` was not ported.
