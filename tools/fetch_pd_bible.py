"""Download the public-domain KJV and write sidecar/versesync/bible/data/kjv.json.gz.

Usage: python tools/fetch_pd_bible.py [output-path]

The source is pinned by URL and SHA-256; a changed download is rejected.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = (
    "https://raw.githubusercontent.com/scrollmapper/bible_databases/"
    "master/formats/json/KJV.json"
)
SOURCE_SHA256 = "f0b09dc49dfb97bb84f03aae1fbf026485048c3cab31a7a41017e2d86ac1d11c"

DEFAULT_OUT = (
    Path(__file__).resolve().parent.parent
    / "sidecar" / "versesync" / "bible" / "data" / "kjv.json.gz"
)

# Canonical Protestant order with standard OSIS book ids.
OSIS_BOOKS = [
    "Gen", "Exod", "Lev", "Num", "Deut", "Josh", "Judg", "Ruth", "1Sam", "2Sam",
    "1Kgs", "2Kgs", "1Chr", "2Chr", "Ezra", "Neh", "Esth", "Job", "Ps", "Prov",
    "Eccl", "Song", "Isa", "Jer", "Lam", "Ezek", "Dan", "Hos", "Joel", "Amos",
    "Obad", "Jonah", "Mic", "Nah", "Hab", "Zeph", "Hag", "Zech", "Mal",
    "Matt", "Mark", "Luke", "John", "Acts", "Rom", "1Cor", "2Cor", "Gal", "Eph",
    "Phil", "Col", "1Thess", "2Thess", "1Tim", "2Tim", "Titus", "Phlm", "Heb",
    "Jas", "1Pet", "2Pet", "1John", "2John", "3John", "Jude", "Rev",
]

_STRONGS = re.compile(r"\{[^}]*\}|<[^>]*>")
_NOISE = re.compile(r"[\[\]¶]")
_SPACE = re.compile(r"\s+")


def clean(text: str) -> str:
    """Strip source markup (Strong's tags, brackets, pilcrows) and collapse whitespace."""
    text = _STRONGS.sub("", text)
    text = _NOISE.sub("", text)
    return _SPACE.sub(" ", text).strip()


def convert(source: dict) -> dict:
    books = source["books"]
    if len(books) != len(OSIS_BOOKS):
        raise ValueError(f"expected {len(OSIS_BOOKS)} books, got {len(books)}")
    out_books = []
    for osis, book in zip(OSIS_BOOKS, books):
        chapters = []
        for number, chapter in enumerate(book["chapters"], start=1):
            if chapter["chapter"] != number:
                raise ValueError(f"{osis}: chapter {chapter['chapter']} out of order")
            verses = []
            for vnum, verse in enumerate(chapter["verses"], start=1):
                if verse["verse"] != vnum:
                    raise ValueError(f"{osis} {number}: verse {verse['verse']} out of order")
                verses.append(clean(verse["text"]))
            chapters.append(verses)
        out_books.append({"osis": osis, "chapters": chapters})
    return {
        "translation": {
            "id": "kjv",
            "abbreviation": "KJV",
            "name": "King James Version",
            "attribution": "Public domain.",
        },
        "books": out_books,
    }


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    with urllib.request.urlopen(SOURCE_URL, timeout=120) as response:  # noqa: S310
        raw = response.read()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != SOURCE_SHA256:
        print(f"SHA-256 mismatch: expected {SOURCE_SHA256}, got {digest}", file=sys.stderr)
        return 1
    data = convert(json.loads(raw.decode("utf-8")))
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps the output byte-for-byte reproducible.
    with open(out, "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", mtime=0, compresslevel=9) as gz:
            gz.write(payload)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
