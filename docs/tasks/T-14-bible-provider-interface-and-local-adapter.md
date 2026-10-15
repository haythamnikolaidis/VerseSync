# T-14 · Bible provider interface, formatter and local adapter

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Unblocks** | T-15, T-16, T-17, T-48 |
| **Spec** | [06-bible-text-service.md §1–3](../06-bible-text-service.md) |

## Goal

Build the `BibleProvider` interface and its typed errors, the **VerseFlow-compatible
formatter**, and a working `local.py` over the bundled KJV (T-09.1).

## Context

Two reasons this comes before the API adapter. It's the **R-1 mitigation**: the translations
the client wants may not be licensable, and a working local adapter means licensed local text
can be swapped in without a redesign (D16). It also makes the **whole test suite run offline**.

```python
# bible/base.py
@dataclass(frozen=True)
class Translation:
    id: str; abbreviation: str; name: str; attribution: str; cache_allowed: bool = True
    def to_json(self) -> dict          # the 07 GET /translations item shape
@dataclass(frozen=True)
class RawVerse:
    verse: int; text: str              # provider text, may still contain markup
@dataclass(frozen=True)
class RawPassage:
    provider_id: str; translation_id: str; reference: Reference
    verses: tuple[RawVerse, ...]; payload: str   # payload = raw response, for the cache
@dataclass(frozen=True)
class Passage:                         # 06 §1
    reference: Reference; reference_display: str; body: str
    verses: tuple[RawVerse, ...]       # cleaned text, no verse numbers
    word_count: int; translation: Translation; truncated: bool; source: str  # 'provider'|'cache'|'local'
    def to_json(self) -> dict          # the 06 §1 / POST /resolve shape
class BibleError(Exception): code: str
class ProviderUnavailable(BibleError) ...; class RateLimited(BibleError) ...
class PassageNotFound(BibleError) ...; class TranslationNotLicensed(BibleError) ...
class BibleProvider(Protocol):
    id: str
    def list_translations(self) -> list[Translation]: ...
    def fetch(self, ref: Reference, translation_id: str) -> RawPassage: ...
    def fetch_chapter(self, book_osis: str, chapter: int, translation_id: str) -> RawPassage: ...
```

## Subtasks

### T-14.1 · Types, protocol and error taxonomy

**Executor** agent · **Size** XS · **Prereqs** T-09.3 · **Status** done

- **Read:** [06 §1, §3, §3.2](../06-bible-text-service.md)
- **Touches:** `sidecar/versesync/bible/base.py` (new) · `tests/test_bible_base.py` (new)
- **Steps:**
  1. Implement the types and errors above. Each error class carries a stable `code`
     (`provider_unavailable`, `rate_limited`, `passage_not_found` or
     `translation_not_licensed`) and an editor-readable message. Test the `to_json` shapes
     against 07's `GET /translations` example keys. Commit.
- **Verify:** `pytest tests/test_bible_base.py -q`
- **Done when:**
  - [x] Every error is a `BibleError` subclass with a `code`.

### T-14.2 · `format.py` and the VerseFlow round-trip test

**Executor** agent · **Size** S · **Prereqs** T-14.1, T-43 · **Status** done

- **Read:** [06 §2](../06-bible-text-service.md) · `reference/verseflow/js/scripture-parser.js`
  (the block format and the regex) · `reference/verseflow/js/duration.js` (the word-count
  function only)
- **Touches:** `sidecar/versesync/bible/format.py` (new) · `tests/test_format_roundtrip.py` (new)
- **Interface:**
  ```python
  def strip_markup(text: str) -> str          # HTML, USFM \x .. \x*, footnote/xref callouts, pilcrows, collapse ws
  def format_passage(raw: RawPassage, translation: Translation, canon: Canon,
                     *, max_verses: int = 6, source: str = "provider") -> Passage
  def word_count(body: str) -> int            # VerseFlow's counting rule, ported exactly
  def to_verseflow_block(p: Passage) -> str   # one block in VerseFlow's .txt format
  ```
- **Steps:**
  1. Write `strip_markup` and `format_passage`.
     - The reference display is `Reference.display(canon)` + ` (` + abbreviation + `)`.
     - The body is each verse as `"<n> <text>"`, joined by single spaces.
     - If the passage has more than `max_verses` verses, keep only the first `max_verses` and
       set `truncated=True`.
     - `word_count` follows VerseFlow's rule and is applied to `body`.

     Test the markup stripping on HTML, USFM, footnotes, red-letter spans and paragraph
     markers. Commit.
  2. Write `to_verseflow_block` and the **round-trip test**. Build a `Passage`, render it to a
     block, parse it with VerseFlow's regex (copied into the test from the vendored
     `scripture-parser.js`, with a comment citing the file), and assert that the reference,
     translation and body are identical. Cover a single verse, a range, and `1 Corinthians`,
     which has a numbered book. Commit.
- **Verify:** `pytest tests/test_format_roundtrip.py -q`
- **Done when:**
  - [x] The round-trip test passes for a single verse, a range, and a numbered book.
  - [x] Ranges use a hyphen, never an en-dash.
  - [x] Verse numbers stay in the body.

### T-14.3 · `local.py` over the bundled KJV

**Executor** agent · **Size** S · **Prereqs** T-14.2 · **Status** in-progress

- **Read:** [06 §3.1](../06-bible-text-service.md) (the `local.py` row)
- **Touches:** `sidecar/versesync/bible/local.py` (new) · `tests/test_local_provider.py` (new)
- **Steps:**
  1. Write `LocalProvider(store_dir: Path | None = None)`.
     - By default it serves the bundled `kjv.json.gz` as translation `kjv`, with attribution
       `Public domain.` and `cache_allowed=True`.
     - Any extra `*.json.gz` files in `store_dir` that use the same format become additional
       translations. That's the C2 contingency in [06 §6](../06-bible-text-service.md).
     - `fetch` returns the verses for single verses and ranges.
     - A chapter-only reference raises `PassageNotFound`. Chapter fetches go through
       `fetch_chapter`.
     - A verse out of range raises `PassageNotFound`, and an unknown translation raises
       `TranslationNotLicensed`.

     Commit.
  2. Tests:
     - John 3:16 KJV formats to `John 3:16 (KJV)` with a body starting `16 For God so loved`;
     - 1 Corinthians 6:19-20 has 2 verses;
     - a 10-verse range truncates to 6 with `truncated=True`;
     - every error path raises its typed error;
     - the suite passes with networking disabled, by monkeypatching `socket.socket` to raise.

     Commit.
- **Verify:** `pytest tests/test_local_provider.py -q`
- **Done when:**
  - [ ] Single verse, range and chapter fetches all work, all offline.
  - [ ] No bare exceptions escape.

## Traps

- Verse numbers stay in the body. That was a client decision in VerseFlow; don't tidy it away.
- The reference field always uses the **canon** spelling, never the form the ASR heard.
