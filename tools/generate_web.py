"""Generate sidecar/versesync/bible/data/web.json.gz, the bundled World English Bible.

Run from the repo root:

    python tools/generate_web.py                      # downloads the pinned source below
    python tools/generate_web.py --source FILE.zip     # use a local copy of it

The output is checked in; nothing fetches it at runtime.

Source
------
The World English Bible (WEB) is in the public domain. The text is fetched directly from
eBible.org, the WEB's official distribution point (https://ebible.org/find/details.php?id=eng-web),
as the USFX archive:

    https://eBible.org/Scriptures/eng-web_usfx.zip

fetched 2026-10-13. Its SHA-256 is pinned below and verified before anything is read. USFX is a
single XML file (``eng-web_usfx.xml`` inside the archive) with explicit, self-closing ``<v
bcv="BOOK.C.V"/>`` / ``<ve/>`` verse-boundary markers, ``<f>``/``<x>`` footnote and
cross-reference elements, and ``<d>`` descriptive (Psalm) titles -- all of which this generator
needs to tell verse text apart from surrounding markup and headers. Only the 66 Protestant-canon
books are read, via ``OSIS_CODE_USFX`` below, which maps each canon-table OSIS id to its USFX book
id (these differ from OSIS in a few places, e.g. John is ``JHN``, Song of Solomon is ``SNG``).

Parsing
-------
``_walk`` replays each ``<book>`` element's content in document order (text, then each child,
then that child's tail), which is how USFX's milestone markers have to be read: ``<v>`` and
``<ve/>`` are not containers, they are flat siblings alongside the words and punctuation they
bound. Verse text is whatever appears between a ``<v>`` and the next ``<v>``/``<ve/>``.
``<f>`` (footnotes), ``<x>`` (cross-references) and ``<d>`` (descriptive/Psalm titles) are never
recursed into, so footnote and cross-reference text never leaks into a verse and a Psalm's title
(for example "A Psalm by David.") is correctly excluded rather than folded into verse 1.

Versification
-------------
The output is shaped exactly like ``detect/data/canon.json`` (66 books, 1,189 chapters, 31,102
verse slots, KJV versification) and the generator refuses to write anything that is not. eBible's
WEB numbering differs from the KJV in two places, both handled here and listed in the output:

* Romans doxology. The Majority Text places it at the end of chapter 14. eBible's WEB prints it
  as Romans 14:24-26 and leaves Romans 16:25 empty with no 16:26-27. The KJV (and the canon table)
  has it at Romans 16:25-27 and ends chapter 14 at verse 23. The text is moved verbatim:
  WEB 14:24 -> 16:25, 14:25 -> 16:26, 14:26 -> 16:27.
* Verses the Majority Text omits. eBible's WEB prints the verse number with no text for
  Luke 17:36, Acts 8:37, Acts 15:34 and Acts 24:7. The slots exist in the canon, so they are
  stored as ``null``; the provider skips them in ranges and chapters and reports a request for
  exactly that verse as ``PassageNotFound``.

Psalm titles and other section headers are not numbered verses in KJV versification and are not
stored (see Parsing above).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Iterator

SOURCE_NAME = "eBible.org eng-web (World English Bible, Classic edition), USFX"
SOURCE_URL = "https://eBible.org/Scriptures/eng-web_usfx.zip"
SOURCE_SHA256 = "e6a433c6b27bbcd457dfadad2953b6b0e14c510eee7cca0f14aad32334936d3a"
FETCH_DATE = "2026-10-13"
UPSTREAM_DETAILS = "https://ebible.org/find/details.php?id=eng-web"
ARCHIVE_MEMBER = "eng-web_usfx.xml"

SCHEMA_VERSION = 1
ROOT = Path(__file__).resolve().parent.parent
CANON_PATH = ROOT / "sidecar/versesync/detect/data/canon.json"
OUTPUT = ROOT / "sidecar/versesync/bible/data/web.json.gz"

TRANSLATION = {
    "id": "web",
    "abbreviation": "WEB",
    "name": "World English Bible",
    "attribution": "World English Bible (WEB). Public domain.",
    "cache_allowed": True,
}

# Canon-table OSIS id -> USFX book id. USFX ids match OSIS almost everywhere, but not quite:
# John is JHN (OSIS: John), Song of Solomon is SNG, Joel is JOL, Nahum is NAM, Philippians is
# PHP, James is JAS, 1/2/3 John are 1JN/2JN/3JN. Deuterocanon ids in the archive (TOB, JDT, ESG,
# WIS, SIR, BAR, 1MA, 2MA, 1ES, PRM, PS2, 3MA, 2ES, 4MA) are not in this map and are never read.
OSIS_CODE_USFX: dict[str, str] = {
    "Gen": "GEN", "Exod": "EXO", "Lev": "LEV", "Num": "NUM", "Deut": "DEU",
    "Josh": "JOS", "Judg": "JDG", "Ruth": "RUT", "1Sam": "1SA", "2Sam": "2SA",
    "1Kgs": "1KI", "2Kgs": "2KI", "1Chr": "1CH", "2Chr": "2CH", "Ezra": "EZR",
    "Neh": "NEH", "Esth": "EST", "Job": "JOB", "Ps": "PSA", "Prov": "PRO",
    "Eccl": "ECC", "Song": "SNG", "Isa": "ISA", "Jer": "JER", "Lam": "LAM",
    "Ezek": "EZK", "Dan": "DAN", "Hos": "HOS", "Joel": "JOL", "Amos": "AMO",
    "Obad": "OBA", "Jonah": "JON", "Mic": "MIC", "Nah": "NAM", "Hab": "HAB",
    "Zeph": "ZEP", "Hag": "HAG", "Zech": "ZEC", "Mal": "MAL", "Matt": "MAT",
    "Mark": "MRK", "Luke": "LUK", "John": "JHN", "Acts": "ACT", "Rom": "ROM",
    "1Cor": "1CO", "2Cor": "2CO", "Gal": "GAL", "Eph": "EPH", "Phil": "PHP",
    "Col": "COL", "1Thess": "1TH", "2Thess": "2TH", "1Tim": "1TI", "2Tim": "2TI",
    "Titus": "TIT", "Phlm": "PHM", "Heb": "HEB", "Jas": "JAS", "1Pet": "1PE",
    "2Pet": "2PE", "1John": "1JN", "2John": "2JN", "3John": "3JN", "Jude": "JUD",
    "Rev": "REV",
}

# WEB (chapter, verse) -> canon (chapter, verse), per book OSIS id.
VERSE_MOVES: dict[str, dict[tuple[int, int], tuple[int, int]]] = {
    "Rom": {(14, 24): (16, 25), (14, 25): (16, 26), (14, 26): (16, 27)},
}
# Slots the canon has and the Majority Text leaves empty.
EXPECTED_OMITTED = {("Luke", 17, 36), ("Acts", 8, 37), ("Acts", 15, 34), ("Acts", 24, 7)}

_WS = re.compile(r"\s+")
# Elements whose content (text and all descendants) is never part of verse text: footnotes,
# cross-references, and descriptive/Psalm titles.
_SKIP_TAGS = {"f", "x", "d"}


def clean(text: str) -> str:
    return _WS.sub(" ", text).strip()


def verify_source(blob: bytes) -> str:
    sha256 = hashlib.sha256(blob).hexdigest()
    if sha256 != SOURCE_SHA256:
        raise SystemExit(f"source SHA-256 mismatch: got {sha256}, expected {SOURCE_SHA256}")
    return sha256


def _walk(elem: ET.Element) -> Iterator[str | tuple[str] | tuple[str, str]]:
    """Replay ``elem``'s content in document order: text, then each child (tag event, then its
    own content unless it's a skip-tag, then its tail). ``<v>``/``<ve/>`` are milestones, not
    containers, so this is the only way to know what text falls between them."""
    if elem.text:
        yield elem.text
    for child in elem:
        tag = child.tag
        if tag == "v":
            yield ("v", child.attrib.get("bcv", ""))
        elif tag == "ve":
            yield ("ve",)
        elif tag in _SKIP_TAGS:
            pass
        else:
            yield from _walk(child)
        if child.tail:
            yield child.tail


def extract_book(book_elem: ET.Element) -> dict[tuple[int, int], str]:
    """Return ``{(chapter, verse): text}`` for every verse milestone in a USFX ``<book>``."""
    text: dict[tuple[int, int], str] = {}
    current: tuple[int, int] | None = None
    buf: list[str] = []
    for event in _walk(book_elem):
        if isinstance(event, str):
            if current is not None:
                buf.append(event)
            continue
        if current is not None:
            text[current] = text.get(current, "") + "".join(buf)
        buf = []
        if event[0] == "v":
            _, chapter, verse = event[1].split(".")
            current = (int(chapter), int(verse))
            text.setdefault(current, "")
        else:  # "ve"
            current = None
    if current is not None:
        text[current] = text.get(current, "") + "".join(buf)
    return text


def read_usfx_books(blob: bytes) -> dict[str, dict[tuple[int, int], str]]:
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        raw = zf.read(ARCHIVE_MEMBER)
    root = ET.fromstring(raw)
    wanted = set(OSIS_CODE_USFX.values())
    return {
        book_elem.get("id"): extract_book(book_elem)
        for book_elem in root.findall("book")
        if book_elem.get("id") in wanted
    }


def build(
    usfx_books: dict[str, dict[tuple[int, int], str]], canon: dict[str, Any]
) -> dict[str, Any]:
    """Build the store from the USFX verse texts, aligned to the canon table."""
    books: dict[str, list[list[str | None]]] = {}
    omitted: list[str] = []
    moved: list[str] = []
    for book in canon["books"]:
        osis = book["osis"]
        usfx_id = OSIS_CODE_USFX[osis]
        text = {key: clean(value) for key, value in usfx_books[usfx_id].items()}

        for src, dst in VERSE_MOVES.get(osis, {}).items():
            if src not in text or text.get(dst):
                raise SystemExit(f"unexpected source layout for {osis} {src} -> {dst}")
            text[dst] = text.pop(src)
            moved.append(f"{osis}.{src[0]}.{src[1]}>{osis}.{dst[0]}.{dst[1]}")

        counts: list[int] = book["verse_counts"]
        expected = {(c + 1, v + 1) for c, n in enumerate(counts) for v in range(n)}
        if set(text) != expected:
            extra = sorted(set(text) - expected)
            missing = sorted(expected - set(text))
            raise SystemExit(f"{osis}: versification mismatch, extra={extra} missing={missing}")

        chapters: list[list[str | None]] = []
        for c, n in enumerate(counts, start=1):
            row: list[str | None] = []
            for v in range(1, n + 1):
                value = text[(c, v)]
                if value:
                    row.append(value)
                else:
                    row.append(None)
                    omitted.append(f"{osis}.{c}.{v}")
            chapters.append(row)
        books[osis] = chapters

    found = {(o.split(".")[0], int(o.split(".")[1]), int(o.split(".")[2])) for o in omitted}
    wanted = {
        (next(b["osis"] for b in canon["books"] if b["name"] == n), c, v)
        for n, c, v in EXPECTED_OMITTED
    }
    if found != wanted:
        raise SystemExit(f"omitted verses differ from the documented set: {sorted(found)}")

    return {
        "schema_version": SCHEMA_VERSION,
        "translation": TRANSLATION,
        "versification": canon["versification"],
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_URL,
            "sha256": SOURCE_SHA256,
            "fetch_date": FETCH_DATE,
            "upstream": UPSTREAM_DETAILS,
        },
        "moved": sorted(moved),
        "omitted": sorted(omitted),
        "books": books,
    }


def check_totals(store: dict[str, Any]) -> None:
    books = store["books"]
    chapters = sum(len(c) for c in books.values())
    slots = sum(len(v) for c in books.values() for v in c)
    if (len(books), chapters, slots) != (66, 1189, 31102):
        raise SystemExit(f"unexpected totals: {len(books)} books, {chapters} chapters, {slots}")


def serialise(store: dict[str, Any]) -> bytes:
    raw = json.dumps(store, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # mtime=0 keeps the archive byte-for-byte reproducible.
    return gzip.compress(raw, compresslevel=9, mtime=0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, help="local copy of the pinned eBible.org archive")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)

    if args.source:
        blob = args.source.read_bytes()
    else:
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:  # noqa: S310
            blob = response.read()
    verify_source(blob)

    canon = json.loads(CANON_PATH.read_text(encoding="utf-8"))
    store = build(read_usfx_books(blob), canon)
    check_totals(store)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(serialise(store))
    print(f"wrote {args.output} ({args.output.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
