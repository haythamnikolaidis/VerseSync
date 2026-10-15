# T-50 · Contract: transcript retrieval (`words_ref`)

**Executor** agent · **Size** S · **Prereqs** — · **Status** todo

| | |
|---|---|
| **Workstream** | 0 — Agent enablement (a contract change) |
| **Unblocks** | T-20.3, T-29.5, T-29.6 |
| **Spec** | [07 §2, §5.1](../07-sidecar-api.md) |

## Goal

Define **how** the panel gets the transcript words that `transcript.words_ref` points at. The
spec says *"the panel fetches it only when an editor expands a row"* but defines no endpoint and
no file-resolution rule. Without one, the expanded row's transcript context (T-29.6) can't be
built.

## Decision (D22, already recorded in [12](../12-decisions-and-risks.md))

- **A new endpoint:** `GET /jobs/{id}/transcript` (authenticated) returns the job's word array
  as a JSON array, in the shape of the T-41 `*.words.json` files:
  `[{"text","start","end","probability"}]`. If the job isn't done, it returns
  `409 job_not_finished`.
- **For a document loaded from disk:** `words_ref` is resolved relative to the directory of the
  loaded `.json` file. If that file is missing, the expanded row says
  *"Transcript not available for this document."*. It doesn't fail.
- **Save cue document** also writes the transcript sibling next to the saved file, under the
  same `words_ref` name, so a saved document stays self-contained.
- The API version stays `1.0`, because adding an endpoint is a minor change and nothing
  depended on its absence. Record that in 07.

## Steps

1. **Spec.** Add the endpoint to [07 §2](../07-sidecar-api.md) and the resolution rules to the
   [07 §5.1](../07-sidecar-api.md) `words_ref` note, citing D22. Commit: `T-50 [1/3] spec`.
2. **Mock.** Add the endpoint to `tools/mock_sidecar.py`. For a done job, it returns a
   deterministic synthetic word array that's long enough to cover the highest `word_span`
   index in the served fixture. Words are `"word<i>"`, at 0.4 s per word from 0, with
   probability `0.95`. Otherwise it returns `409`. Document it in `tools/README.md`. Commit:
   `T-50 [2/3] mock`.
3. **Tests.** Add a mock test (in whichever existing Python test module covers the mock, or a
   new `tests/test_mock_transcript.py`): the endpoint returns `409` before the job is done, then
   an array whose length is greater than the maximum `word_span[1]`. Commit:
   `T-50 [3/3] tests`.

## Verify

`pytest -q -k transcript`

## Done when

- [ ] 07 describes D22.
- [ ] The mock serves the endpoint.
- [ ] The mock test passes. T-42.1's card already asserts this endpoint, so nothing changes
      there.
