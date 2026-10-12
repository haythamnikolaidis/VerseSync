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

You are wiring the in-repo engine (T-06, `versesync.engine`) into the sidecar, plus the four quality gaps the ported
engine deliberately leaves to us: decoder biasing (Gap 3), VAD and pinned language (Gap 4), the right
default model (Gap 5), and long-audio handling (Gap 6).

**Everything downstream consumes only the word array** — which is why streams C and E can work
from fixtures (T-41) and do not wait for this task.

## Steps

1. Call `core.cuda_setup` **first**, before anything else touches CUDA or loads a model.
2. Wire `load_model` and `transcribe_with_words` from T-06.
3. Set VerseSync's job defaults:
   - model `distil-large-v3` at `float16`, per T-02's recommendation (owner decision 3,
     [12](../12-decisions-and-risks.md) R-5); **not** the upstream `distil-whisper-large-v3`
     conversion, which stays `unverified`
   - `condition_on_previous_text=True`
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
   large-v3 on cuda: out of memory (9.1 GB free, ~10.4 GB required)"*.

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

- T-02 has reported: the default is `distil-large-v3` and lives in config. Do not inherit the
  upstream `distil-whisper-large-v3` default by accident (a different, unverified conversion).
- Word `probability` must survive into the array; [04 §6](../04-reference-detection.md) scores
  confidence with it.
- A CPU-only run on 45 minutes of audio can exceed the length of the sermon (risk R-10). Warn,
  do not silently grind.

## Status

- [ ] **Deferred — needs a GPU workstation and a 45-minute sermon file.** The CLI path
  (`python -m versesync.transcribe MEDIA`) and the word array are covered against a fake model
  by `tests/test_transcribe.py::test_45_minute_fake_run_emits_every_word_with_probability` and
  `test_cli_prints_the_word_array`. To verify: install the sidecar, run
  `python -m versesync.transcribe path/to/sermon.wav > words.json`, and check `words.json` holds
  a `words` array of `{text, start, end, probability}`.
- [x] **Met (against a fake)** — progress is monotonic and mapped into the 0.80 transcribing
  weight: `test_progress_is_monotonic_and_mapped_into_the_transcribing_weight`,
  `test_overall_progress_weights_and_cache_hit_renormalisation`. Real-audio monotonicity is
  covered by the same code path; confirm during the 45-minute run above (stderr `progress` lines
  never decrease).
- [ ] **Deferred — needs the GPU run.** Cancellation latency is bounded by one segment's decode
  time; `test_cancel_takes_effect_within_five_seconds` proves the control flow against a fake with
  slow segments. To verify: start the CLI on the sermon, send Ctrl+C-equivalent via the job
  cancel (T-08) and time from request to exit; it must be under 5 s with batch size 8.
- [ ] **Deferred — needs the GPU run.** Determinism is enforced by construction
  (`temperature=0.0`, seeded RNGs, no curation) and `test_two_runs_are_identical` passes against
  a fake. To verify: run the CLI twice on the same file and `diff` the two JSON outputs; they
  must be byte-identical.
- [x] **Met** — a forced OOM produces `model_load_failed` with an editor-readable message:
  `test_forced_oom_gives_an_editor_readable_message`. The "required" figure is the 10.4 GB
  planning figure for large-v3 float16 from [07 §3](../07-sidecar-api.md); other combinations
  omit it. Real VRAM numbers per model are Deferred — needs a GPU: load each model at float16
  and read `nvidia-smi` before and after, then extend the table in `transcribe.py`.

Other open items needing hardware or network access: `vad_parameters` is left `null`
(faster-whisper's Silero defaults, which spike T-02 measured with) because no tuning
measurement exists; the 224-token prompt budget is checked only with a word/punctuation
estimate because the Whisper tokenizer cannot be downloaded here (verify by encoding
`SCRIPTURE_PROMPT` with the model's tokenizer); and batched inference changes the decode path
(`condition_on_previous_text` does not apply there), which the spike did not measure.
