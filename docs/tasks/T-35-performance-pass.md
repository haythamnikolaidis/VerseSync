# T-35 · Performance pass

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | T-36.3, release |
| **Spec** | [01-requirements.md](../01-requirements.md) NFR-2 · [00-prd.md §5](../00-prd.md) (M4) |

## Goal

Verify NFR-2 and record the measured numbers. Where a number can be measured in the container,
the agent measures it there. GPU and Premiere numbers are measured by a human.

## Subtasks

### T-35.1 · Container-measurable budgets as tests

**Executor** agent · **Size** S · **Prereqs** T-30.2, T-21.1 · **Status** done

- **Read:** NFR-2 in [01](../01-requirements.md)
- **Touches:** `tests/test_performance.py` (new) · `tests/panel/performance.test.js` (new) ·
  `docs/qa/performance-results.md` (new)
- **Steps:**
  1. Python budget tests, marked `@pytest.mark.perf` but run by default because they're
     cheap:
     - the pipeline (detect, resolve, time) on the longest fixture, scaled ×6 to about 45
       minutes of words, finishes in **15 s or less**;
     - `hash_media` on a 4 GB sparse file takes under 1 s;
     - a cache-hit job, end to end over HTTP with the fixture backend, takes under 5 s.

     Commit.
  2. Panel budget test (jsdom): rendering 40 cues with 5 expanded takes under 300 ms, and a
     checkbox toggle takes under 16 ms. Write the measured values into
     `docs/qa/performance-results.md`, labelled **container, not the reference workstation**.
     Commit.
- **Verify:** `pytest tests/test_performance.py -q && node --test tests/panel/performance.test.js`
- **Done when:**
  - [x] Every container-measurable budget is enforced by a test.

### T-35.H · Reference workstation numbers

**Executor** human · **Size** — · **Prereqs** T-35.1, T-30.H · **Status** todo

On the reference workstation, with a real 45-minute sermon:

- transcription takes **4 min or less**, including a cold start with model load;
- a cached re-run takes **5 s or less**;
- a 40-cue insert doesn't freeze the panel;
- record the `VS.getMediaSegments` walk time on the longest sequence;
- record a **CPU-only** figure, and set the panel's CPU warning threshold from it (R-10);
- tune `batch_size` and record the VRAM headroom.

Record everything, with the machine spec, in `docs/qa/performance-results.md`.
