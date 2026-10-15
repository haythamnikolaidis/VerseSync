# T-09 · Canon data (and the bundled public-domain text)

| | |
|---|---|
| **Workstream** | C — Detection |
| **Unblocks** | T-10, T-11, T-14. **The whole Python pipeline waits on this.** |
| **Spec** | [04-reference-detection.md §5](../04-reference-detection.md) · [06 §3.1](../06-bible-text-service.md) |

## Goal

Two checked-in data files and one loader:

- a public-domain **KJV text** (which the local provider T-14.3 serves);
- **`canon.json`**: 66 books with canonical name, display name, OSIS id, aliases, chapter count
  and verse counts, **derived from that same KJV text** so the two can never disagree;
- a `Canon` API that the rest of the pipeline uses.

## Context

The canon table does three jobs. It turns a spoken book name into a canonical reference (T-11).
It rejects impossible references (T-13); *"Jude chapter 3"* can't exist. And it is the OSIS id
source for Bible lookups (T-14, T-15).

**One authority for verse counts:** KJV, the translation the fixtures already use. Deriving the
counts from the bundled text means T-13 can't reject a verse that T-14 can serve.

## Subtasks

### T-09.1 · Bundle the public-domain KJV text

**Executor** agent · **Size** S · **Prereqs** — · **Status** done

- **Read:** this card only.
- **Touches:** `tools/fetch_pd_bible.py` (new) · `sidecar/versesync/bible/data/kjv.json.gz`
  (new) · `tests/test_pd_bible.py` (new)
- **Output format** (`kjv.json.gz`, gzip-compressed UTF-8 JSON):
  ```json
  { "translation": { "id": "kjv", "abbreviation": "KJV", "name": "King James Version",
                     "attribution": "Public domain." },
    "books": [ { "osis": "Gen", "chapters": [ ["In the beginning God created…", "…"], … ] }, … ] }
  ```
  `chapters[c-1][v-1]` is the text of chapter `c`, verse `v`. Books are in canonical
  Protestant order, and their OSIS ids follow the standard OSIS book abbreviations
  (`Gen … Rev`, `1Cor`, `Song`, `Ps`).
