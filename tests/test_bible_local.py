from __future__ import annotations

import gzip
import io
import json
import xml.sax.saxutils as saxutils
import zipfile
from pathlib import Path

import generate_web
import pytest

from versesync.bible import local as local_mod
from versesync.bible.base import (
    BibleProvider,
    PassageNotFound,
    ProviderError,
    ProviderUnavailable,
    RawPassage,
    RawVerse,
    Reference,
    Translation,
    TranslationNotLicensed,
)
from versesync.bible.format import format_passage, strip_markup, to_verseflow_txt
from versesync.bible.local import LocalProvider
from versesync.detect.canon import load_canon

pytestmark = pytest.mark.usefixtures("no_network")

provider = LocalProvider()
WEB = provider.list_translations()[0]


def passage(book: str, chapter: int, verse: int | None = None, end: int | None = None):
    return format_passage(
        provider.fetch(Reference(book, chapter, verse, end), "web"), WEB, source="local"
    )


def test_implements_the_protocol() -> None:
    assert isinstance(provider, BibleProvider)
    assert provider.id == "local"
    assert WEB.abbreviation == "WEB" and WEB.cache_allowed
    assert "Public domain" in WEB.attribution


def test_bundled_store_lines_up_with_canon() -> None:
    canon = load_canon()
    total = 0
    omitted = []
    for book in canon.books:
        for chapter, count in enumerate(book.verse_counts, start=1):
            raw = provider.fetch_chapter(book.osis, chapter, "web")
            numbers = [v.number for v in raw.verses]
            assert numbers == sorted(set(numbers))
            assert all(1 <= n <= count for n in numbers)
            total += len(numbers)
            omitted += [(book.osis, chapter, n) for n in range(1, count + 1) if n not in numbers]
    assert omitted == [("Luke", 17, 36), ("Acts", 8, 37), ("Acts", 15, 34), ("Acts", 24, 7)]
    assert total == 31102 - 4


def test_documented_versification_handling() -> None:
    # Romans: the doxology sits at 16:25-27 as in the KJV and the canon; chapter 14 ends at 23.
    assert provider.fetch_chapter("Rom", 14, "web").verses[-1].number == 23
    doxology = provider.fetch(Reference("Rom", 16, 25, 27), "web")
    assert [v.number for v in doxology.verses] == [25, 26, 27]
    assert doxology.verses[0].text.startswith("Now to him who is able to establish you")
    assert doxology.verses[2].text.endswith("forever! Amen.")
    # Verses the Majority Text omits: skipped inside ranges and chapters, an error alone.
    with pytest.raises(PassageNotFound):
        provider.fetch(Reference("Acts", 8, 37), "web")
    acts = provider.fetch(Reference("Acts", 8, 36, 38), "web")
    assert [v.number for v in acts.verses] == [36, 38]
    assert passage("Acts", 8, 36, 38).reference_display == "Acts 8:36-38 (WEB)"


def test_psalm_titles_are_not_verses() -> None:
    assert provider.fetch(Reference("Ps", 3, 1), "web").verses[0].text.startswith("Yahweh, how")


def test_single_verse_range_and_chapter_format() -> None:
    john = passage("John", 3, 16)
    assert john.reference_display == "John 3:16 (WEB)"
    assert john.body == (
        "16 For God so loved the world, that he gave his only born Son, that whoever "
        "believes in him should not perish, but have eternal life."
    )
    assert [(v.verse, v.text) for v in john.verses] == [(16, john.body[3:])]
    assert john.word_count == len(john.body.split())
    assert not john.truncated and john.source == "local" and john.translation == WEB

    rng = passage("1Cor", 6, 19, 20)
    assert rng.reference_display == "1 Corinthians 6:19-20 (WEB)"
    assert rng.body.startswith("19 ") and " 20 " in rng.body
    assert [v.verse for v in rng.verses] == [19, 20]

    chapter = passage("Jude", 1)
    assert chapter.reference_display == "Jude 1:1-25 (WEB)"
    assert len(chapter.verses) == 25 and chapter.body.startswith("1 ")
    assert "  " not in chapter.body and chapter.body == chapter.body.strip()


