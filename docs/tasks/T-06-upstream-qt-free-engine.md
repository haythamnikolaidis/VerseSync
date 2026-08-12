# T-06 · Upstream refactor: Qt-free transcription engine

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | none (independent of T-05 — can run first) |
| **Unblocks** | T-07 |
| **Spec** | [02-source-project-audit.md §2.2](../02-source-project-audit.md) (Gaps 1, 2, 5, 7) |
| **Repo** | ⚠️ **`haythamnikolaidis/Faster-Whisper-Transcriber`**, not this one |

## Goal

Give the upstream transcriber a headless entry point that returns **word-level timestamps**, so
the sidecar can use it without a Qt event loop.

## Context you need

Today `core/transcription/service.py` throws timing away entirely:

```python
for segment in segments:
    text_parts.append(segment.text)          # start/end discarded
```

…and the only entry point builds a `QApplication` and shows a window. VerseSync's entire premise
is timestamps, so both must change. These are **Gap 1 and Gap 2** in
[02 §2.2](../02-source-project-audit.md), and both are marked blocking.

This is a **PR against the upstream repo**. Keep it minimal and additive — upstream stays a
dictation tool that happens to expose a good engine.

## Steps

1. Extract `core/transcription/engine.py` with a pure function, no Qt imports and no signals:

   ```python
   def transcribe_with_words(model, audio_path, *, batch_size=None, vad_filter=True,
                             vad_parameters=None, initial_prompt=None, language=None,
                             temperature=0.0, progress=None) -> Transcript
   ```

2. Call `model.transcribe(..., word_timestamps=True)` and **retain `segment.words`** — each a
   `Word(start, end, word, probability)`. The probability feeds confidence scoring in
   [04 §6](../04-reference-detection.md), so do not drop it.
3. Support cooperative cancellation and a `progress` callback keyed on segment end ÷ total
   duration (Gap 6).
4. Refactor `TranscriptionService` to call the new function. **GUI behaviour must be
   identical** — this is the acceptance bar for the upstream maintainer.
5. Delete `core/service.py` (Gap 7) — it is dead code, near-identical to
   `core/transcription/service.py`, and having two paths to keep correct is a liability.
6. Add `word_timestamp_quality` to `ModelMetadata` (Gap 5) so the panel can warn when a model is
   a poor fit for this job. Seed values from T-02's measurements if available; `"unverified"`
   otherwise.

## Files (upstream repo)

- `core/transcription/engine.py` (new)
- `core/transcription/service.py`, `core/models/metadata.py` (modified)
- `core/service.py` (deleted)

## Done when

- [ ] The existing GUI behaves identically — record and transcribe still works end to end.
- [ ] `transcribe_with_words` runs from a plain script with **no `QApplication`**.
- [ ] Returned words carry `start`, `end`, `text` and `probability`.
- [ ] Cancellation takes effect within a few seconds.
- [ ] `core/service.py` is gone and nothing imports it.

## Traps

- `core/cuda_setup.py` must be called **before** any Qt import and before model loading —
  ordering matters upstream and will matter in T-07 too.
- Do not enable `curate_text` anywhere on this path (Gap 8). It re-tokenises and rejoins the
  text, destroying the one-to-one correspondence with the word list that every timestamp
  depends on.
- Resist scope creep. This is a refactor. Anything VerseSync-specific belongs in the sidecar.
