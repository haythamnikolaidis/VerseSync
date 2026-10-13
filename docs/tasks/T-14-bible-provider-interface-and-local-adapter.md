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

## Status

- **Round-trip test passes** — **Met.** `tests/test_format_roundtrip.py` renders passages (a sample set and all 1,189 chapters) as VerseFlow `.txt` blocks and parses them with a verbatim copy of VerseFlow's `scripture-parser.js` executed under Node; reference, translation, body and word count are identical. The test also extracts the regex from that file and checks it equals the one quoted above, and compares the copy against a VerseFlow checkout when `VERSEFLOW_DIR` points at one. Re-verified against the current local VerseFlow checkout (`D:\Development\Personal\VerseFlow`, branch `main`): `tests/fixtures/verseflow/scripture-parser.js` is byte-identical to `js/scripture-parser.js` there (SHA-256 `c09b44a6389104090cf581e14719fece128a4ce14a9d3ae7128a9cd32d5ab12c` on both sides), and with `VERSEFLOW_DIR` set to it, `test_vendored_parser_matches_verseflow_checkout` and all other round-trip tests pass (6/6, 0 skipped).
- **Full suite runs with no network access** — **Met.** The Bible tests use the `no_network` fixture (`tests/conftest.py`), which fails any socket connect or DNS lookup. The only network call anywhere in this task is inside `tools/generate_web.py`'s `main()`, run once by hand to produce the checked-in store; it is never imported or invoked by the test suite.
- **Every adapter error path raises a typed error** — **Met.** `tests/test_bible_local.py` covers unknown translation, unknown book, bad chapter or verse, reversed and over-long ranges, omitted verses, and unreadable or misaligned stores; all raise `ProviderError` subclasses.
- **Single verse, range and chapter format correctly** — **Met.** `test_single_verse_range_and_chapter_format` (John 3:16, 1 Corinthians 6:19-20, Jude 1).

### Re-sourcing the bundled WEB text from eBible.org (2026-10-13)

The bundle originally shipped (`world-english-bible` npm package 1.0.1, a third-party HTML
conversion) was built because eBible.org was unreachable from that build environment.
Independent validation later found it differed in wording from a second independent WEB copy
(seven1m/open-bibles) in roughly 2,000 of 31,102 verses, clustering in the Old Testament —
consistent with the npm package having bundled a different WEB revision, not a translation error
in VerseSync's own code.

eBible.org is directly reachable from this machine now, so `tools/generate_web.py` was rewritten
to fetch and parse the text straight from there instead:

- **Source:** the USFX archive at `https://eBible.org/Scriptures/eng-web_usfx.zip`, linked from
  eBible.org's own WEB details page (<https://ebible.org/find/details.php?id=eng-web>).
- **Fetched:** 2026-10-13.
- **SHA-256 of the fetched archive:**
  `e6a433c6b27bbcd457dfadad2953b6b0e14c510eee7cca0f14aad32334936d3a` — pinned in
  `generate_web.SOURCE_SHA256` and verified by the generator before anything is read; also
  recorded in the output store's `source` object and in [06 §3.3](../06-bible-text-service.md).
- USFX's explicit `<v bcv="BOOK.C.V"/>`/`<ve/>` verse-boundary markers let the generator separate
  verse text from footnotes (`<f>`), cross-references (`<x>`) and descriptive/Psalm titles
  (`<d>`) structurally, rather than relying on a third party's own extraction — a strictly more
  reliable parse than the previous npm package's pre-split per-book JSON files. (The generator
  was prototyped first against eBible.org's VPL — verses-per-line — export, which parses more
  simply, but that export folds Psalm titles into verse 1's text with no way to tell them apart;
  USFX's `<d>` tag keeps that distinction, so USFX is the one checked in.)
- `sidecar/versesync/bible/data/web.json.gz` was regenerated from this source. Totals are
  unchanged: 66 books, 1,189 chapters, 31,102 verse slots.
- The Romans-doxology move (WEB `14:24-26` -> canon `16:25-27`) and the four omitted verses
  (Luke 17:36, Acts 8:37, Acts 15:34, Acts 24:7, stored as `null`) are unchanged in shape and
  **re-verified against this new source**: `generate_web.build()` still asserts the exact moved
  and omitted sets before writing, and `tests/test_bible_local.py::test_documented_versification_handling`
  / `test_bundled_store_lines_up_with_canon` pass against the regenerated store.
- **Spot-checked 26 verses directly against eBible.org's own live chapter pages**
  (`https://eBible.org/eng-web/<BOOK><CH>.htm`, not a third copy), across both testaments,
  confirming the regenerated bundle matches what eBible.org actually serves:
  - Genesis 1:1-1:5, Exodus 20:1-3, Psalm 23:1, Psalm 119:176, Isaiah 53:5 (Old Testament)
  - John 3:16-17, 1 Corinthians 13:4 and 13:13, Romans 14:22-26 (doxology text present in
    chapter 14 on the live page, as expected before the canon-table move), Romans 16's live page
    ending at verse 24 with no 16:25-27 body text (matching the pre-move source shape), Luke
    17:35-37 (verse 36 confirmed empty on the live page), Acts 8:36-38, Acts 15:33-35, Acts
    24:6-8 (verses 37, 34 and 7 respectively confirmed empty on the live pages), 3 John 1:14,
    Jude 1:25, Revelation 22:21 (New Testament)
  Every checked verse's wording, and every checked versification quirk (the doxology's source
  location and all four omissions), matches the regenerated store exactly.
- Updated `tools/generate_web.py` (full rewrite: parses USFX via a small document-order XML
  walker instead of the npm package's per-book JSON, new `OSIS_CODE_USFX` book-id map, source
  constants point at eBible.org, `source` object in the output now also carries `fetch_date`),
  `tests/test_bible_local.py` (generator tests rebuilt around synthetic USFX fixtures, including
  a dedicated test that a Psalm title, a footnote and a cross-reference are all excluded from
  verse text), `tools/README.md`, and
  [06-bible-text-service.md §3.3](../06-bible-text-service.md). One test assertion
  (`test_single_verse_range_and_chapter_format`'s expected John 3:16 body) was updated from
  "gave his one and only Son" to "gave his only born Son" — the correct eBible.org WEB wording,
  confirmed against the live page above; the earlier npm-sourced text had the other reading.
