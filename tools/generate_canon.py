"""Generate sidecar/versesync/detect/data/canon.json from the bundled KJV text.

Usage: python tools/generate_canon.py [output-path]

Chapter and verse counts come from kjv.json.gz, so the canon and the Bible text
can never disagree. Names, OSIS ids and aliases are the tables below.
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KJV_PATH = ROOT / "sidecar" / "versesync" / "bible" / "data" / "kjv.json.gz"
DEFAULT_OUT = ROOT / "sidecar" / "versesync" / "detect" / "data" / "canon.json"

# Ordinal prefix forms per ordinal: digit, word, short word, roman numeral, number word.
ORDINALS = {
    1: ["1", "first", "1st", "i", "one"],
    2: ["2", "second", "2nd", "ii", "two"],
    3: ["3", "third", "3rd", "iii", "three"],
}

# (osis, name, extra aliases). The normalised name is always an alias.
# Abbreviations that would be ambiguous between two books (jud, mar, ph) are left out.
SIMPLE_BOOKS = [
    ("Gen", "Genesis", ["gen", "ge", "gn"]),
    ("Exod", "Exodus", ["ex", "exod", "exo"]),
    ("Lev", "Leviticus", ["lev", "le", "lv"]),
    ("Num", "Numbers", ["num", "nu", "nm"]),
    ("Deut", "Deuteronomy", ["deut", "dt", "deu"]),
    ("Josh", "Joshua", ["josh", "jos"]),
    ("Judg", "Judges", ["judg", "jdg", "jg"]),
    ("Ruth", "Ruth", ["ru"]),
    ("Ezra", "Ezra", ["ezr"]),
    ("Neh", "Nehemiah", ["neh", "ne"]),
    ("Esth", "Esther", ["esth", "est", "es"]),
    ("Job", "Job", ["jb"]),
    ("Ps", "Psalms", ["psalm", "ps", "psa", "pslm", "psm", "pss"]),
    ("Prov", "Proverbs", ["prov", "pro", "prv", "pr"]),
    ("Eccl", "Ecclesiastes", ["eccl", "eccles", "ecc", "ec", "qoheleth"]),
    ("Song", "Song of Solomon", [
        "song of songs", "song", "sos", "song of sol", "canticles", "canticle of canticles",
    ]),
    ("Isa", "Isaiah", ["isa", "is"]),
    ("Jer", "Jeremiah", ["jer", "je"]),
    ("Lam", "Lamentations", ["lam", "la"]),
    ("Ezek", "Ezekiel", ["ezek", "eze", "ezk"]),
    ("Dan", "Daniel", ["dan", "da", "dn"]),
    ("Hos", "Hosea", ["hos", "ho"]),
    ("Joel", "Joel", ["jl"]),
    ("Amos", "Amos", ["am"]),
    ("Obad", "Obadiah", ["obad", "ob"]),
    ("Jonah", "Jonah", ["jon", "jnh"]),
    ("Mic", "Micah", ["mic", "mc"]),
    ("Nah", "Nahum", ["nah", "na"]),
    ("Hab", "Habakkuk", ["hab", "hb"]),
    ("Zeph", "Zephaniah", ["zeph", "zep", "zp"]),
    ("Hag", "Haggai", ["hag", "hg"]),
    ("Zech", "Zechariah", ["zech", "zec", "zc"]),
    ("Mal", "Malachi", ["mal", "ml"]),
    ("Matt", "Matthew", ["matt", "mat", "mt"]),
    ("Mark", "Mark", ["mrk", "mk"]),
    ("Luke", "Luke", ["luk", "lk"]),
    ("John", "John", ["jn", "jhn"]),
    ("Acts", "Acts", ["act", "ac", "acts of the apostles"]),
    ("Rom", "Romans", ["rom", "ro", "rm"]),
    ("Gal", "Galatians", ["gal", "ga"]),
    ("Eph", "Ephesians", ["eph", "ephes"]),
    ("Phil", "Philippians", ["phil", "php", "pp"]),
    ("Col", "Colossians", ["col", "co"]),
    ("Titus", "Titus", ["tit", "ti"]),
    ("Phlm", "Philemon", ["philem", "phlm", "phm"]),
    ("Heb", "Hebrews", ["heb", "he"]),
    ("Jas", "James", ["jas", "jam", "jm"]),
    ("Jude", "Jude", ["jude"]),
    ("Rev", "Revelation", [
        "revelations", "rev", "re", "rv", "revelation of john", "apocalypse",
    ]),
]

# (osis stem, base display name, abbreviations of the base, ordinals)
NUMBERED_BOOKS = [
    ("Sam", "Samuel", ["sam", "sa", "sm"], (1, 2)),
    ("Kgs", "Kings", ["kgs", "ki", "kin", "king"], (1, 2)),
    ("Chr", "Chronicles", ["chr", "chron", "ch", "chronicle"], (1, 2)),
    ("Cor", "Corinthians", ["cor", "co", "corinth"], (1, 2)),
    ("Thess", "Thessalonians", ["thess", "thes", "th"], (1, 2)),
    ("Tim", "Timothy", ["tim", "ti", "tm"], (1, 2)),
    ("Pet", "Peter", ["pet", "pe", "pt"], (1, 2)),
    ("John", "John", ["jn", "jhn", "jo"], (1, 2, 3)),
]

# Position of each book in canonical order is taken from the KJV file's OSIS ids.


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", " ", text.lower())
    return " ".join(text.split())


def _entries() -> dict[str, dict]:
    entries: dict[str, dict] = {}
    for osis, name, extra in SIMPLE_BOOKS:
        aliases = {normalise(name)} | {normalise(a) for a in extra}
        entries[osis] = {
            "name": name,
            "display_name": "Psalm" if osis == "Ps" else name,
            "osis": osis,
            "numbered": False,
            "base": None,
            "ordinal": None,
            "aliases": aliases,
        }
    for stem, base, abbreviations, ordinals in NUMBERED_BOOKS:
        for n in ordinals:
            name = f"{n} {base}"
            forms = [base.lower()] + abbreviations
            aliases = {normalise(f"{prefix} {form}") for prefix in ORDINALS[n] for form in forms}
            entries[f"{n}{stem}"] = {
                "name": name,
                "display_name": name,
                "osis": f"{n}{stem}",
                "numbered": True,
                "base": base.lower(),
                "ordinal": n,
                "aliases": aliases,
            }
    return entries


def build(kjv_path: Path = KJV_PATH) -> list[dict]:
    with gzip.open(kjv_path, "rt", encoding="utf-8") as fh:
        kjv = json.load(fh)
    entries = _entries()
    canon = []
    for book in kjv["books"]:
        entry = dict(entries.pop(book["osis"]))
        entry["chapter_count"] = len(book["chapters"])
        entry["verse_counts"] = [len(chapter) for chapter in book["chapters"]]
        entry["aliases"] = sorted(entry["aliases"])
        canon.append(entry)
    if entries:
        raise SystemExit(f"books missing from the KJV file: {sorted(entries)}")
    owner: dict[str, str] = {}
    for entry in canon:
        for alias in entry["aliases"]:
            if alias in owner and owner[alias] != entry["osis"]:
                raise SystemExit(f"alias {alias!r} maps to {owner[alias]} and {entry['osis']}")
            owner[alias] = entry["osis"]
    return canon


def render(canon: list[dict]) -> str:
    return json.dumps(canon, indent=1, sort_keys=True, ensure_ascii=True) + "\n"


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(render(build()))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
