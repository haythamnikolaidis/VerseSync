# 06 — Bible Text Service

Decision **D1**: verse text comes from an **online Bible API**, behind a provider adapter, with
a local cache.

This document also carries **risk R-1**, the highest product risk in the project. Read §6
before committing to a provider.

---

## 1. What this component does

```
Reference(book, chapter, verse, verse_end) + translation
        │
        ▼
   cache lookup ──hit──► formatted Passage
        │miss
        ▼
   provider adapter ──► HTTPS ──► Bible API
        │
        ▼
   normalise → format (VerseFlow-compatible) → cache → Passage
```

Output, the `Passage`:

```json
{
  "reference_display": "1 Corinthians 6:19-20 (NKJV)",
  "body": "19 Or do you not know that your body is the temple of the Holy Spirit who is in you, whom you have from God, and you are not your own? 20 For you were bought at a price; therefore glorify God in your body and in your spirit, which are God's.",
  "verses": [
    { "verse": 19, "text": "Or do you not know that your body is…" },
    { "verse": 20, "text": "For you were bought at a price;…" }
  ],
  "word_count": 61,
  "translation": { "id": "nkjv", "abbreviation": "NKJV", "name": "New King James Version",
                   "attribution": "Scripture taken from the New King James Version®. Copyright © 1982 by Thomas Nelson. Used by permission. All rights reserved." },
  "truncated": false,
  "source": "cache"
}
```

`verses[]` is kept separately from `body` because the chapter-only enhancement
([05](05-timing-and-placement.md) §6) needs per-verse alignment, and because a future template
with a different body layout should not require a re-fetch.

---

## 2. Output formatting — the compatibility contract

VerseSync's graphics must be **indistinguishable** from VerseFlow's for the same scripture
(FR-4.2, FR-4.3). VerseFlow's `js/scripture-parser.js` defines the shape, so this module
reproduces it exactly:

**Reference field** — canonical book name, chapter, verse or `start-end`, then the translation
abbreviation in parentheses:

```
John 3:16 (NKJV)
1 Corinthians 6:19-20 (NKJV)
Psalm 138:8 (TPT)
```

