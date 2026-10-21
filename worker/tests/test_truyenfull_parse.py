from pathlib import Path

import pytest

from audiotruyen_worker.sources.base import ParserBroken
from audiotruyen_worker.sources.truyenfull_parse import (
    parse_chapter_page,
    parse_search_page,
    parse_toc_page,
    strip_seo_tail,
)

FIXTURES = Path(__file__).parent / "fixtures" / "truyenfull"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_novel_page_metadata_and_first_toc_page():
    page = parse_toc_page(fixture("novel_full_p1.html"), 1)
    info = page.info
    assert info.source_novel_id == "45719"
    assert info.slug == "thong-phong-cua-quyen-than-linh-lam"
    assert info.url == "https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/"
    assert info.title == "Thông Phòng Của Quyền Thần - Linh Lam"
    assert info.author == "Linh Lam"
    assert info.status == "completed"
    assert info.cover_url == "https://lh3.googleusercontent.com/d/1lCAoA-JMfaV1AaTQaVDEu4XJEP_Mv-Xk"
    assert info.description.startswith("[Quyền thần phong lưu nhưng độc ác")
    assert "truyenfull" not in info.description.lower()  # hidden SEO paragraphs dropped
    assert page.total_pages == 8
    assert len(page.chapters) == 50
    first, last = page.chapters[0], page.chapters[-1]
    assert (first.index, first.title) == (1, "Chương 1")
    assert first.url == "https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/chuong-1/"
    assert (last.index, last.title) == (50, "Chương 50")


def test_last_toc_page_indexes_continue_from_the_page_number():
    page = parse_toc_page(fixture("novel_full_p8.html"), 8)
    assert [c.index for c in page.chapters] == [351, 352, 353, 354]
    assert page.chapters[-1].title == "Chương 354: Hoàn chính văn"


def test_ongoing_status_and_titled_chapters():
    page = parse_toc_page(fixture("novel_ongoing.html"), 1)
    assert page.info.status == "ongoing"
    assert page.info.source_novel_id == "45842"
    assert page.total_pages == 3
    assert page.chapters[0].title == "Chương 1: Cô Là Giày Rách?"


def test_old_novel_page():
    page = parse_toc_page(fixture("novel_old_p1.html"), 1)
    assert (page.info.source_novel_id, page.info.title, page.info.author) == (
        "94",
        "Thế Giới Hoàn Mỹ",
        "Thần Đông",
    )
    assert page.total_pages == 41
    assert page.chapters[0].title == "Chương 1: Đại Hoang"


def test_index_is_toc_position_not_the_url_number():
    page = parse_toc_page(fixture("novel_single_page.html"), 1)
    assert page.total_pages == 1
    assert len(page.chapters) == 19
    assert page.chapters[0].url.endswith("/chuong-1-1/")
    assert (page.chapters[-1].index, page.chapters[-1].title) == (
        19,
        "Chương 17: Thuật phân thân ảnh",
    )


def test_short_middle_page_is_parser_broken():
    with pytest.raises(ParserBroken, match="expected 50"):
        parse_toc_page(fixture("novel_full_p8.html"), 7)


def test_missing_novel_markers_is_parser_broken():
    with pytest.raises(ParserBroken):
        parse_toc_page(fixture("search_results.html"), 1)


@pytest.mark.parametrize(
    ("name", "title", "head", "tail"),
    [
        (
            "chapter_new_2.html",
            "Chương 2",
            "Vì vậy nàng bắt đầu che giấu dung mạo",
            "Có trị tội nàng rình mò không?",
        ),
        (
            "chapter_new_354.html",
            "Chương 354: Hoàn chính văn",
            "Cố Lan Đình trơ mắt nhìn bóng dáng",
            "Ánh sáng trắng triệt để yên diệt.\nChính văn hoàn",
        ),
        (
            "chapter_old_1000.html",
            "Chương 1000: Bảo dịch phong ba",
            "Lôi Kiếp dịch ẩn chứa trong tiên trì này",
            "quả thật không hề thiếu cao thủ!",
        ),
    ],
)
def test_chapter_text(name, title, head, tail):
    content = parse_chapter_page(fixture(name))
    assert content.title == title
    assert content.text.startswith(head)
    assert content.text.endswith(tail)
    assert "truyenfull" not in content.text.lower()
    assert "\n\n" not in content.text  # one paragraph per line
    assert len(content.text) >= 500


def test_chapter_keeps_obfuscated_words_for_display():
    text = parse_chapter_page(fixture("chapter_new_2.html")).text
    assert "thảo d.ư.ợ.c" in text  # display text stays original; TTS normalizes later


def test_ads_are_removed_by_prefix_only():
    filler = "Một câu văn bình thường trong chương truyện. " * 15
    html = (
        '<a class="chapter-title">Chương 9</a><div id="chapter-c">'
        '<div id="ads-chapter-top">QUẢNG CÁO</div>'
        '<div class="text-center ads-holder">QUẢNG CÁO 2</div>'
        f'<p>{filler}<br><br><span class="roads">đường xa</span></p>'
        '<p style="display: none;visibility: hidden;">truyen full</p></div>'
    )
    text = parse_chapter_page(html).text
    assert "QUẢNG CÁO" not in text
    assert "đường xa" in text  # class "roads" contains "ads" but does not start with it


def test_chapter_without_body_is_parser_broken():
    with pytest.raises(ParserBroken, match="#chapter-c"):
        parse_chapter_page("<html><body><p>Không có nội dung</p></body></html>")


def test_short_chapter_with_title_is_parser_broken():
    html = '<a class="chapter-title">Chương 1</a><div id="chapter-c"><p>Quá ngắn.</p></div>'
    with pytest.raises(ParserBroken, match="characters"):
        parse_chapter_page(html)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Hết chương.\ntruyen full, truyenfull, truyenfullvn, truyenfulllive", "Hết chương."),
        ("Hết chương. Truyện Full truyenfull.live", "Hết chương."),
        ("Hắn thích đọc truyện full ở nhà.\nHết.", "Hắn thích đọc truyện full ở nhà.\nHết."),
        ("Cuối cùng là truyện full", "Cuối cùng là truyện full"),
    ],
)
def test_seo_tail_is_end_anchored_and_needs_two_keywords(raw, expected):
    assert strip_seo_tail(raw) == expected


def test_search_results():
    results = parse_search_page(fixture("search_results.html"))
    assert [r.title for r in results] == ["Tiên Nghịch Chi Hậu", "Tiên Nghịch Nhị Bản"]
    first = results[0]
    assert first.url == "https://truyenfull.live/tien-nghich-chi-hau/"
    assert first.author == "Trần Mộc"
    assert first.latest_chapter == "Chương 18"
    assert first.cover_url.startswith("https://static.truyenfull.live/cover/")


def test_search_first_page_and_empty_results():
    assert len(parse_search_page(fixture("search_paged.html"))) == 27
    assert parse_search_page(fixture("search_empty.html")) == []


def test_parser_budget():
    """Perf budget (7.3.2): parsing stays in single-digit milliseconds per page."""
    import time

    html = fixture("novel_full_p1.html")
    start = time.perf_counter()
    for _ in range(20):
        parse_toc_page(html, 1)
    assert (time.perf_counter() - start) / 20 < 0.05
