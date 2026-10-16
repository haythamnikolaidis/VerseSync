# T-15 · API.Bible adapter

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Unblocks** | T-20.5 (the provider list), release |
| **Spec** | [06-bible-text-service.md §3.1, §4, §5, §8](../06-bible-text-service.md) |
| **Blocked by** | open question **Q-A**, but only for translations beyond public domain (T-15.H) |

## Goal

The primary provider adapter, for the American Bible Society's API.Bible. Its output must be
**identical** to `local.py`'s output for the same translation.

## Context

The agent has **no API key**, so it builds against **synthetic fixtures** modelled on API.Bible's
published v1 response shapes. Each fixture is marked `"synthetic": true`. T-15.H, a human task,
records real responses with a key and replaces the fixtures. The adapter itself doesn't care
which translation it serves.

The HTTP transport is injected as `fetch_json(url, headers, timeout) -> (status, dict)`, so
tests never touch the network. Credentials come from the environment variable named by
`config.bible.api_bible.api_key_env` ([06 §8](../06-bible-text-service.md)). They're never
logged and never serialised.

## Subtasks

### T-15.1 · Client, response parsing, translations

**Executor** agent · **Size** S · **Prereqs** T-14.3 · **Status** done

- **Read:** [06 §3.1, §5, §8](../06-bible-text-service.md) · [07 §2](../07-sidecar-api.md)
  (`GET /translations`). The API.Bible public reference for `GET /v1/bibles` and
  `GET /v1/bibles/{bibleId}/passages/{passageId}` is optional. If it's unreachable, model the
  fixtures on what the card states.
- **Touches:** `sidecar/versesync/bible/api_bible.py` (new) · `tests/fixtures/api_bible/*.json`
  (new, synthetic) · `tests/test_api_bible.py` (new)
- **Steps:**
  1. Write `ApiBibleProvider(api_key: str, base_url: str, fetch_json=..., translations_config=...)`.
     - `list_translations()` maps `/bibles` to `Translation`. The **attribution** and
       **`cache_allowed`** come from `translations_config`, which is per-translation config.
       Never infer them. With no config entry, `cache_allowed` defaults to `False`.
     - `fetch()` builds the passage id from OSIS (`1CO.6.19-1CO.6.20`). Book codes are
       uppercase USFM ids; include a mapping table from OSIS to USFM.
     - It requests text with verse numbers, and parses verses into `RawVerse` by splitting on
       the verse-number markers.

     Commit.
  2. Write the synthetic fixtures: a `/bibles` list, one passage with a single verse, one with
     a range (both containing HTML markup), a 404, a 429 and a 503. Test that John 3:16 KJV
     from API.Bible **formats byte-identically** to `LocalProvider` for the same passage. Write
     that fixture's text from the bundled KJV so the two can actually match. Commit.
- **Verify:** `pytest tests/test_api_bible.py -q`
- **Done when:**
  - [x] The identical-output test passes.
  - [x] No API key appears in any log record (assert with `caplog`) or in any `repr()`.

### T-15.2 · Batching, retry and error mapping

**Executor** agent · **Size** S · **Prereqs** T-15.1 · **Status** in-progress

- **Read:** [06 §3.2, §4](../06-bible-text-service.md) (the "Batching" paragraph)
- **Touches:** `sidecar/versesync/bible/api_bible.py` · `tests/test_api_bible.py`
- **Steps:**
  1. Map errors: network failures, 5xx responses and timeouts become `ProviderUnavailable`;
     429 becomes `RateLimited`; 404 becomes `PassageNotFound`; 401 and 403 on a bible become
     `TranslationNotLicensed`. On `RateLimited`, back off once and retry once. The sleep
     function is injected, so tests don't wait. Commit.
  2. Add `fetch_many(refs, translation_id) -> dict[Reference, RawPassage | BibleError]`. It
     groups contiguous or overlapping verse ranges in the same chapter into one request. Test
     that 20 references cost at most 20 requests, and that adjacent verses cost one request.
     Commit.
- **Verify:** `pytest tests/test_api_bible.py -q`
- **Done when:**
  - [ ] Every status code maps to its typed error.
  - [ ] Exactly one retry happens after a 429.
  - [ ] The request-count bound is asserted.

### T-15.H · Real key, real translations (Q-A)

**Executor** human · **Size** — · **Prereqs** T-15.2 · **Status** todo

- Resolve **Q-A** ([12](../12-decisions-and-risks.md)): decide which translations, get written
  access, and record the attribution and caching terms for each.
- Put the key in `VERSESYNC_API_BIBLE_KEY` and record real responses for every synthetic
  fixture. Replace the fixtures, keeping their filenames, and drop `"synthetic": true`.
- Fill in `translations_config` (the attribution and `cache_allowed` for each translation) in
  the default config.
- Re-run `pytest tests/test_api_bible.py`. It must still pass.

## Traps

- `TranslationNotLicensed` is a **job-level** failure. The panel should never have offered that
  translation in the first place.
- CI must never depend on a live key.