def test_reference_uses_canon_spelling_and_a_plain_hyphen() -> None:
    p = passage("Song", 2, 1, 3)
    assert p.reference_display == "Song of Solomon 2:1-3 (WEB)"
    assert "–" not in p.reference_display and "—" not in p.reference_display


def test_max_verses_truncates() -> None:
    raw = provider.fetch(Reference("Ps", 23), "web")
    p = format_passage(raw, WEB, source="local", max_verses=2)
    assert p.truncated and p.reference_display == "Psalms 23:1-2 (WEB)"
    assert [v.verse for v in p.verses] == [1, 2]
    assert not format_passage(raw, WEB, source="local", max_verses=6).truncated


def test_txt_block_layout() -> None:
    a, b = passage("John", 3, 16), passage("Jude", 1, 3)
    txt = to_verseflow_txt([a, b])
    assert txt == f"{a.reference_display}\n{a.body}\n\n{b.reference_display}\n{b.body}\n\n"


@pytest.mark.parametrize(
    ("markup", "expected"),
    [
        ("<p>In the <b>beginning</b>&nbsp;God</p>", "In the beginning God"),
        ("Word<sup>a</sup> and<note>See Gen 1:1</note> more", "Word and more"),
        ('<span class="wj">I am the way</span>', "I am the way"),
        (
            r"\p \v 3 In the \add beginning\add* was \wj the Word\wj*",
            "In the beginning was the Word",
        ),
        (r"loved\f + \fr 3:16 \ft Or only begotten\f* the world", "loved the world"),
        (r"see\x - \xo 1:1 \xt Gen 1:1\x* this", "see this"),
        (r'\w God|strong="H430"\w* made', "God made"),
        ("¶ He said,\n\n  “Go.”  ", "He said, “Go.”"),
        ("Tom &amp; Jerry<!-- c -->", "Tom & Jerry"),
    ],
)
def test_strip_markup(markup: str, expected: str) -> None:
    assert strip_markup(markup) == expected


def test_format_strips_provider_markup_and_keeps_verse_numbers() -> None:
    raw = RawPassage(
        "x",
        "t",
        "John",
        3,
        (RawVerse(16, "<p>For <i>God</i> so loved</p>"), RawVerse(17, r"\p Sent")),
    )
    tr = Translation("t", "TST", "Test", "attr", False)
    p = format_passage(raw, tr, source="api")
    assert p.reference_display == "John 3:16-17 (TST)"
    assert p.body == "16 For God so loved 17 Sent"
    assert p.source == "api"


def test_format_drops_verses_that_are_empty_after_stripping() -> None:
    tr = Translation("t", "TST", "Test", "attr", False)
    raw = RawPassage("x", "t", "John", 3, (RawVerse(15, "<p> </p>"), RawVerse(16, "Text")))
    assert format_passage(raw, tr, source="x").reference_display == "John 3:16 (TST)"
    with pytest.raises(PassageNotFound):
        format_passage(RawPassage("x", "t", "John", 3, (RawVerse(1, "<br/>"),)), tr, source="x")
    with pytest.raises(PassageNotFound):
        format_passage(RawPassage("x", "t", "Nope", 3, (RawVerse(1, "a"),)), tr, source="x")


# --- error taxonomy: every failure is typed, never bare -----------------------------------


@pytest.mark.parametrize(
    ("ref", "translation", "error"),
    [
        (Reference("John", 3, 16), "nkjv", TranslationNotLicensed),
        (Reference("John", 3, 16), "", TranslationNotLicensed),
        (Reference("Hezekiah", 1, 1), "web", PassageNotFound),
        (Reference("John", 22, 1), "web", PassageNotFound),
        (Reference("John", 0, 1), "web", PassageNotFound),
        (Reference("John", -1), "web", PassageNotFound),
        (Reference("John", 3, 37), "web", PassageNotFound),
        (Reference("John", 3, 0), "web", PassageNotFound),
        (Reference("John", 3, 18, 16), "web", PassageNotFound),
        (Reference("John", 3, 30, 40), "web", PassageNotFound),
        (Reference("John", 3, None, 5), "web", PassageNotFound),
        (Reference("Luke", 17, 36), "web", PassageNotFound),
        (Reference("Acts", 15, 34), "web", PassageNotFound),
        (Reference("Rom", 14, 24), "web", PassageNotFound),
    ],
)
def test_fetch_errors_are_typed(
    ref: Reference, translation: str, error: type[ProviderError]
) -> None:
    with pytest.raises(error) as info:
        provider.fetch(ref, translation)
    assert isinstance(info.value, ProviderError)


