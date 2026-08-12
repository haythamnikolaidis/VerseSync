# T-15 · API.Bible adapter

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-14 |
| **Unblocks** | T-16, T-20 |
| **Spec** | [06-bible-text-service.md §3.1, §4, §5](../06-bible-text-service.md) |
| **Blocked by** | open question **Q-A** — for anything beyond public-domain translations |

## Goal

The primary provider adapter: American Bible Society's API.Bible, producing output byte-identical
to `local.py`'s for the same translation.

## Context you need

**Q-A is unresolved** ([12](../12-decisions-and-risks.md)): we do not yet have confirmed written
access to the translations the client actually wants (VerseFlow's samples use NKJV and TPT).

**Build and test against a public-domain translation only.** Do not build against NKJV or TPT
until access is confirmed in writing. The adapter is translation-agnostic, so this costs nothing
— only the final verification waits, and it is not on the critical path.

## Steps

1. `api_bible.py` implementing the `BibleProvider` protocol from T-14.
2. `list_translations()` → `GET /translations` shape in [07 §2](../07-sidecar-api.md), including
   the **attribution string** and the **`cache_allowed`** flag per translation.
3. `fetch()` by OSIS-like verse id (`1CO.6.19`) — the canon table (T-09) already carries OSIS
   ids.
4. Strip all provider markup and reuse **T-14's `format.py`**. Do not write a second formatter;
   identical output is the acceptance criterion.
5. **Batching** ([06 §4](../06-bible-text-service.md)): group a job's references by translation
   and fetch contiguous ranges in as few calls as possible, within the provider's per-request
   verse limits. A 45-minute sermon with 20 references should cost **at most 20 requests cold,
   zero warm**.
6. Rate-limit backoff: on `RateLimited`, back off and retry the batch **once**, then flag the
   affected cues `text_unavailable`.
7. Map every failure to the typed errors from [06 §3.2](../06-bible-text-service.md). A provider
   failure must **never fail the job** (FR-4.5) — cues are kept with reference and timing,
   flagged, and disabled by default.
8. Credentials load via `config.py` and are **never logged, never serialised into a Cue
   Document, never sent to the panel**.

## Files

- `sidecar/versesync/bible/api_bible.py`
- `tests/test_api_bible.py` (recorded fixtures — no live network in CI)

## Done when

- [ ] Real passages fetch and format **identically** to `local.py`'s output for the same
      translation.
- [ ] Attribution and `cache_allowed` are returned per translation.
- [ ] A simulated outage flags cues `text_unavailable` and the job still **succeeds**.
- [ ] Batching meets the request-count bound above.
- [ ] No credential appears in any log line, Cue Document or API response.

## Traps

- Providers wrap text in markup that varies by translation and endpoint. Strip aggressively and
  assert on the round-trip test from T-14.
- `TranslationNotLicensed` is a **job-level** failure, not a per-cue flag — the panel should
  never have offered that translation in the first place.
- CI must not depend on a live API key. Record fixtures.
