# T-14 · Bible provider interface + local adapter

| | |
|---|---|
| **Workstream** | D — Bible text |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-09 |
| **Unblocks** | T-15, T-16, T-17 |
| **Spec** | [06-bible-text-service.md §1–3](../06-bible-text-service.md) |

## Goal

The `BibleProvider` interface, the error taxonomy, a working `local.py` adapter over a bundled
public-domain translation, and the **VerseFlow-compatible formatter**.

## Context you need

Two reasons this comes before the real API adapter:

1. **It is the R-1 mitigation.** Risk R-1 — that the client's translations turn out not to be
   licensable — is the largest risk in the project and is *contractual, not technical*. A
   working local adapter means a licensed local text can be substituted without a redesign.
   Decision **D16** makes it a v1 deliverable for that reason.
2. **It makes the whole test suite run offline.** Nothing downstream ever needs the network.

## Steps

1. Implement the `BibleProvider` protocol from [06 §3](../06-bible-text-service.md):
   `list_translations()`, `fetch(ref, translation_id)`, `fetch_chapter(book, chapter,
   translation_id)`.
2. Implement the error taxonomy — `ProviderUnavailable`, `PassageNotFound`, `RateLimited`,
   `TranslationNotLicensed`. **Adapters never raise a bare exception.**
3. Implement `local.py` over a bundled public-domain translation (KJV or WEB).
4. Implement `format.py` producing the `Passage` shape in [06 §1](../06-bible-text-service.md),
   and honouring [06 §2](../06-bible-text-service.md) exactly:
   - **Reference:** canonical book spelling from the canon table — never the ASR surface form,
     never a provider abbreviation — then `C:V` or `C:V-V`, then `(ABBR)`. **Hyphen, not
     en-dash.**
   - **Body:** verse texts joined by a single space, **verse numbers retained** as a leading
     number per verse, all provider markup stripped (HTML, USFM, footnote markers,
     cross-references, red-letter spans, paragraph markers), whitespace collapsed.
   - Keep `verses[]` separately from `body` — the chapter-only enhancement
     ([05 §6](../05-timing-and-placement.md)) needs per-verse alignment.
5. Write the **round-trip test** (see below).

## Files

- `sidecar/versesync/bible/{base.py,local.py,format.py}`
- `tests/test_format_roundtrip.py`

## Done when

- [ ] **The round-trip test passes**: a `Passage` rendered into VerseFlow `.txt` block format
      and parsed by VerseFlow's `js/scripture-parser.js` regex
      `^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$` yields
      identical reference, translation and body strings.
- [ ] The full test suite runs with **no network access**.
- [ ] Every adapter error path raises a typed error, never a bare exception.
- [ ] A single verse, a range, and a chapter all format correctly.

## Traps

- The round-trip test is what keeps VerseSync and VerseFlow producing **indistinguishable
  graphics** (FR-4.2, FR-4.3) and keeps `.txt` export viable as an escape hatch. It is not
  optional and it is not a nice-to-have.
- Verse numbers stay in the body. That was a client decision in VerseFlow — do not "clean it up".
- Do not use the ASR's heard book name in the reference field. Always the canon spelling.