def test_fetch_chapter_errors_are_typed() -> None:
    with pytest.raises(PassageNotFound):
        provider.fetch_chapter("John", 99, "web")
    with pytest.raises(TranslationNotLicensed):
        provider.fetch_chapter("John", 3, "esv")


def test_taxonomy_hierarchy() -> None:
    for exc in (ProviderUnavailable, PassageNotFound, TranslationNotLicensed):
        assert issubclass(exc, ProviderError)
    from versesync.bible.base import RateLimited

    assert issubclass(RateLimited, ProviderError)


def _bundled_store() -> dict:
    blob = (local_mod.resources.files("versesync.bible") / "data" / "web.json.gz").read_bytes()
    return json.loads(gzip.decompress(blob))


@pytest.mark.parametrize(
    "kind",
    [
        "missing",
        "empty",
        "not-gzip",
        "not-json",
        "bad-schema",
        "short-chapter",
        "missing-book",
        "wrong-types",
    ],
)
def test_unreadable_or_misaligned_stores_are_provider_unavailable(
    tmp_path: Path, kind: str
) -> None:
    path = tmp_path / "store.json.gz"
    store = _bundled_store()
    if kind == "missing":
        pass
    elif kind == "empty":
        path.write_bytes(b"")
    elif kind == "not-gzip":
        path.write_bytes(b"plain text")
    elif kind == "not-json":
        path.write_bytes(gzip.compress(b"{nope"))
    elif kind == "bad-schema":
        store["schema_version"] = 99
        path.write_bytes(gzip.compress(json.dumps(store).encode()))
    elif kind == "short-chapter":
        store["books"]["John"][2].pop()
        path.write_bytes(gzip.compress(json.dumps(store).encode()))
    elif kind == "missing-book":
        del store["books"]["Jude"]
        path.write_bytes(gzip.compress(json.dumps(store).encode()))
    else:
        store["books"]["John"] = 5
        path.write_bytes(gzip.compress(json.dumps(store).encode()))
    bad = LocalProvider(path)
    with pytest.raises(ProviderUnavailable):
        bad.list_translations()
    with pytest.raises(ProviderUnavailable):
        bad.fetch(Reference("John", 3, 16), "web")
    with pytest.raises(ProviderUnavailable):
        bad.fetch_chapter("John", 3, "web")


def test_alternate_store_path_is_served(tmp_path: Path) -> None:
    store = _bundled_store()
    store["translation"].update(id="alt", abbreviation="ALT", name="Alt")
    path = tmp_path / "alt.json.gz"
    path.write_bytes(gzip.compress(json.dumps(store).encode()))
    alt = LocalProvider(path)
    assert [t.id for t in alt.list_translations()] == ["alt"]
    raw = alt.fetch(Reference("John", 3, 16), "alt")
    assert raw.translation_id == "alt"
    with pytest.raises(TranslationNotLicensed):
        alt.fetch(Reference("John", 3, 16), "web")


# --- the generator -------------------------------------------------------------------------


