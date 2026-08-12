# T-08 · Content hashing and transcript cache

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Wave** | 1 |
| **Estimate** | S |
| **Prereqs** | T-07 |
| **Unblocks** | T-20, T-31 |
| **Spec** | [03 §4](../03-architecture.md) · decision **D17** in [12](../12-decisions-and-risks.md) |

## Goal

Transcribe each media file once. A second run on the same file returns in seconds — this is
what makes Journey B (the re-run after a recut) cheap, and Journey B is half the product's
value.

## Context you need

Full-hashing a 4 GB MXF on every run is unacceptable. **D17** chose a composite key: SHA-256
over the **first 8 MB + last 8 MB + file size**. That is fast and still distinguishes different
edits of the same recording.

## Steps

1. `hash_media(path) -> str` implementing D17. Return in the `sha256:…` form used by
   `job.media_hash` in [07 §5](../07-sidecar-api.md).
2. Cache the word array on disk keyed by the media hash **plus every option that would change
   the transcript** — model, quantization, device, language, VAD settings, `initial_prompt`,
   `batch_size`.
3. Invalidate correctly: changing any of those options must miss; changing an option that only
   affects detection or timing (e.g. `context_window_s`) must **hit**.
4. Report `cache_hit` in the `POST /jobs` response ([07 §2](../07-sidecar-api.md)).
5. On a cache hit, skip the `transcribing` phase and renormalise the remaining phase weights
   ([07 §4](../07-sidecar-api.md)) so the progress bar still ends at 1.0.
6. Honour the `use_cache: false` option for forced re-transcription.

## Files

- `sidecar/versesync/cache.py`
- `tests/test_cache.py`

## Done when

- [ ] A second run on the same file returns in **< 2 s** with `cache_hit: true`.
- [ ] Changing the model misses; changing `context_window_s` hits.
- [ ] `use_cache: false` forces a re-transcription.
- [ ] Hashing a 4 GB file takes well under a second.

## Traps

- Two different sermons of identical length recorded on the same camera can share head bytes —
  the **last** 8 MB and the size are what disambiguate them. Include all three.
- Do not cache to a temp directory that gets cleaned between runs; the whole point is
  persistence across sessions.
