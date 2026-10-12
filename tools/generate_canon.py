"""Generate sidecar/versesync/detect/data/canon.json.

Run from the repo root:

    python tools/generate_canon.py                  # downloads the source below
    python tools/generate_canon.py --source KJV.json  # use a local copy of it

The output is checked in; nothing fetches it at runtime.

Authority for verse counts
--------------------------
King James Version (1769 text), public domain, as published in the scrollmapper
"bible_databases" collection (``formats/json/KJV.json``). Only the *shape* of that file is used
(chapters per book, verses per chapter); no verse text is read into the output. Versification is
the standard Protestant / KJV scheme: 66 books, 1,189 chapters, 31,102 verses. The generator
refuses to write a file whose totals differ from those numbers, and records the SHA-256 of the
source it consumed in the output so a regeneration can be audited.

Book metadata (canonical names, OSIS ids, aliases) lives in this file. OSIS ids follow the OSIS
2.1.1 book abbreviations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = (
    "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/KJV.json"
)
SOURCE_NAME = "scrollmapper/bible_databases KJV.json (King James Version, public domain)"

EXPECTED_BOOKS = 66
EXPECTED_CHAPTERS = 1189
EXPECTED_VERSES = 31102

SCHEMA_VERSION = 1
OUTPUT = Path(__file__).resolve().parent.parent / "sidecar/versesync/detect/data/canon.json"

# (source book name, canonical name, OSIS id, base aliases)
# For numbered books the canonical name and aliases omit the number; the ordinal forms are
# generated below. Aliases are written naturally; the loader normalises them
# (case, punctuation, digit/letter spacing), so "Gen." and "gen" need not both be listed.
BOOKS: list[tuple[str, str, str, list[str]]] = [
    ("Genesis", "Genesis", "Gen", ["Gen", "Ge", "Gn"]),
    ("Exodus", "Exodus", "Exod", ["Exod", "Exo", "Ex", "Exd"]),
    ("Leviticus", "Leviticus", "Lev", ["Lev", "Le", "Lv"]),
    ("Numbers", "Numbers", "Num", ["Num", "Nu", "Nm", "Nb"]),
    ("Deuteronomy", "Deuteronomy", "Deut", ["Deut", "Deu", "Dt"]),
    ("Joshua", "Joshua", "Josh", ["Josh", "Jos", "Jsh"]),
    ("Judges", "Judges", "Judg", ["Judg", "Jdg", "Jg", "Jdgs"]),
    ("Ruth", "Ruth", "Ruth", ["Ru", "Rth"]),
    ("I Samuel", "Samuel", "Sam", ["Sam", "Sa", "Sm"]),
    ("II Samuel", "Samuel", "Sam", ["Sam", "Sa", "Sm"]),
    ("I Kings", "Kings", "Kgs", ["Kgs", "Ki", "Kin", "King"]),
    ("II Kings", "Kings", "Kgs", ["Kgs", "Ki", "Kin", "King"]),
    ("I Chronicles", "Chronicles", "Chr", ["Chr", "Chron", "Ch"]),
    ("II Chronicles", "Chronicles", "Chr", ["Chr", "Chron", "Ch"]),
    ("Ezra", "Ezra", "Ezra", ["Ezr", "Ez"]),
    ("Nehemiah", "Nehemiah", "Neh", ["Neh", "Ne"]),
    ("Esther", "Esther", "Esth", ["Esth", "Est", "Es"]),
    ("Job", "Job", "Job", ["Jb"]),
    (
        "Psalms",
        "Psalms",
        "Ps",
        ["Psalm", "Ps", "Psa", "Psl", "Pslm", "Pss", "Psalter", "The Psalms", "The Psalm"],
    ),
    ("Proverbs", "Proverbs", "Prov", ["Prov", "Pro", "Prv", "Pr", "Proverb"]),
    (
        "Ecclesiastes",
        "Ecclesiastes",
        "Eccl",
        ["Eccl", "Eccles", "Ecc", "Ec", "Qoheleth", "Koheleth"],
    ),
    (
        "Song of Solomon",
        "Song of Solomon",
        "Song",
        [
            "Song of Songs",
            "Song of Soloman",
            "Songs of Solomon",
            "Song of Sol",
            "Songs of Songs",
            "Song",
            "Songs",
            "SOS",
            "SoS",
            "SS",
            "Canticles",
            "Canticle",
            "Canticle of Canticles",
            "Cant",
            "Sg",
        ],
    ),
    ("Isaiah", "Isaiah", "Isa", ["Isa"]),
    ("Jeremiah", "Jeremiah", "Jer", ["Jer", "Je", "Jr"]),
    ("Lamentations", "Lamentations", "Lam", ["Lam", "La", "Lamentation"]),
    ("Ezekiel", "Ezekiel", "Ezek", ["Ezek", "Eze", "Ezk"]),
    ("Daniel", "Daniel", "Dan", ["Dan", "Da", "Dn"]),
    ("Hosea", "Hosea", "Hos", ["Hos", "Ho"]),
    ("Joel", "Joel", "Joel", ["Joe", "Jl"]),
    ("Amos", "Amos", "Amos", ["Amo"]),
    ("Obadiah", "Obadiah", "Obad", ["Obad", "Oba", "Ob"]),
    ("Jonah", "Jonah", "Jonah", ["Jon", "Jnh"]),
    ("Micah", "Micah", "Mic", ["Mic", "Mi"]),
    ("Nahum", "Nahum", "Nah", ["Nah", "Na"]),
    ("Habakkuk", "Habakkuk", "Hab", ["Hab", "Hb"]),
    ("Zephaniah", "Zephaniah", "Zeph", ["Zeph", "Zep", "Zp"]),
    ("Haggai", "Haggai", "Hag", ["Hag", "Hg"]),
    ("Zechariah", "Zechariah", "Zech", ["Zech", "Zec", "Zc"]),
    ("Malachi", "Malachi", "Mal", ["Mal", "Ml"]),
    ("Matthew", "Matthew", "Matt", ["Matt", "Mat", "Mt"]),
    ("Mark", "Mark", "Mark", ["Mrk", "Mar", "Mk", "Mr"]),
    ("Luke", "Luke", "Luke", ["Luk", "Lk"]),
    ("John", "John", "John", ["Joh", "Jhn", "Jn"]),
    ("Acts", "Acts", "Acts", ["Act", "Ac", "Acts of the Apostles", "The Acts"]),
    ("Romans", "Romans", "Rom", ["Rom", "Ro", "Rm"]),
    ("I Corinthians", "Corinthians", "Cor", ["Cor", "Co"]),
    ("II Corinthians", "Corinthians", "Cor", ["Cor", "Co"]),
    ("Galatians", "Galatians", "Gal", ["Gal", "Ga"]),
    ("Ephesians", "Ephesians", "Eph", ["Eph", "Ephes"]),
    ("Philippians", "Philippians", "Phil", ["Phil", "Php", "Pp"]),
    ("Colossians", "Colossians", "Col", ["Col", "Co"]),
    ("I Thessalonians", "Thessalonians", "Thess", ["Thess", "Thes", "Th"]),
    ("II Thessalonians", "Thessalonians", "Thess", ["Thess", "Thes", "Th"]),
    ("I Timothy", "Timothy", "Tim", ["Tim", "Ti", "Tm"]),
    ("II Timothy", "Timothy", "Tim", ["Tim", "Ti", "Tm"]),
    ("Titus", "Titus", "Titus", ["Tit", "Ti"]),
    ("Philemon", "Philemon", "Phlm", ["Phlm", "Philem", "Phm", "Pm"]),
    ("Hebrews", "Hebrews", "Heb", ["Heb", "He"]),
    ("James", "James", "Jas", ["Jas", "Jm", "Jam"]),
    ("I Peter", "Peter", "Pet", ["Pet", "Pe", "Pt"]),
    ("II Peter", "Peter", "Pet", ["Pet", "Pe", "Pt"]),
    ("I John", "John", "John", ["Jn", "Jhn", "Joh"]),
    ("II John", "John", "John", ["Jn", "Jhn", "Joh"]),
    ("III John", "John", "John", ["Jn", "Jhn", "Joh"]),
    ("Jude", "Jude", "Jude", ["Jud", "Jd"]),
    (
        "Revelation of John",
        "Revelation",
        "Rev",
        [
            "Rev",
            "Re",
            "Revelations",
            "The Revelation",
            "Revelation of John",
            "Revelation of Jesus Christ",
            "Apocalypse",
        ],
    ),
]

ORDINAL_WORDS = {1: ["First", "1st", "I"], 2: ["Second", "2nd", "II"], 3: ["Third", "3rd", "III"]}


def _ordinal_of(source_name: str) -> int:
    first = source_name.split(" ", 1)[0]
    return {"I": 1, "II": 2, "III": 3}.get(first, 0)


def _norm(alias: str) -> str:
    """Mirror of the loader's normalisation, used to detect clashes at generation time."""
    out = []
    prev_digit = False
    for ch in alias.lower():
        if ch.isalnum():
            if out and prev_digit != ch.isdigit() and out[-1] != " ":
                out.append(" ")
            out.append(ch)
            prev_digit = ch.isdigit()
        else:
            if out and out[-1] != " ":
                out.append(" ")
            prev_digit = False
    return "".join(out).strip()


