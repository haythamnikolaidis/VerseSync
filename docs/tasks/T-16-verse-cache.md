# T-16 · Verse cache

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Wave** | 1 |
| **Estimate** | S |
| **Prereqs** | T-14, T-15 |
| **Unblocks** | T-20 |
| **Spec** | [06-bible-text-service.md §4, §5](../06-bible-text-service.md) |

## Goal

A warm cache issues **zero** network calls, and translations whose licence forbids caching are
never cached.

## Steps

1. SQLite under `%APPDATA%\VerseSync\cache\`, keyed
   `(provider_id, translation_id, osis_book, chapter, verse_start, verse_end)`.
2. Store both the raw provider response and the formatted `Passage`, plus a fetch timestamp.
3. **Entries do not expire.** Scripture does not change, and a provider silently altering
   formatting mid-project would break determinism
   ([05 §10](../05-timing-and-placement.md)).
4. Honour the per-translation **`cache_allowed`** flag from
   [06 §5](../06-bible-text-service.md). When false, always refetch and never persist — this is
   a licensing obligation, not a performance setting.
5. Implement the **Clear verse cache** action for when a provider genuinely corrects something.

## Files

- `sidecar/versesync/bible/cache.py`
- `tests/test_verse_cache.py`

## Done when

- [ ] A warm cache issues zero network calls for a repeated job.
- [ ] A `cache_allowed: false` translation refetches every time and leaves nothing on disk.
- [ ] Clear-cache empties it and the next job refetches.
- [ ] The cache survives a sidecar restart.

## Traps

- `cache_allowed: false` must also mean *nothing written to disk*, not merely "read it again" —
  the obligation is about storage, not freshness.
- Key on the **resolved reference**, not the ASR surface form. Two spellings of the same verse
  must share a cache entry.
