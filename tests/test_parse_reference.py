import pytest

from versesync.detect.parse import InvalidReference, parse_reference
from versesync.types import Reference


def test_simple_verse() -> None:
    ref = parse_reference("Romans 8:28")
    assert (ref.osis, ref.chapter, ref.verse, ref.verse_end) == ("Rom", 8, 28, None)


def test_numbered_book_range() -> None:
    ref = parse_reference("1 Cor 6:19-20")
    assert (ref.osis, ref.chapter, ref.verse, ref.verse_end) == ("1Cor", 6, 19, 20)


def test_chapter_only_lowercase() -> None:
    ref = parse_reference("psalm 23")
    assert (ref.osis, ref.chapter, ref.verse) == ("Ps", 23, None)


def test_dict_form() -> None:
    ref = parse_reference({"book": "Romans", "osis": "Rom", "chapter": 8, "verse": 28})
    assert ref == Reference(book=ref.book, osis="Rom", chapter=8, verse=28)


def test_dict_out_of_range() -> None:
    with pytest.raises(InvalidReference) as exc:
        parse_reference({"osis": "Jude", "chapter": 2})
    assert exc.value.message == "Jude has only 1 chapter."


def test_chapter_out_of_range_message() -> None:
    with pytest.raises(InvalidReference) as exc:
        parse_reference("Jude 5:1")
    assert exc.value.message == "Jude has only 1 chapter."


def test_verse_out_of_range_message() -> None:
    with pytest.raises(InvalidReference) as exc:
        parse_reference("Jude 1:99")
    assert exc.value.message == "Jude 1 has only 25 verses."


def test_unreadable_message() -> None:
    with pytest.raises(InvalidReference) as exc:
        parse_reference("hello")
    assert exc.value.message == 'Couldn\'t read "hello" as a scripture reference.'


def test_trailing_text_rejected() -> None:
    with pytest.raises(InvalidReference):
        parse_reference("Romans 8:28 and more")
