# T-11 · Book matching

| | |
|---|---|
| **Workstream** | C — Detection |
| **Unblocks** | T-12 |
| **Spec** | [04-reference-detection.md §4.1](../04-reference-detection.md) |

## Goal

Resolve a spoken book name, which may be misheard, to a canonical book, **without turning
ordinary English into scripture references**.

## Context

Whisper mishears proper nouns: *Philippians* comes out as "Philippines", *Habakkuk* as "have a
cook". Fuzzy matching fixes that, but applied naively it also turns *"he lost his job"* into
the book of Job. **The number-follows gate** is what makes fuzzy matching safe. The caller (the
grammar) supplies a `fuzzy_gate(next_index) -> bool` predicate. The matcher accepts a tier-2 or
tier-3 window only if `fuzzy_gate(last + 1)` is true. The grammar's gate (T-12.1) returns true
when the token at `next_index` is a number, or is `chapter` or `verse` followed by a number, or
is `,` followed by `verse` and a number. With `fuzzy_gate=None`, matching is tier 1 only.

Tier names are the **schema's** names: `exact`, `alias` (the curated confusion table) and
`fuzzy`. The schema enum is `exact | alias | fuzzy`.

## Shared interface (written in T-11.1, extended by T-11.2 and T-11.3)

```python
# detect/types.py (append)
@dataclass(frozen=True)
class BookMatch:
    book: Book
    tier: str             # 'exact' | 'alias' | 'fuzzy'
    distance: int         # 0 for exact/alias
    first: int; last: int # inclusive token indices consumed, including any ordinal prefix

# detect/fuzzy.py
SHORT_BOOKS = frozenset({"job", "mark", "acts", "numbers", "judges", "ruth", "james", "amos"})
def match_book(tokens: Sequence[Token], i: int, canon: Canon, *,
               fuzzy_gate: Callable[[int], bool] | None = None) -> BookMatch | None
    """Longest match starting at token i. An ordinal token at i followed by a numbered-book base
    is consumed as part of the book ("1 corinthians")."""
```

## Subtasks

### T-11.1 · Tier 1: exact and alias matching with ordinal prefixes

**Executor** agent · **Size** S · **Prereqs** T-10.3 · **Status** done

- **Read:** [04 §4.1](../04-reference-detection.md) (tier 1 and the short-name restriction)
- **Touches:** `sidecar/versesync/detect/types.py` · `sidecar/versesync/detect/fuzzy.py` (new) ·
  `tests/test_book_matching.py` (new)
- **Steps:**
  1. Implement `BookMatch` and `match_book` for tier 1. Try n-grams from
     `canon.max_alias_tokens()` down to 1 starting at `i`, and look each up in the alias table.
     An `ordinal` token followed by a numbered-book base becomes the numbered book. Commit.
  2. Write tests: every book resolves from its canonical name. `1 corinthians`,
     `first corinthians`, `one corinthians` and `ii timothy` all work. So do `song of songs`,
     `revelations` and `psalm`. A plain `corinthians` with no ordinal returns `None`: it's
     ambiguous, and the plan says don't guess. Commit.
- **Verify:** `pytest tests/test_book_matching.py -q`
- **Done when:**
  - [x] Tier 1 resolves every alias in `canon.json`.
  - [x] Matches report the correct `first`/`last`, including the ordinal prefix.

### T-11.2 · Tier 2: curated ASR-confusion table

**Executor** agent · **Size** XS · **Prereqs** T-11.1 · **Status** done

- **Read:** [04 §4.1](../04-reference-detection.md) (the seed table)
- **Touches:** `sidecar/versesync/detect/data/confusions.json` (new) ·
  `sidecar/versesync/detect/fuzzy.py` · `tests/test_book_matching.py`
- **Steps:**
  1. Write `confusions.json` as `{ "<normalised heard form>": "<OSIS id>" }`, seeded with every
     row of the §4.1 table. For the "thessalonians variants" row, add the specific variants
     (`thessalonica ns`, `thessalonions`, `thesalonians`). Load it in `fuzzy.py`. Tier 2 fires
     only through the gate. Commit.
  2. Write tests: every seed entry resolves with `tier='alias'`. The same input with
     `fuzzy_gate=None`, or with a gate that returns False, gives `None`. Commit.
- **Verify:** `pytest tests/test_book_matching.py -q`
- **Done when:**
  - [x] Every seed entry resolves, and only behind the gate.

### T-11.3 · Tier 3: fuzzy matching and the short-name restriction

**Executor** agent · **Size** S · **Prereqs** T-11.2 · **Status** in-progress

- **Read:** [04 §4.1](../04-reference-detection.md) (tier 3 and the gate) ·
  [11 §1](../11-testing.md) (the "Book matching" negative fixtures)
- **Touches:** `pyproject.toml` (add `jellyfish>=1.0` to `dependencies`) ·
  `sidecar/versesync/detect/fuzzy.py` · `tests/test_book_matching.py`
- **Decision:** use `jellyfish.levenshtein_distance` and `jellyfish.metaphone`. Metaphone stands
  in for Double Metaphone as the *secondary* phonetic signal, and the difference is recorded in
  a code comment. The phonetic signal may only break ties between fuzzy candidates at equal
  distance. It never admits a match on its own.
- **Steps:**
  1. Implement tier 3: Levenshtein ≤ 2 for candidates of length ≥ 6, and ≤ 1 for shorter ones,
     compared against canonical names and aliases. Single-token and two-token candidate windows
     only. Books in `SHORT_BOOKS` are **excluded** from fuzzy matching entirely. Fuzzy fires only
     through the gate. Commit.
  2. Write tests:
     - "philippines" → Philippians is caught by tier 2, and "phillipians" → fuzzy at distance 1;
     - distance 3 doesn't match;
     - "jobs", "marks" and "acts" don't fuzzy-match;
     - each negative sentence from [11 §1] gives `None` with `fuzzy_gate=None`;
     - "mark" still matches at tier 1 when it's written exactly.

     Commit.
- **Verify:** `pytest tests/test_book_matching.py -q`
- **Done when:**
  - [ ] Short high-frequency names never resolve via fuzzy matching.
  - [ ] `tier` and `distance` are correct in every test.

## Traps

- The gate isn't an optimisation. It's what stands between this product and an embarrassing
  false positive on a Sunday broadcast. Raise recall by adding observed mishearings to tier 2,
  never by loosening tier 3.
- Match against **normalised tokens**, never raw text. Otherwise "have a cook", which is three
  tokens, never gets tried against "Habakkuk".
