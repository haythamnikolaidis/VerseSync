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

**Executor** agent · **Size** S · **Prereqs** T-15.1 · **Status** done

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
  - [x] Every status code maps to its typed error.
  - [x] Exactly one retry happens after a 429.
  - [x] The request-count bound is asserted.

### T-15.H · Real key, real translations (Q-A)

**Executor** human · **Size** — · **Prereqs** T-15.2 · **Status** done

- `VERSESYNC_API_BIBLE_KEY` is live (set in this environment and the Linux container).
  Recorded real responses from `https://api.scripture.api.bible/v1` on 2026-10-17 for
  `/bibles`, a single-verse passage (John 3:16), a verse-range passage (1 Cor 6:19-20) and a
  404 (bad passage id), for the three public-domain translations already in scope: **KJV**
  (`de4e12af7f28f599-01`), **ASV** (`06125adad2d5898a-01`) and **WEB** (`9879dbb7cfe39e4d-04`).
  Each passage's own `copyright` field confirms `PUBLIC DOMAIN` — no written-access step was
  needed for these three, per T-15's "Blocked by" scoping. Replaced
  `bibles.json`, `passage_single.json`, `passage_range.json` and `error_404.json`, keeping
  filenames, and dropped `"synthetic": true` from them.
  - `error_429.json` and `error_503.json` **stay synthetic**: a 429 isn't reproducible without
    burning the live key's quota, and a 503 needs an actual provider outage. Each now carries a
    `_synthetic_reason` field recording why, with its envelope shape (`statusCode`/`error`/
    `message`) confirmed against a real 403 (bad key) and a real 404.
  - Real data surfaced a bug: API.Bible's `/bibles` `abbreviation` field is language-prefixed
    (`"engKJV"`), not the short form 06 section 5 wants (`"KJV"`); `abbreviationLocal` carries
    the short form and matches for all three translations. Fixed `list_translations()` to
    prefer `abbreviationLocal`. See the commit for the fix and the updated fixtures.
- Filled in `translations_config` (as `bible.translations` in `config.py`'s defaults):
  attribution (each translation's own real `copyright` text) and `cache_allowed=True` for
  KJV, ASV and WEB.
- Re-ran `pytest tests/test_api_bible.py` — still passes (23/23). Also ran the full suite;
  fixed an unrelated pre-existing leak in `tests/test_config.py` where
  `test_secret_reads_env_var_named_in_config` assumed `VERSESYNC_API_BIBLE_KEY` was unset,
  which now fails wherever the key is exported in the shell. It now `delenv`s it first.
- **Q-A remains open for translations beyond public domain** (NKJV, TPT): the live key does
  return NKJV content on request, but that is API read access, not the written commercial
  distribution permission R-1 requires. Per the card's "Blocked by" note, that gap doesn't
  block this task — it blocks adding NKJV/TPT to `translations_config` later.

## Traps

- `TranslationNotLicensed` is a **job-level** failure. The panel should never have offered that
  translation in the first place.
- CI must never depend on a live key.