def build_aliases(canonical: str, osis: str, base: list[str], ordinal: int) -> list[str]:
    names = [canonical, *base]
    aliases: list[str] = []
    if ordinal == 0:
        aliases.extend(names)
        aliases.append(osis)
    else:
        for name in names:
            for prefix in [str(ordinal), *ORDINAL_WORDS[ordinal]]:
                aliases.append(f"{prefix} {name}")
            aliases.append(f"{ordinal}{name}")
        aliases.append(f"{ordinal}{osis}")
        aliases.append(f"{ordinal} {osis}")
    seen: set[str] = set()
    unique: list[str] = []
    for alias in aliases:
        key = _norm(alias)
        if key not in seen:
            seen.add(key)
            unique.append(alias)
    return unique


def load_source(path: Path | None) -> tuple[dict, str]:
    if path is not None:
        raw = path.read_bytes()
    else:
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as resp:  # noqa: S310
            raw = resp.read()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def verse_counts(book: dict) -> list[int]:
    counts: list[int] = []
    for expected, chapter in enumerate(book["chapters"], start=1):
        if chapter["chapter"] != expected:
            raise ValueError(f"{book['name']}: chapter {chapter['chapter']} out of order")
        numbers = [v["verse"] for v in chapter["verses"]]
        if numbers != list(range(1, len(numbers) + 1)):
            raise ValueError(f"{book['name']} {expected}: verse numbers are not 1..n")
        counts.append(len(numbers))
    return counts


