# T-11 · Book matching

| | |
|---|---|
| **Workstream** | C — Detection |
| **Wave** | 1 |
| **Estimate** | M |
| **Prereqs** | T-09, T-41 |
| **Unblocks** | T-12 |
| **Spec** | [04-reference-detection.md §4.1](../04-reference-detection.md) |

## Goal

Resolve a spoken (and possibly misheard) book name to a canonical book — **without turning
ordinary English into scripture references**.

## Context you need

Whisper mishears proper nouns it has no reason to expect: *Philippians* → "Philippines",
*Habakkuk* → "have a cook", *Colossians* → "collations". Fuzzy matching fixes those. It also,
naively applied, turns *"he lost his job"* into the book of Job.

The mechanism that makes fuzzy matching safe is **the number-follows gate**. Read
[04 §4.1](../04-reference-detection.md) before writing anything.

## Steps

1. **Tier 1 — exact.** Canonical names and curated aliases from T-09's canon data. Include the
   ubiquitous-but-wrong plural "Revelations", and the Song of Solomon / Song of Songs /
   Canticles family.
2. **Tier 2 — curated ASR-confusion table.** Seed from the table in
   [04 §4.1](../04-reference-detection.md). Keep it as a **data file**, not code — it grows from
   the fixture corpus over the project's life.
3. **Tier 3 — fuzzy.** Levenshtein ≤ 2 for candidates of length ≥ 6, ≤ 1 for shorter, against
   canonical names and aliases. Double Metaphone as a secondary phonetic signal.
4. **The gate:** tiers 2 and 3 fire **only** when the candidate is immediately followed by a
   number pattern matching P1–P10. Without a following number they must not match at all.
5. **The short-name restriction:** *Job, Mark, Acts, Numbers, Judges, Ruth, James, Amos* match
   at **tier 1 only**, never fuzzy. Their edit neighbourhoods in English are too dense.
6. Return the matched book **and the tier and distance** — [04 §6](../04-reference-detection.md)
   scores `book_score` from them (1.0 exact · 0.85 curated · 0.65 fuzzy scaled by distance), and
   they appear in the Cue Document's `detection.book_match`.

## Files

- `sidecar/versesync/detect/fuzzy.py`
- `sidecar/versesync/detect/data/confusions.json`
- `tests/test_book_matching.py`

## Done when

- [ ] The negative fixtures produce **zero** matches: *"he lost his job"*, *"faith without works
      acts dead"*, *"mark my words"*.
- [ ] Every seed confusion entry resolves to the right book.
- [ ] Short high-frequency names never resolve via fuzzy.
- [ ] Tier and distance are returned and correct.

## Traps

- The gate is not an optimisation — it is the thing standing between this product and
  embarrassing false positives on a church's Sunday broadcast. Do not relax it to raise recall;
  raise recall in tier 2 by adding observed mishearings instead.
- Match against **normalised** tokens from T-10, not raw text, or "have a cook" (three tokens)
  will never be tried against "Habakkuk".
