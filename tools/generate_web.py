"""Generate sidecar/versesync/bible/data/web.json.gz, the bundled World English Bible.

Run from the repo root:

    python tools/generate_web.py                          # downloads the pinned source below
    python tools/generate_web.py --source PKG.tgz         # use a local copy of it

The output is checked in; nothing fetches it at runtime.

Source
------
The World English Bible (WEB) is in the public domain. The text is taken from the npm package
``world-english-bible`` 1.0.1, a mechanical conversion of the eBible.org WEB HTML (the
Majority-Text New Testament edition) into one JSON file per book. The package's own npm metadata
says ``UNLICENSED`` because it declares no licence for its *code*; the verse text it carries is the
public-domain WEB and nothing else is bundled from it. eBible.org itself is not reachable from the
build environment that produced the checked-in file, so the npm tarball is the pinned source;
its SHA-256 and the registry's SHA-512 integrity string are verified before anything is read, and
both are recorded in the output.

Versification
-------------
The output is shaped exactly like ``detect/data/canon.json`` (66 books, 1,189 chapters, 31,102
verse slots, KJV versification) and the generator refuses to write anything that is not. WEB's
numbering differs from the KJV in two places, both handled here and listed in the output:

* Romans doxology. The Majority Text places it at the end of chapter 14. WEB prints it as
  Romans 14:24-26 and leaves Romans 16:25 empty with no 16:26-27. The KJV (and the canon table)
  has it at Romans 16:25-27 and ends chapter 14 at verse 23. The text is moved verbatim:
  WEB 14:24 -> 16:25, 14:25 -> 16:26, 14:26 -> 16:27.
* Verses the Majority Text omits. WEB prints the verse number with no text for Luke 17:36,
  Acts 8:37, Acts 15:34 and Acts 24:7. The slots exist in the canon, so they are stored as
  ``null``; the provider skips them in ranges and chapters and reports a request for exactly
  that verse as ``PassageNotFound``.

Psalm titles and other section headers are not numbered verses in KJV versification and are not
stored.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import re
import sys
import tarfile
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_NAME = "npm world-english-bible 1.0.1 (World English Bible, eBible.org HTML conversion)"
SOURCE_URL = "https://registry.npmjs.org/world-english-bible/-/world-english-bible-1.0.1.tgz"
SOURCE_SHA256 = "492d4692c06f0a64125d197a132a6f17a6448ac90ee1fd86ae50f2f6e8db8245"
SOURCE_INTEGRITY = (
    "sha512-OH/5yt9BYrhy1oBXXwhSuL9ES97t5Ij8rLWeQZUOIFAkoGzZaq8aLcKMBdzwHqPbJBkyMYPhgFj6rzvtT/"
    "oT4A=="
)
UPSTREAM_HOME = "https://ebible.org/web/"

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

# WEB (chapter, verse) -> canon (chapter, verse), per book OSIS id.
VERSE_MOVES: dict[str, dict[tuple[int, int], tuple[int, int]]] = {
    "Rom": {(14, 24): (16, 25), (14, 25): (16, 26), (14, 26): (16, 27)},
}
# Slots the canon has and the Majority Text leaves empty.
EXPECTED_OMITTED = {("Luke", 17, 36), ("Acts", 8, 37), ("Acts", 15, 34), ("Acts", 24, 7)}

_WS = re.compile(r"\s+")


def clean(text: str) -> str:
    return _WS.sub(" ", text).strip()


def _book_file(name: str) -> str:
    # The package names files after the book with the ordinal attached and spaces removed.
    return "package/json/" + name.lower().replace(" ", "") + ".json"


def read_tarball_members(blob: bytes) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for member in tar.getmembers():
            if member.isfile() and member.name.startswith("package/json/"):
                handle = tar.extractfile(member)
                if handle is not None:
                    out[member.name] = handle.read()
    return out


def verify_source(blob: bytes) -> str:
    sha256 = hashlib.sha256(blob).hexdigest()
    if sha256 != SOURCE_SHA256:
        raise SystemExit(f"source SHA-256 mismatch: got {sha256}, expected {SOURCE_SHA256}")
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode("ascii")
    if integrity != SOURCE_INTEGRITY:
        raise SystemExit(f"source integrity mismatch: got {integrity}")
    return sha256


def build(members: dict[str, bytes], canon: dict[str, Any]) -> dict[str, Any]:
    """Build the store from the package's per-book JSON files, aligned to the canon table."""
    books: dict[str, list[list[str | None]]] = {}
    omitted: list[str] = []
    moved: list[str] = []
    for book in canon["books"]:
        osis = book["osis"]
        entries = json.loads(members[_book_file(book["name"])].decode("utf-8"))
        verses: dict[tuple[int, int], str] = {}
        for entry in entries:
            if "verseNumber" in entry:
                key = (entry["chapterNumber"], entry["verseNumber"])
                verses[key] = verses.get(key, "") + " " + entry["value"]
        text = {key: clean(value) for key, value in verses.items()}

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
            "upstream": UPSTREAM_HOME,
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
    parser.add_argument("--source", type=Path, help="local copy of the pinned npm tarball")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)

    if args.source:
        blob = args.source.read_bytes()
    else:
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:  # noqa: S310
            blob = response.read()
    verify_source(blob)

    canon = json.loads(CANON_PATH.read_text(encoding="utf-8"))
    store = build(read_tarball_members(blob), canon)
    check_totals(store)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(serialise(store))
    print(f"wrote {args.output} ({args.output.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