Rules: canonical book spelling from the canon table (never the ASR surface form, never a
provider's abbreviation); no space before the parenthesis is added beyond the single one;
hyphen, not en-dash, for ranges — VerseFlow's parser regex is
`(?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?` and a round-trip through it must succeed.

**Body field** — verse texts joined with a single space, **verse numbers retained** as a
leading number on each verse, whitespace collapsed:

```
19 Or do you not know that your body is the temple… 20 For you were bought at a price;…
```

Rules: strip all provider markup (HTML, USFM, footnote markers, cross-reference callouts,
red-letter spans, paragraph markers); collapse runs of whitespace to one space; strip leading
and trailing whitespace; **keep** the verse numbers, since D4 in VerseFlow made that a client
decision.

A round-trip test is mandatory: a `Passage` rendered into a VerseFlow-format `.txt` block and
parsed back by VerseFlow's parser must yield identical `reference`, `translation` and `body`
strings. That test is what keeps the two products interchangeable, and it is cheap
([11-testing.md](11-testing.md) §2).

---

## 3. The provider adapter

One interface, several implementations. Adding or swapping a provider touches one file
(NFR-5) — which is also the R-1 mitigation.

```python
class BibleProvider(Protocol):
    id: str

    def list_translations(self) -> list[Translation]:
        """Translations available to these credentials, with attribution text."""

    def fetch(self, ref: Reference, translation_id: str) -> RawPassage:
        """One passage. Raises ProviderUnavailable, PassageNotFound, RateLimited,
        or TranslationNotLicensed — never a bare exception."""

    def fetch_chapter(self, book: str, chapter: int, translation_id: str) -> RawPassage:
        """Whole chapter, for the P2 chapter-only enhancement."""
```

### 3.1 Adapters to build

| Adapter | Status | Notes |
|---------|--------|-------|
| `api_bible.py` | **v1, primary** | American Bible Society's API.Bible. Broadest catalogue; per-translation access is granted per key. Verse ids are OSIS-like (`1CO.6.19`), so the canon table must carry OSIS ids — it already does ([04](04-reference-detection.md) §5). |
| `esv.py` | v1, optional | ESV API. Simple, reliable, but ESV only, and its terms cap query size and total proportion of a book served. Worth having as a second data point during evaluation. |
| `local.py` | **built in v1, unused by default** | Reads a bundled/imported local store. This is the R-1 contingency and it must exist before launch, not after. Public-domain translations (KJV, WEB, ASV) ship with it. |
| others | later | Only if licensing forces it. |

Building `local.py` in v1 even though D1 chose the API path is deliberate: it costs about a day
against a risk that could otherwise stop the product, and it doubles as the offline test
fixture so the test suite never needs the network.

### 3.2 Error taxonomy

The resolver never lets a provider failure fail a job (FR-4.5). Every error maps to a cue flag:

| Error | Cue flag | Behaviour |
|-------|----------|-----------|
| `ProviderUnavailable` (network, 5xx, timeout) | `text_unavailable` | Cue kept with reference and timing; disabled by default; panel offers **Retry text fetch** |
| `RateLimited` | `text_unavailable` | Same, plus the resolver backs off and retries the batch once |
| `PassageNotFound` | `passage_not_found` | Usually a detection error that survived canon validation; disabled, flagged for editor correction |
| `TranslationNotLicensed` | job-level error | Fails fast at job start, not per cue — the panel should never have offered the translation |

---

## 4. Caching

Two caches, both on disk under `%APPDATA%\VerseSync\cache\`:

**Verse cache** — SQLite, keyed `(provider_id, translation_id, osis_book, chapter, verse_start,
verse_end)`, storing the raw provider response and the formatted `Passage`, with a fetch
timestamp. Entries do not expire; scripture does not change, and a provider's formatting
changing mid-project would break determinism ([05](05-timing-and-placement.md) §10). A manual
**Clear verse cache** action exists for when a provider genuinely corrects something.

**Transcript cache** — keyed by media **content hash** (SHA-256 over the first and last 8 MB
plus the file size — full-file hashing a 4 GB MXF on every run is not acceptable, and this
prefix/suffix/size composite is strong enough to distinguish edits of the same recording).
Stores the word array, the model and options used, and the schema version. This is what makes
Journey B return in seconds (NFR-2).

**Batching.** The resolver groups a job's references by translation and fetches contiguous
ranges in as few calls as possible, respecting the provider's per-request verse limits. A
45-minute sermon with 20 references should cost at most 20 requests on a cold cache and zero on
a warm one.

---

## 5. Licensing obligations — engineering consequences

Bible translations are copyrighted works and their APIs come with terms that have real code
implications. These are requirements, not notes:

- **Attribution.** Each `Translation` record carries the exact attribution string the licence
  requires. The panel displays it near the translation selector, and it is stored in the Cue
  Document. Nothing is inferred or paraphrased — the string comes from the provider's metadata
  or is configured verbatim.
- **Caching permission.** Some licences restrict storing verse text. The verse cache is
  therefore per-translation switchable (`cache_allowed: bool` on the `Translation` record), and
  a translation marked `cache_allowed: false` is fetched every run. Default is the conservative
  reading of the provider's terms; confirm per translation before enabling.
- **Quantity limits.** Providers commonly cap verses per request and the proportion of a single
  book that may be served. The resolver enforces `max_verses_per_passage` (FR-4.6, default 6)
  and reports a job-level warning if a single job's fetches approach a provider's documented
  book-proportion limit.
- **No redistribution.** Verse text lives in the cache and in the timeline. Cue Documents are
  shareable files that contain verse text — the panel warns on export when the selected
  translation's licence restricts redistribution.

---

## 6. Risk R-1 — the translations may not be available

**This is the highest product risk in VerseSync, and it is a licensing risk, not a technical
one.**

VerseFlow's own sample data uses **NKJV** and **TPT**. Neither is a given:

- **NKJV** (Thomas Nelson / HarperCollins Christian Publishing) is licensed per-application on
  API.Bible; access is granted by the publisher on request, not by signing up.
- **TPT** (The Passion Translation, BroadStreet Publishing) has much narrower API distribution;
  its availability from any mainstream Bible API must be verified before it is promised.
- **ESV** (Crossway) is available through its own API with its own terms, including
  restrictions on how much of a book may be served and a non-commercial condition.

**What must happen before M2 completes** — this is open question **Q-A** in
[00-prd.md](00-prd.md) §11 and [12](12-decisions-and-risks.md):

1. Confirm which translations the church actually needs on screen. If it is one, this gets much
   simpler.
2. Apply for access to those translations from the chosen provider, and get it in writing.
3. Record the exact attribution string and caching terms per translation in the config.

**Contingencies, in order of preference:**

- **C1 — Different provider.** The adapter interface makes this a day of work. Try this first.
- **C2 — Local store (`local.py`).** The church supplies text they already hold a licence to
  use — which is what VerseFlow's `.txt` workflow does today, so this is not a regression, just
  a different input. This is why `local.py` is built in v1.
- **C3 — Public-domain translation.** KJV/WEB/ASV are unrestricted and ship with the local
  store. Acceptable to some churches, not to others; a product decision, not an engineering
  one.

The architecture makes all three cheap. What it cannot do is make an unlicensed translation
appear, so **do not build against NKJV or TPT until access is confirmed.** Build and test
against a public-domain translation, and swap the translation id when the answer arrives.

---

## 7. Translation selection

**v1 behaviour.** The translation is a **project-level setting** chosen in the panel and
persisted (FR-1.5, FR-1.7). Every cue in a run uses it. This matches how churches actually
work: a congregation preaches from one translation and the graphics match it.

**P2 enhancement — spoken translation override.** Preachers do say "…in the New King James…"
or "…the Passion Translation puts it this way…". Detection can pick that up with a small
pattern set over the tokens near a reference, and the cue would then resolve in that
translation instead, flagged in the review row so the editor sees the switch. This is
specified, not built, and it is gated on more than one translation being licensed — which
loops back to R-1. Open question **Q-B**.

---

## 8. Configuration

```yaml
bible:
  provider: api_bible            # api_bible | esv | local
  api_bible:
    api_key_env: VERSESYNC_API_BIBLE_KEY   # never the key itself
    base_url: https://api.scripture.api.bible/v1
    timeout_s: 10
    max_retries: 2
  local:
    store_path: "%APPDATA%/VerseSync/bibles"
  default_translation: kjv
  max_verses_per_passage: 6
  cache_enabled: true
```

Credentials are read from the environment or the OS credential store, **never** written to
`config.yaml`, the Cue Document, or any log (FR-8.2, NFR-4). The config holds the name of the
variable, not its value.