- **Steps:**
  1. Write `tools/fetch_pd_bible.py`. It downloads a public-domain KJV in a structured format
     (JSON or CSV) from a stable public source, such as the `scrollmapper/bible_databases`
     GitHub repo (`raw.githubusercontent.com`). It converts that to the format above, strips
     source-specific markup (brackets, pilcrows, Strong's numbers), collapses whitespace, and
     writes the gzip file. **Pin the source URL and a SHA-256 of the downloaded file** in the
     script. Commit the script, with the generated file. **If outbound network is unavailable,
     mark the task blocked.** Don't type scripture in by hand.
  2. Write the tests. There are **66** books, **1,189** chapters and **31,102** verses.
     Genesis 1:1 starts with "In the beginning". Psalm 119 has 176 verses. 3 John has 14
     verses. No verse text is empty. Loading the file takes under 200 ms. Commit.
- **Verify:** `pytest tests/test_pd_bible.py -q`
- **Done when:**
  - [x] The totals above hold, and the source URL and its hash are pinned in the script.
  - [x] The file is under ~1.5 MB compressed.

### T-09.2 · Generate `canon.json`

**Executor** agent · **Size** S · **Prereqs** T-09.1 · **Status** in-progress

- **Read:** [04 §4.1, §5](../04-reference-detection.md) · [04 §3.1](../04-reference-detection.md)
  (the "numbered form" list only)
- **Touches:** `tools/generate_canon.py` (new) · `sidecar/versesync/detect/data/canon.json`
  (new) · `tests/test_canon_data.py` (new)
- **Output format** (one entry per book, in canonical order):
  ```json
  { "name": "1 Corinthians", "display_name": "1 Corinthians", "osis": "1Cor",
    "numbered": true, "base": "corinthians", "ordinal": 1,
    "chapter_count": 16, "verse_counts": [31, 16, …],
    "aliases": ["1 corinthians", "first corinthians", "1st corinthians", "i corinthians",
                "1 cor", "one corinthians"] }
  ```
  - `name` is the canonical name used in `reference.book` (`"Psalms"`).
  - `display_name` is what the reference *display* uses: `"Psalm"` for Psalms (see the fixture
    `alternatives.json`: `"Psalm 122 (KJV)"`) and the same as `name` for every other book.
  - Aliases are **normalised**: lowercase, ASCII, single spaces, no punctuation.
- **Steps:**
  1. Write `tools/generate_canon.py`. It takes the chapter and verse counts from `kjv.json.gz`.
     The names, OSIS ids and aliases are hard-coded tables in the script. Those tables cover:
     - ordinal forms: `1`, `first`, `1st`, `i`, `one`;
     - abbreviations: `gen`, `ex`, `lev`, `ps`, `prov`, `isa`, `jer`, `matt`, `rom`, `cor`,
       `gal`, `eph`, `phil`, `col`, `thess`, `tim`, `heb`, `jas`, `pet`, `rev`, and so on;
     - spoken forms: `psalm` and `psalms`, `song of solomon`, `song of songs`, `canticles`,
       `revelation` and `revelations`.

     Write `canon.json` with sorted keys and an indent of 1, so that diffs are reviewable.
     Commit both files.
  2. Write the tests:
     - 66 books and 1,189 chapters in total;
     - Psalm 119 has 176 verses, Jude has 1 chapter, Obadiah has 21 verses, 3 John has 14;
     - no alias maps to two books;
     - every numbered book (Samuel, Kings, Chronicles, Corinthians, Thessalonians, Timothy,
       Peter, John) has all five ordinal forms.

     Commit.
- **Verify:** `pytest tests/test_canon_data.py -q`
- **Done when:**
  - [ ] Every assertion above passes.
  - [ ] Re-running the generator reproduces the file byte for byte.

### T-09.3 · `Canon` loader and shared core types

**Executor** agent · **Size** S · **Prereqs** T-09.2 · **Status** todo

- **Read:** [04 §5](../04-reference-detection.md) · [07 §5](../07-sidecar-api.md) (the
  `reference` object only)
- **Touches:** `sidecar/versesync/types.py` (new) · `sidecar/versesync/detect/canon.py` (new) ·
  `tests/test_canon.py` (new) · `tests/conftest.py` (add a `canon` fixture)
- **Interface:**
  ```python
  # versesync/types.py: shared by every stage
  @dataclass(frozen=True)
  class Word:
      text: str; start: float; end: float; probability: float
  def load_words(path: str | Path) -> list[Word]           # reads T-41 *.words.json

  @dataclass(frozen=True)
  class Reference:
      book: str; osis: str; chapter: int
      verse: int | None = None; verse_end: int | None = None
      def display(self, canon: "Canon") -> str             # "1 Corinthians 6:19-20", "Psalm 122"
      def to_json(self) -> dict                            # schema shape; omits None keys

  # versesync/detect/canon.py
  @dataclass(frozen=True)
  class Book:
      name: str; display_name: str; osis: str; numbered: bool; base: str | None
      ordinal: int | None; chapter_count: int; verse_counts: tuple[int, ...]; aliases: tuple[str, ...]
  def normalise_alias(text: str) -> str                    # lowercase, ASCII-fold, strip punct, single spaces
  class Canon:
      books: tuple[Book, ...]
      def by_osis(self, osis: str) -> Book                 # KeyError if unknown
      def by_name(self, name: str) -> Book
      def lookup(self, text: str) -> Book | None           # normalises, then exact alias lookup
      def numbered_bases(self) -> frozenset[str]           # {"samuel","kings",…,"john"}
      def max_alias_tokens(self) -> int                    # longest alias in words, e.g. 3
      def verse_count(self, book: Book, chapter: int) -> int | None   # None if chapter invalid
  @functools.cache
  def load_canon() -> Canon
  ```
- **Steps:**
  1. Write `types.py`, with tests. `load_words` must round-trip every T-41 fixture, and
     `display` must give `1 Corinthians 6:19-20`, `John 3:16`, `Psalm 122` and `Romans 8`. Use a
     hyphen, never an en-dash. Commit.
  2. Write `canon.py`, with tests. Every alias resolves. `lookup("Philippians.")` and
     `lookup("PSALM")` both work. Loading takes under 50 ms when warm. Add a `canon` fixture to
     `conftest.py`. Commit.
- **Verify:** `pytest tests/test_canon.py -q`
- **Done when:**
  - [ ] The interface above is implemented exactly, and the names match.
  - [ ] Aliases are normalised once, at load time, not on every lookup.

## Traps

- **Psalm vs Psalms.** "Psalm 119" is how people say it. Both must resolve. The canonical
  `name` is `Psalms`; the display form is `Psalm`.
- 3 John has **14** verses in KJV. Some other traditions say 15. Keep KJV, which is the
  authority this plan chose.
