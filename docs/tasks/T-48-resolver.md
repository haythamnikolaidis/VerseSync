# T-48 · Resolver and reference parsing

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Unblocks** | T-19.3 (the pipeline), T-20.5 (`POST /resolve`), T-21.1 (CLI `resolve`) |
| **Spec** | [06 §3.2, §4, §5](../06-bible-text-service.md) · [07 §2 `POST /resolve`](../07-sidecar-api.md) |

## Goal

The **resolving phase**. It turns a job's detections into passages, or into the right flags,
without ever failing the job. It also parses the reference strings that editors type.

## Context

This work was **unowned** in the original backlog. T-15 mentions batching, and T-20 has a
"resolving" phase, but no task owned the piece that maps provider errors to cue flags, enforces
`max_verses_per_passage` (the `long_passage` flag), skips chapter-only references, or emits the
`provider_partial` warning. The plan rework split it out on its own.

## Subtasks

### T-48.1 · `parse_reference()` for editor-typed references

**Executor** agent · **Size** XS · **Prereqs** T-13.3 · **Status** done

- **Read:** [07 §2](../07-sidecar-api.md) (`POST /resolve`) · [09 §5.3](../09-ui-spec.md) (the
  reference field)
- **Touches:** `sidecar/versesync/detect/parse.py` (new) · `tests/test_parse_reference.py` (new)
- **Interface:**
  ```python
  class InvalidReference(ValueError): message: str      # editor-readable, e.g. "Jude has only 1 chapter."
  def parse_reference(text: str | dict, canon: Canon | None = None) -> Reference
  ```
- **Steps:**
  1. For a string, build synthetic `Word`s by splitting on whitespace, with fake times.
     **Reuse** `normalize`, `find_candidates` and `validate`; don't write a second parser.
     There must be exactly one non-contextual candidate covering the whole string, or it raises
     `InvalidReference`. A dict input is checked against the canon directly.

     Error messages:
     - `"<Book> has only <n> chapters."`
     - `"<Book> <c> has only <n> verses."`
     - `"Couldn't read \"<text>\" as a scripture reference."`

     Commit.
  2. Test `Romans 8:28`, `1 Cor 6:19-20`, `psalm 23`, the dict form, `Jude 5:1` (the chapter
     message) and `hello` (the generic message). Commit.
- **Verify:** `pytest tests/test_parse_reference.py -q`
- **Done when:**
  - [x] Typed input is validated by the **same** canon and grammar that detection uses.

### T-48.2 · `resolve_detections()`

**Executor** agent · **Size** S · **Prereqs** T-48.1, T-16 · **Status** done

- **Read:** [06 §3.2, §5](../06-bible-text-service.md) ("Quantity limits") ·
  [07 §5.1](../07-sidecar-api.md) (`flags` and `warnings`)
- **Touches:** `sidecar/versesync/bible/resolver.py` (new) · `tests/test_resolver.py` (new)
- **Interface:**
  ```python
  @dataclass(frozen=True)
  class Resolution:
      passage: Passage | None
      flags: tuple[str, ...]          # subset of {'text_unavailable','passage_not_found','long_passage'}
  def resolve_detections(refs: Sequence[Reference], translation: Translation, provider: BibleProvider,
                         canon: Canon, *, max_verses: int = 6,
                         progress: Callable[[int, int], None] | None = None
                         ) -> tuple[list[Resolution], list[dict]]   # (one per ref, warnings)
  ```
- **Steps:**
  1. Implement it.
     - A chapter-only reference gets `Resolution(None, ())` and no fetch.
     - Use `provider.fetch_many` when the provider has it, and `fetch` per reference
       otherwise.
     - `ProviderUnavailable` and `RateLimited` become `text_unavailable`. `PassageNotFound`
       becomes `passage_not_found`.
     - `TranslationNotLicensed` is **re-raised**, because it's a job-level failure.
     - A truncated passage adds `long_passage`.
     - If any reference ends with `text_unavailable`, add the warning
       `{"code": "provider_partial", "message": "<n> passages could not be fetched."}`.
     - `progress(done, total)` is called after each reference.

     Commit.
  2. Tests, using a fake provider that fails on demand:
     - a mixed batch gives the correct flag for each reference, plus one warning;
     - `TranslationNotLicensed` propagates;
     - chapter-only references never hit the provider;
     - a 10-verse reference is flagged `long_passage`.

     Commit.
- **Verify:** `pytest tests/test_resolver.py -q`
- **Done when:**
  - [x] A provider failure never raises, except `TranslationNotLicensed`.
  - [x] Flags and warnings match [07 §5.1](../07-sidecar-api.md) exactly.
