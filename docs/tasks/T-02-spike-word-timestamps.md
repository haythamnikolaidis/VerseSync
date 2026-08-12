# T-02 · Spike: word-level timestamps on real sermon audio

| | |
|---|---|
| **Workstream** | S — Spikes |
| **Wave** | 0 |
| **Estimate** | M |
| **Prereqs** | T-01 |
| **Unblocks** | T-07 (default model/VAD/prompt choice only) |
| **Spec** | [04-reference-detection.md §2](../04-reference-detection.md) · [05 §10](../05-timing-and-placement.md) · risk **R-5** in [12](../12-decisions-and-risks.md) |

## Goal

Know whether Faster-Whisper's word timestamps are accurate enough to support the product's
±0.5 s anchor promise (metric M3), and pick the default model, quantization, VAD settings and
prompt strategy on evidence rather than assumption.

## Context you need

Word timestamps come from **cross-attention alignment**, and its quality varies by model. The
current default in Faster-Whisper-Transcriber's `config.yaml` is `distil-whisper-large-v3` —
a distilled model with a reduced decoder whose alignment quality for this purpose is
**unverified** (Gap 5 in [02 §2.2](../02-source-project-audit.md)). Do not assume it is fine.

This spike is throwaway code. Its deliverable is a **written recommendation with numbers**.

## Steps

1. Hand-label the start time of **30 scripture mentions** across at least one sermon, to the
   frame. This is the ground truth; do it carefully, it is the whole spike.
2. Transcribe with `word_timestamps=True` across:
   - models: `large-v3`, `large-v3-turbo`, `distil-whisper-large-v3`
   - `vad_filter` on and off
3. Measure the error distribution of matched word starts against the labels. Report **p50 and
   p90**, not just the mean — the metric is "90% within 0.5 s".
4. A/B the `initial_prompt` from [04 §2](../04-reference-detection.md) for book-name accuracy.
   Count mishearings specifically: Philippians/Philippines, Habakkuk/have-a-cook,
   Titus/tight-us, Colossians/collations.
5. Settle `condition_on_previous_text` — it can cause drift over 45 minutes of audio.
6. Record transcription wall-time per model for NFR-2.

## Files

- `spikes/word_timestamps/` — scripts, raw measurements, and `RESULTS.md`

## Done when

- [ ] `RESULTS.md` recommends a default model, quantization, VAD setting and prompt strategy.
- [ ] It states the measured **p50 and p90 timestamp error** for each configuration.
- [ ] It states wall-time per model for a 45-minute file.
- [ ] Book-name mishearing counts with and without the prompt are recorded.

## Gate

**If p90 error exceeds ~0.5 s on the best configuration, stop and escalate.** The product
promise is not deliverable as specified. The options — all product decisions, not engineering
ones — are in [13 §9](../13-technical-plan.md): widen the tolerance, increase the lead-in, or
add a forced-alignment pass over the read span only.

## Traps

- Label against the audio, not against a transcript — you are measuring the transcript.
- Keep `temperature=0` and a fixed seed throughout, per [05 §10](../05-timing-and-placement.md),
  or your runs are not comparable.
- `curate_text` must be **off** (Gap 8) — it rewrites text after the fact and destroys the
  word-to-text correspondence you are measuring.
