# Performance results (container)

Measured in the build container, **container, not the reference workstation**. They show that
the code sits well inside the NFR-2 budgets ([01 NFR-2](../01-requirements.md)); the reference
GPU and Premiere numbers are recorded by T-35.H. Each budget is enforced by a test, so a
regression fails CI.

| Budget (NFR-2) | Limit | Measured | Test |
|---|---|---|---|
| Detect, resolve and time a ~45-minute transcript (longest fixture x6) | 15 s | 2.2 s | `tests/test_performance.py::test_pipeline_on_45_minute_transcript_within_budget` |
| `hash_media` on a 4 GB sparse file | 1 s | 0.04 s | `tests/test_performance.py::test_hash_media_on_4gb_sparse_file_is_fast` |
| Cache-hit job, end to end over HTTP (fixture backend) | 5 s | 0.10 s | `tests/test_performance.py::test_cache_hit_job_over_http_within_budget` |
| Render 40 cues with 5 expanded (jsdom) | 300 ms | about 80 ms | `tests/panel/performance.test.js` |
| One checkbox toggle (jsdom) | 16 ms | about 1.2 ms | `tests/panel/performance.test.js` |

Reproduce with `pytest tests/test_performance.py -q --durations=5` and
`node --test tests/panel/performance.test.js`.
