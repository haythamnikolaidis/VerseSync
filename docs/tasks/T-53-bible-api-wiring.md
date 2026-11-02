# T-53 · Use the Bible API, with NKJV as the fallback

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Unblocks** | Step 28 of Journey A, T-32.H |
| **Spec** | [06 §5, §8](../06-bible-text-service.md) · D27 in [12](../12-decisions-and-risks.md) |

## Goal

The sidecar and CLI honour `bible.provider`, so verse text comes from API.Bible. NKJV is the default
translation, and NIV, AMP and NKJV are available. When the API can't supply text, the cue is flagged
as missing text. It **never** falls back to KJV.

## Context

The T-15 adapter works, but `sidecar.py:100`, `cli.py:76` and `cli.py:115` always build
`LocalProvider()`, so it's never used (Journey A finding). There's also **no real HTTP transport** in
the package: `ApiBibleProvider` takes `fetch_json` by injection, and nothing supplies a real one.

The export (T-51) stays the first source of text. This is what serves "Other mentions" cues,
hand-added cues, and sermons with no export.

## Subtasks

### T-53.1 · Choose the provider from config

**Executor** agent · **Size** S · **Prereqs** T-15.2, T-20.5 · **Status** in-progress

- **Read:** [06 §8](../06-bible-text-service.md) · `sidecar/versesync/bible/api_bible.py`
- **Touches:** `sidecar/versesync/bible/factory.py` (new) · `sidecar/versesync/bible/api_bible.py` ·
  `sidecar/versesync/sidecar.py` · `sidecar/versesync/cli.py` · `tests/test_bible_factory.py` (new) ·
  `tests/conftest.py` · `docs/INSTALL.md`
- **Interface:** `build_provider(config: Config) -> BibleProvider`. `"api_bible"` gives an
  `ApiBibleProvider` with a real transport; `"local"` gives `LocalProvider`; anything else raises
  `ValueError("Unknown bible.provider: <value>")`.
- **Steps:**
  1. Write `urllib_fetch_json(url, headers, timeout) -> (status, dict)` with the standard library,
     and `build_provider`. With no key set, `fetch` raises `ProviderUnavailable` **without a network
     call**, with the message `No API.Bible key: set VERSESYNC_API_BIBLE_KEY and restart Premiere.`
     Commit.
  2. Use `build_provider` in `sidecar.py` and in both CLI commands. Set `bible.provider: local` and
     `default_translation: kjv` in the test configuration, so tests stay offline and goldens don't
     move. Remove the "What the sidecar uses today" note from INSTALL. Commit.
- **Verify:** `pytest -q`
- **Done when:**
  - [ ] `sidecar.py` and `cli.py` no longer name `LocalProvider`.
  - [ ] A test proves a job with no key finishes, with its cues flagged `text_unavailable`.
  - [ ] A test proves the key never appears in the log or in `repr`.

### T-53.2 · NKJV default and the cleared translations

**Executor** agent · **Size** S · **Prereqs** T-53.1 · **Status** todo

- **Read:** [06 §5, §8](../06-bible-text-service.md) · `sidecar/versesync/server.py` (`_translations`, the provider check)
- **Touches:** `sidecar/versesync/config.py` · `sidecar/versesync/bible/api_bible.py` ·
  `sidecar/versesync/server.py` · `tests/test_api_bible.py` · `tests/test_misc_endpoints.py` ·
  `docs/INSTALL.md`
- **Interface:** each `bible.translations` entry becomes `{abbreviation, name, attribution,
  cache_allowed}`. NIV, AMP and NKJV have `attribution: ""` and `cache_allowed: true` (D27). Their
  ids, read from the live API on 2026-11-02:

  | Abbreviation | Name | API.Bible id |
  |---|---|---|
  | `NKJV` | New King James Version | `63097d2a0a2f7db3-01` |
  | `NIV` | New International Version 2011 | `78a9f6124f344018-01` |
  | `AMP` | Amplified Bible | `a81b73293d3080c9-01` |
