# T-16 · Verse cache

**Executor** agent · **Size** S · **Prereqs** T-14.3, T-05.1 · **Status** todo

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Unblocks** | T-48.2, T-20.2 |
| **Spec** | [06-bible-text-service.md §4, §5](../06-bible-text-service.md) |

## Goal

A warm cache makes **zero** network calls, and a translation whose licence forbids caching is
**never written to disk**.

## Read

[06 §4](../06-bible-text-service.md) ("Verse cache") · [06 §5](../06-bible-text-service.md)
("Caching permission")

## Touches

`sidecar/versesync/bible/cache.py` (new) · `tests/test_verse_cache.py` (new)

## Interface

```python
class CachingProvider:                       # wraps any BibleProvider; same protocol
    def __init__(self, inner: BibleProvider, db_path: Path | None = None): ...  # default app_home()/cache/verses.sqlite3
    def clear(self) -> None
```

It's keyed by `(provider_id, translation_id, osis_book, chapter, verse_start, verse_end)`, and
it stores the `RawPassage` payload and verses, along with a fetch timestamp. The timestamp is
injected; there's no wall clock in the key path. Entries never expire.

## Steps

1. Write `CachingProvider` using `sqlite3`. A `cache_allowed=False` translation always goes to
   `inner` and **never** opens the database for writing. Commit: `T-16 [1/2] cache`.
2. Write the tests:
   - a warm second fetch calls the counting fake `inner` zero times;
   - a `cache_allowed=False` translation fetches every time and leaves no rows (assert on the
     row count);
   - `clear()` empties the cache;
   - the cache survives a new `CachingProvider` instance on the same path, which stands in for
     a restart;
   - two spellings that resolve to the same `Reference` share one entry.

   Commit: `T-16 [2/2] tests`.

## Verify

`pytest tests/test_verse_cache.py -q`

## Done when

- [ ] Every test case above passes.
- [ ] `cache_allowed: false` means nothing is ever written to disk, not merely that the text is
      re-read.
