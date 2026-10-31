# Transcription verification (T-07.H)

Run 2026-10-31 on the reference workstation: Windows 11, RTX 3080 Ti (12 GB), NVIDIA driver
617.42, torch 2.9.0+cu128, faster-whisper 1.2.1, ctranslate2 4.8.3, `distil-large-v3` float16
on CUDA, batch 8. Media: the 2026-10-25 lapel WAV (`03-Pastor Lapel-261025_0933.wav`),
**2 h 03 min** long, with about 76 minutes of silence before the sermon starts. This is how
the church records, so it is a harder case than the 45-minute sermon the task asks for.

The CLI ran `python -m versesync.cli analyse`. Progress, determinism and cancel ran against the
sidecar over HTTP (`POST /jobs` with `use_cache: false`, polling `GET /jobs/{id}` every
0.25 s), because the CLI shows no progress and cannot be cancelled.

| Check | Result |
|---|---|
| The CLI produces a word array | **Pass.** 34 cues and 5,159 words, from 4581.9 s to 6540.6 s (about 33 minutes of speech). Every word carries `probability`, and the start times are in order. Wall time **36 s** (31 s with the model already downloaded). |
| Progress never goes down | **Pass.** 0 decreases across 113 and 100 samples over two runs. |
| Cancelling takes effect within 5 s | **Pass.** `DELETE /jobs/{id}` at 54% through transcription: `cancelled` after **0.97 s**. |
| Two runs produce identical words | **Pass.** Both cache-off runs returned the same 5,159 words, timestamps and probabilities included. |
| A forced OOM shows the `model_load_failed` message | **Not reproducible on this workstation.** With 10.5 GB of VRAM held by another process (0.34 GB free) and a cold transcript cache, the run still succeeded, in 38 s against 31 s clean. The Windows driver's *CUDA Sysmem Fallback Policy* (default since driver 536) spills into shared system memory instead of failing the allocation. The message format is covered by `test_transcribe_fw.py`. Accepted on 2026-10-31. |

## Findings

- **The `transcribe` extra was missing two pins, and transcription failed out of the box.**
  - The upstream `core.models.loader` imports `psutil`, but its package doesn't declare it.
  - faster-whisper 1.2.1 calls `av.open(..., metadata_errors=...)`, which PyAV 19 rejects
    (`open() got an unexpected keyword argument 'metadata_errors'`).

  `pyproject.toml` now pins `av==12.3.0` (the T-02 spike's version) and adds `psutil`.
- **`backend_unavailable` hid the real cause.** A single missing transitive import was reported
  as "not installed in this build". The message now names the missing module.
- **On Windows, low VRAM makes the run slower instead of failing.** Editors on smaller GPUs
  should expect a slow run, not the OOM message. The message still applies on Linux, and on
  Windows when the fallback policy is set to *Prefer No Sysmem Fallback*.
- **Progress stays at 2% for about 20 s at the start** on this file, then jumps to 54%. That is
  the model load plus the speech detector working through the leading silence before the first
  segment comes back. Progress never goes backwards, but the bar looks stuck. Worth a
  "Loading model / scanning audio" message if editors report it.
- **The CLI has no cache switch.** A second `analyse` on the same file reuses the cached
  transcript, so a check that needs a cold run has to set `VERSESYNC_HOME` to an empty folder.
