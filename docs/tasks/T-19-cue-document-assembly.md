# T-19 · Cue Document assembly and the pipeline

| | |
|---|---|
| **Workstream** | E — Timing |
| **Unblocks** | T-20, T-21, T-33 |
| **Spec** | [07-sidecar-api.md §5](../07-sidecar-api.md) · `schemas/cue-document.schema.json` |

## Goal

Turn detections, resolutions, alignments and timings into a **schema-valid Cue Document**.
Then expose `run_pipeline(words, …)`: the **one** function that the HTTP service (T-20) and the
CLI (T-21) both call.

## Context

T-37 froze the schema and the golden fixtures, and the panel was built against them. **Conform
to them; don't redesign them.** If the schema looks wrong, mark the task blocked
([AGENT.md §4](AGENT.md)).

## Subtasks

### T-19.1 · Cue builder

**Executor** agent · **Size** S · **Prereqs** T-18, T-48.2 · **Status** done

- **Read:** [07 §5, §5.1](../07-sidecar-api.md) · [09 §5.2](../09-ui-spec.md) (the flags table,
  for `enabled` defaults) · print one cue from `tests/fixtures/cue-documents/happy-18-cues.json`
  with `python -c` to see the exact key order
- **Touches:** `sidecar/versesync/cues.py` (new) · `tests/test_cues.py` (new)
- **Interface:**
  ```python
  LOW_CONFIDENCE_THRESHOLD = 0.55
  DISABLED_BY_DEFAULT = frozenset({"text_unavailable", "passage_not_found", "chapter_only",
                                   "suppressed_duplicate"})       # sidecar-owned subset of 09 §5.2
  def build_cue(index: int, det: Detection, res: Resolution, alignment: Alignment | None,
                timing: Timing, translation: Translation, canon: Canon) -> dict
  ```
- **Steps:**
  1. Write `build_cue`.
     - `id` is `cue_{index:03d}`, and `origin` is `"detected"`.
     - Flags are the detection's flags, then the resolution's flags, then `low_confidence`
       when `timing.confidence < LOW_CONFIDENCE_THRESHOLD`. Order them as the schema enum
       does, with no duplicates.
     - `enabled` is false when any flag is in `DISABLED_BY_DEFAULT`.
     - `reference_display` is `Reference.display` + ` (ABBR)`. `body` is the passage body, or
       `""` when there's no passage.
     - Fill in `detection` (the pattern, `contextual`, `book_match`, `token_span` and
       `word_span`).
     - Build `alternatives` from the detection's alternatives, using `body` `""` (the panel
       re-resolves when the editor switches).

     **Never** emit `cut_from_edit`, `multiple_placements` or `speed_change_unsupported`.
     Commit.
  2. Tests:
     - each cue validates against the schema's `cue` definition;
     - a chapter-only cue is disabled, has an empty body, and uses the fixed duration;
     - confidence 0.5 is flagged `low_confidence`, and confidence 0.5 + 0.10 corroboration is
       not;
     - none of the three panel-owned flags ever appears.

     Commit.
- **Verify:** `pytest tests/test_cues.py -q`
- **Done when:**
  - [x] Every built cue is schema-valid.
  - [x] The `enabled` defaults match the 09 §5.2 table for sidecar flags.

### T-19.2 · Document assembly, sibling transcript, validation in the code path

**Executor** agent · **Size** S · **Prereqs** T-19.1 · **Status** in-progress

- **Read:** [07 §5, §5.2](../07-sidecar-api.md) · `tools/validate_cue_document.py` (its public
  function only)
- **Touches:** `pyproject.toml` (move `jsonschema` from dev to runtime `dependencies`) ·
  `sidecar/versesync/cues.py` · `tests/test_cue_document.py` (new)
- **Interface:**
  ```python
  SCHEMA_VERSION = "1.0"
  class InvalidCueDocument(Exception): ...
  def build_document(*, job: dict, translation: Translation, cues: list[dict],
                     warnings: list[dict], word_count: int, words_ref: str, generated_at: str) -> dict
  def validate_document(doc: dict) -> None          # raises InvalidCueDocument; loads the schema once
  def write_document(doc: dict, words: Sequence[Word], out_path: Path) -> None
      # writes out_path and the sibling <words_ref> next to it; JSON with sort_keys=False, indent=1, UTF-8
  def read_document(path: Path) -> dict
  ```
- **Steps:**
  1. Implement these. `build_document` calls `validate_document` before it returns, so a
     malformed document never leaves the module. The schema is found at
     `<repo>/schemas/cue-document.schema.json` during development. Also add the schema to the
     package data (`sidecar/versesync/data/cue-document.schema.json`, kept in sync by a test
     comparing the two files byte for byte), so an installed sidecar can find it. Commit.
  2. Tests:
     - a document validates;
     - removing a required key raises `InvalidCueDocument`;
     - write → read round-trips identically;
     - the transcript goes to a sibling file and isn't inlined;
     - the two schema copies are identical.

     Commit.
- **Verify:** `pytest tests/test_cue_document.py -q`
- **Done when:**
  - [ ] Validation happens in the code path, not only in tests.
  - [ ] The round-trip is lossless.

### T-19.3 · `run_pipeline()`: words to Cue Document, offline

**Executor** agent · **Size** S · **Prereqs** T-19.2 · **Status** todo

- **Read:** [07 §4](../07-sidecar-api.md) (the phase names) · [05 §10](../05-timing-and-placement.md)
- **Touches:** `sidecar/versesync/pipeline.py` (new) · `tests/test_pipeline.py` (new)
- **Interface:**
  ```python
  @dataclass(frozen=True)
  class PipelineConfig:
      detect: DetectConfig = DetectConfig(); align: AlignConfig = AlignConfig()
      timing: TimingConfig = TimingConfig(); max_verses: int = 6
  PhaseCallback = Callable[[str, float, str | None], None]   # (phase, fraction 0..1, message)
  class Cancelled(Exception): ...
  def run_pipeline(words: Sequence[Word], *, translation: Translation, provider: BibleProvider,
                   job: dict, generated_at: str, cfg: PipelineConfig = PipelineConfig(),
                   on_phase: PhaseCallback | None = None,
                   is_cancelled: Callable[[], bool] = lambda: False) -> dict
  ```
- **Steps:**
  1. Implement the phases in order: `detecting` → `resolving` → `timing`.
     - Call `on_phase` with fractions inside each phase.
     - Check `is_cancelled()` between phases and between cues. If it's true, raise `Cancelled`.
     - `words_ref` is `f"transcript_{job['id']}.json"`.

     Commit.
  2. Tests, run over every T-41 fixture with `LocalProvider`:
     - the document is schema-valid;
     - two runs give byte-identical JSON;
     - phases are reported in order, and their fractions never go down;
     - cancelling partway raises `Cancelled`;
     - every fixture finishes in under 15 s in total (the NFR-2 pipeline budget).

     Commit.
- **Verify:** `pytest tests/test_pipeline.py -q`
- **Done when:**
  - [ ] Every fixture produces a schema-valid, deterministic document.
  - [ ] This is the **only** place the stages are joined. T-20 and T-21 call it.

## Traps

- **All times are source seconds.** Sequence ticks are never persisted. That's what keeps a
  saved Cue Document valid across a recut.
- Panel-owned flags are never emitted here.