def build(source: dict, digest: str) -> dict:
    src_books = source["books"]
    if len(src_books) != len(BOOKS):
        raise ValueError(f"source has {len(src_books)} books, expected {len(BOOKS)}")

    books = []
    owners: dict[str, str] = {}
    for order, (src, meta) in enumerate(zip(src_books, BOOKS, strict=True), start=1):
        source_name, canonical, osis, base = meta
        if src["name"] != source_name:
            raise ValueError(f"book {order}: source has {src['name']!r}, expected {source_name!r}")
        ordinal = _ordinal_of(source_name)
        display = f"{ordinal} {canonical}" if ordinal else canonical
        osis_id = f"{ordinal}{osis}" if ordinal else osis
        aliases = build_aliases(canonical, osis, base, ordinal)
        for alias in [display, *aliases]:
            key = _norm(alias)
            if owners.setdefault(key, osis_id) != osis_id:
                raise ValueError(f"alias {alias!r} claimed by {owners[key]} and {osis_id}")
        counts = verse_counts(src)
        books.append(
            {
                "order": order,
                "name": display,
                "osis": osis_id,
                "aliases": aliases,
                "chapter_count": len(counts),
                "verse_counts": counts,
            }
        )

    chapters = sum(b["chapter_count"] for b in books)
    verses = sum(sum(b["verse_counts"]) for b in books)
    if (len(books), chapters, verses) != (EXPECTED_BOOKS, EXPECTED_CHAPTERS, EXPECTED_VERSES):
        raise ValueError(f"unexpected totals: {len(books)} books, {chapters} chapters, {verses}")

    return {
        "schema_version": SCHEMA_VERSION,
        "versification": "KJV",
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_URL,
            "sha256": digest,
        },
        "totals": {"books": len(books), "chapters": chapters, "verses": verses},
        "books": books,
    }



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, help="local copy of the source KJV.json")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)

    source, digest = load_source(args.source)
    data = build(source, digest)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=True)
    # Keep the number and alias lists on one line each so the file diffs and reads sensibly.
    text = re.sub(
        r"\[\s*([^\[\]{}]*?)\s*\]",
        lambda m: "[" + re.sub(r"\s*\n\s*", " ", m.group(1)) + "]",
        text,
    )
    args.output.write_text(text + "\n", encoding="utf-8", newline="\n")
    totals = data["totals"]
    print(f"wrote {args.output}: {totals['books']} books, {totals['chapters']} chapters, "
          f"{totals['verses']} verses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