def _book_usfx_xml(osis: str, chapters: list[list[str | None]]) -> str:
    """Rebuild a USFX ``<book>`` element (Romans doxology back at 14:24-26) from a bundled book."""
    code = generate_web.OSIS_CODE_USFX[osis]
    parts = [f'<book id="{code}">']
    if osis == "Ps":
        # A descriptive title must never leak into verse 1's text.
        parts.append("<d>A Psalm by David.</d>")
    for c, chapter in enumerate(chapters, start=1):
        parts.append(f'<c id="{c}" />')
        for v, text in enumerate(chapter, start=1):
            cc, vv = c, v
            if osis == "Rom" and (c, v) in {(16, 25), (16, 26), (16, 27)}:
                cc, vv = 14, v - 1
            if osis == "Rom" and (c, v) == (16, 25):
                # The leftover empty placeholder the real source leaves at 16:25.
                parts.append(f'<v id="25" bcv="{code}.16.25" /><ve />')
            body = saxutils.escape(text or "")
            if osis == "Jude" and (c, v) == (1, 1):
                # A footnote and a cross-reference must never leak into verse text either.
                body = body + '<f caller="+"><ft>a note</ft></f><x><xt>Jas 1:1</xt></x>'
            parts.append(f'<v id="{vv}" bcv="{code}.{cc}.{vv}" />{body}<ve />')
    parts.append("</book>")
    return "".join(parts)


def _fake_usfx_zip(store: dict) -> bytes:
    books_xml = "".join(
        _book_usfx_xml(book.osis, store["books"][book.osis]) for book in load_canon().books
    )
    xml = f'<?xml version="1.0" encoding="utf-8"?><usfx>{books_xml}</usfx>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(generate_web.ARCHIVE_MEMBER, xml.encode("utf-8"))
    return buf.getvalue()


def test_walk_and_extract_book_strip_titles_footnotes_and_crossrefs() -> None:
    xml = (
        '<book id="PSA"><d>A Psalm by David.</d>'
        '<v id="1" bcv="PSA.3.1" />Yahweh<f><ft>note</ft></f>, how<x><xt>ref</xt></x>'
        " are you.<ve />"
        '<v id="2" bcv="PSA.3.2" />Second verse.<ve />'
        "</book>"
    )
    import xml.etree.ElementTree as ET

    book_elem = ET.fromstring(xml)
    extracted = generate_web.extract_book(book_elem)
    assert generate_web.clean(extracted[(3, 1)]) == "Yahweh, how are you."
    assert generate_web.clean(extracted[(3, 2)]) == "Second verse."


def test_generator_reproduces_the_bundled_store() -> None:
    canon = json.loads(generate_web.CANON_PATH.read_text(encoding="utf-8"))
    store = _bundled_store()
    built = generate_web.build(generate_web.read_usfx_books(_fake_usfx_zip(store)), canon)
    generate_web.check_totals(built)
    assert built == store
    assert generate_web.serialise(built) == generate_web.OUTPUT.read_bytes()
    assert built["source"]["sha256"] == generate_web.SOURCE_SHA256
    assert built["omitted"] == ["Acts.15.34", "Acts.24.7", "Acts.8.37", "Luke.17.36"]
    assert built["moved"] == ["Rom.14.24>Rom.16.25", "Rom.14.25>Rom.16.26", "Rom.14.26>Rom.16.27"]


def test_generator_rejects_misaligned_source() -> None:
    canon = json.loads(generate_web.CANON_PATH.read_text(encoding="utf-8"))
    store = _bundled_store()
    blob = _fake_usfx_zip(store)
    usfx_books = generate_web.read_usfx_books(blob)
    usfx_books["JUD"][(1, 26)] = "x"
    with pytest.raises(SystemExit, match="versification mismatch"):
        generate_web.build(usfx_books, canon)


def test_generator_verifies_the_pinned_checksum() -> None:
    with pytest.raises(SystemExit, match="SHA-256 mismatch"):
        generate_web.verify_source(b"not the archive")


def test_generator_reads_only_the_66_canon_books() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        xml = (
            '<?xml version="1.0" encoding="utf-8"?><usfx>'
            '<book id="GEN"><v id="1" bcv="GEN.1.1" />In the beginning.<ve /></book>'
            '<book id="TOB"><v id="1" bcv="TOB.1.1" />Not in the 66-book canon.<ve /></book>'
            "</usfx>"
        )
        zf.writestr(generate_web.ARCHIVE_MEMBER, xml.encode("utf-8"))
    books = generate_web.read_usfx_books(buf.getvalue())
    assert set(books) == {"GEN"}
    assert books["GEN"] == {(1, 1): "In the beginning."}
