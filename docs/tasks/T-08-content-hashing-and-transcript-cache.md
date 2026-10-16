# T-08 · Content hashing and transcript cache

**Executor** agent · **Size** S · **Prereqs** T-07.1 · **Status** in-progress

| | |
|---|---|
| **Workstream** | B — Sidecar platform |
| **Unblocks** | T-20.2, T-31 |
| **Spec** | [03 §4](../03-architecture.md) · decision **D17** in [12](../12-decisions-and-risks.md) · [06 §4](../06-bible-text-service.md) ("Transcript cache") |

## Goal

Transcribe each media file once. A second run on the same file returns in seconds, which is what
makes Journey B (the re-run after a recut) cheap.

## Read

D17 in [12](../12-decisions-and-risks.md) · [06 §4](../06-bible-text-service.md) (the
"Transcript cache" paragraph)

## Touches

`sidecar/versesync/cache.py` (new) · `tests/test_cache.py` (new)

## Interface

```python
CHUNK = 8 * 1024 * 1024
def hash_media(path: Path, progress: Callable[[float], None] | None = None) -> str   # "sha256:<hex>"
class TranscriptCache:
    def __init__(self, root: Path | None = None): ...          # default cache_dir()/transcripts
    def key(self, media_hash: str, opts: TranscribeOptions) -> str
    def get(self, media_hash: str, opts: TranscribeOptions) -> tuple[list[Word], float] | None
    def put(self, media_hash: str, opts: TranscribeOptions, words: list[Word], duration_s: float) -> None
```

## Steps

1. Write `hash_media`: SHA-256 over the first 8 MB, then the last 8 MB, then the file size as
   8-byte little-endian. A file under 16 MB is hashed whole, once. Test it on a small file, and
   on a 4 GB **sparse** file created with `truncate`; that one must take under 1 s. Also test
   that two files with the same head and size but a different tail hash differently. Commit:
   `T-08 [1/2] hash_media`.
2. Write `TranscriptCache`.
   - The key is a SHA-256 of `media_hash` plus the canonical JSON of `opts.cache_key()`.
   - Each entry is a JSON file holding words, duration, options and `schema_version`.
   - Writes are atomic.

   Tests:
   - a `put` followed by a `get` hits;
   - a different model misses;
   - a detection-only option (such as `context_window_s`, which isn't in `cache_key`) still
     hits;
   - the cache survives a new instance.

   Commit: `T-08 [2/2] transcript cache`.

## Verify

`pytest tests/test_cache.py -q`

## Done when

- [ ] Hashing a 4 GB sparse file takes well under 1 s.
- [ ] Changing the model misses the cache, and changing a detection option hits it.
- [ ] The cache lives under `app_home()`, not in a temp directory.

`cache_hit` reporting, phase renormalisation and `use_cache: false` belong to the job runner
(T-20.2).

## Traps

- Two sermons of the same length from the same camera can share their first bytes. The **last**
  8 MB and the size are what tell them apart. Include all three.
