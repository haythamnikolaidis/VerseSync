# T-09 · Canon data

| | |
|---|---|
| **Workstream** | C — Detection |
| **Wave** | 1 |
| **Estimate** | S |
| **Prereqs** | T-40 |
| **Unblocks** | T-10, T-11 — **the whole detection stream waits on this, do it first** |
| **Spec** | [04-reference-detection.md §5](../04-reference-detection.md) |

## Goal

A checked-in data file describing all 66 books: canonical name, OSIS id, aliases, chapter count,
and verses per chapter.

## Context you need

This table does two jobs. It is how a spoken book name becomes a canonical reference (T-11), and
it is how impossible references get rejected (T-13) — *"Jude chapter 3"* cannot exist, and
rejecting it removes a large share of false positives at no cost.

It is also the OSIS-id source for Bible API lookups ([06 §3](../06-bible-text-service.md)).

## Steps

1. Generate `sidecar/versesync/detect/data/canon.json` from a public-domain source. **Check the
   generated file in** — do not fetch at runtime.
2. Per book: canonical name, OSIS id (e.g. `1Cor`), chapter count, verses per chapter, and
   aliases covering:
   - ordinal forms — `1 Corinthians`, `First Corinthians`, `1st Corinthians`, `I Corinthians`
   - common abbreviations — `1 Cor`, `Phil`, `Ps`, `Rev`
   - spoken forms — `first corinthians`, `psalm` vs `psalms`
   - the Song of Solomon / Song of Songs / Canticles family
3. Commit the generator script alongside the data so it can be regenerated and audited.
4. Add a validation test asserting known totals.

## Files

- `sidecar/versesync/detect/data/canon.json`
- `tools/generate_canon.py`
- `tests/test_canon.py`

## Done when

- [ ] 66 books, **1,189 chapters** total.
- [ ] Psalm 119 has 176 verses; Jude has 1 chapter; Obadiah has 21 verses; 3 John has 14 verses.
- [ ] Every book resolves from at least its ordinal, abbreviated and spoken aliases.
- [ ] The table loads in **< 50 ms**.

## Traps

- **Psalm vs. Psalms** — preachers say both, and "Psalm 119" is far more common than
  "Psalms 119". Both must resolve.
- Verse counts vary slightly between translations. Pick one authority, note it in the generator
  script, and be consistent — T-13 rejects on these numbers, so a wrong count silently drops
  valid references.
- Aliases must be matched case- and punctuation-insensitively; normalise at load, not at every
  lookup.

## Status

- **Met** — 66 books, 1,189 chapters: `tests/test_canon.py::test_totals` (also 31,102 verses, and the
  independent OT 929 / NT 260 chapter and 23,145 / 7,957 verse split in
  `test_testament_split_cross_check`).
- **Met** — Psalm 119 = 176 verses, Jude = 1 chapter, Obadiah = 21 verses, 3 John = 14 verses:
  `test_known_counts`.
- **Met** — every book resolves from its ordinal, abbreviated and spoken aliases:
  `test_every_book_resolves_from_canonical_osis_and_aliases`,
  `test_numbered_books_resolve_from_every_ordinal_form`, `test_spoken_and_abbreviated_forms`
  (Psalm/Psalms and the Song of Solomon/Songs/Canticles family included).
- **Met** — table loads in under 50 ms: `test_loads_in_under_50ms` (cold load, cache cleared).

Source of verse counts (recorded in `tools/generate_canon.py` and in `canon.json`): KJV (1769,
public domain) from the scrollmapper bible_databases `KJV.json`; only chapter/verse counts are
used, no text is bundled.
