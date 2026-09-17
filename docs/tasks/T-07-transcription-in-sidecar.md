# T-07 · Transcription in the sidecar

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-05, T-06 · *T-02 for defaults only* |
| **Unblocks** | T-08, T-20 |
| **Spec** | [02 §2.2](../02-source-project-audit.md) · [04 §2](../04-reference-detection.md) · [05 §10](../05-timing-and-placement.md) |

## Goal

The sidecar turns a media file into a word array with `(text, start, end, probability)` per
word, reporting progress and cancellable mid-run.

## Context you need

You are wiring the upstream engine (T-06) into the sidecar, plus the four quality gaps upstream
deliberately left to us: decoder biasing (Gap 3), VAD and pinned language (Gap 4), the right
default model (Gap 5), and long-audio handling (Gap 6).

**Everything downstream consumes only the word array** — which is why streams C and E can work
from fixtures (T-41) and do not wait for this task.

## Steps

1. Call `core.cuda_setup` **first**, before anything else touches CUDA or loads a model.
2. Wire `load_model` and `transcribe_with_words` from T-06.
3. Set VerseSync's job defaults:
   - model per T-02's recommendation (expected `large-v3-turbo`; **not** the upstream
     `distil-whisper-large-v3` default)
   - `vad_filter=True` with tuned `vad_parameters`
   - `language="en"`, pinned but configurable
   - `initial_prompt` seeded per [04 §2](../04-reference-detection.md)
   - `temperature=0` and a fixed seed, per [05 §10](../05-timing-and-placement.md) — the
     pipeline must be deterministic
   - `curate_text` **off** (Gap 8)
4. Use `BatchedInferencePipeline` via the existing `batch_size` parameter (Gap 6).
5. Progress callback: segment end ÷ media duration, mapped into the `transcribing` phase weight
   (0.80) from [07 §4](../07-sidecar-api.md).
6. Cooperative cancellation — check a flag between segments.
7. Surface `model_load_failed` as a typed error with the VRAM numbers in the message, per
   [07 §3](../07-sidecar-api.md). This message is read by an editor: *"Could not load
   large-v3-turbo on cuda: out of memory (9.1 GB free, ~10.4 GB required)"*.

## Files

- `sidecar/versesync/transcribe.py`
- `tests/test_transcribe.py`

## Done when

- [ ] The CLI transcribes a 45-minute file and emits a word array.
- [ ] Progress is reported throughout and is monotonic.
- [ ] Cancellation takes effect within 5 s.
- [ ] Two runs on the same file produce **identical** output (determinism).
- [ ] A forced OOM produces `model_load_failed` with a useful, editor-readable message.

## Traps

- If T-02 has not reported yet, build against `large-v3-turbo` and leave the default in config
  — do not block, and do not inherit the upstream distil default by accident.
- Word `probability` must survive into the array; [04 §6](../04-reference-detection.md) scores
  confidence with it.
- A CPU-only run on 45 minutes of audio can exceed the length of the sermon (risk R-10). Warn,
  do not silently grind.