- **Steps:**
  1. Add the three translations, and set `default_translation: nkjv`. Commit.
  2. `list_translations` returns **only** the configured translations, built from config with no
     network call. Setup then lists only cleared translations, and still works with no key or no
     internet, so an export job can run. Commit.
  3. The `/health` provider check uses a new `check()` that makes the `GET /bibles` call, so a bad
     key or no internet still shows as `degraded`. Commit.
- **Verify:** `pytest tests/test_api_bible.py tests/test_misc_endpoints.py -q`
- **Done when:**
  - [ ] A Bible the key can see but config doesn't list never reaches `GET /translations`.
  - [ ] `GET /translations` makes no network call.
  - [ ] `/health` is `degraded` when `GET /bibles` fails.

### T-53.3 · Verse cache expires after 14 days

**Executor** agent · **Size** XS · **Prereqs** T-53.1 · **Status** todo

- **Read:** `sidecar/versesync/bible/cache.py`
- **Touches:** `sidecar/versesync/bible/cache.py` · `sidecar/versesync/config.py` ·
  `sidecar/versesync/sidecar.py` · `tests/test_verse_cache.py` · `docs/INSTALL.md`
- **Interface:** `CachingProvider(inner, db_path=None, now=_utc_now, max_age_days=14)`, set from
  `bible.cache_max_age_days` (default `14`).
- **Steps:**
  1. `_lookup` treats an entry older than `max_age_days`, or with an unreadable `fetched_at`, as a
     miss. A fresh fetch overwrites it. Delete expired rows when the provider is created, so the
     text doesn't stay on disk past the limit. Commit.
- **Verify:** `pytest tests/test_verse_cache.py -q`
- **Done when:**
  - [ ] A test with the injected clock shows a hit at 13 days and a refetch at 15.
  - [ ] A test shows an expired row is gone from the database after start-up.

### T-53.4 · Hand edits keep the cue's translation

**Executor** agent · **Size** XS · **Prereqs** T-51.2, T-53.2 · **Status** todo

- **Read:** [14 §7](../14-scripture-file-import.md) · `panel/js/review.js` (`resolveCue`)
- **Touches:** `panel/js/review.js` · `panel/js/main.js` · `tests/panel/review-reference.test.js`
- **Steps:**
  1. `resolveCue` asks for the cue's translation: a cue whose `text_source.translation` matches an
     abbreviation in the Setup list keeps it, and anything else (TPT, for example) uses the job's
     translation. The reference label already shows which was used. Commit.
- **Verify:** `npm test`
- **Done when:**
  - [ ] Tests cover an NIV export cue staying NIV, a TPT export cue becoming NKJV, and a provider cue.
  - [ ] With the API unreachable, the edit shows its inline error and the cue keeps its old text.

### T-53.H · Real key, real translations

**Executor** human · **Size** — · **Prereqs** T-53.1 · **Status** todo

1. Confirm `VERSESYNC_API_BIBLE_KEY` is set on the reference workstation, and check that Premiere was
   restarted after setting it.
2. After T-53.3, on the reference workstation: Setup lists the cleared translations with NKJV
   preselected; an analysis with no export shows NKJV text.
3. Disconnect the network and run Journey A step 28: the job succeeds, cues are flagged
   *text unavailable* and unticked, and no KJV text appears. Then repeat with an export: its cues
   still have their text.
4. Record the results in `docs/qa/journey-a.md`.

## Traps

- **Never fall back to KJV.** The wrong translation on a graphic is worse than a flagged gap (D27).
- **`bible.provider` has defaulted to `api_bible` all along**, and nothing read it. Once something
  does, any test that loads the default config will try the network unless it sets `local`.
- **`local` serves KJV only.** With `default_translation: nkjv` and `provider: local`, a job can't
  find its translation, which is why the test configuration sets both.
- **Don't put export text in the cache** (D26). That rule is unchanged.
