"""Pure HTML parsers for truyenfull.live pages (no network). Fixtures: tests/fixtures/truyenfull."""

from __future__ import annotations

import re

from selectolax.lexbor import LexborHTMLParser, LexborNode

from audiotruyen_worker.sources.base import (
    ChapterContent,
    ChapterRef,
    NovelInfo,
    NovelSummary,
    ParserBroken,
    TocPage,
)

TOC_PAGE_SIZE = 50  # chapters per table-of-contents page (verified 2026-10-19)
MIN_CHAPTER_CHARS = 500

_NOISE_TAGS = {"script", "style", "noscript", "iframe"}
_STATUS = {"full": "completed", "đang ra": "ongoing"}
_WS = re.compile(r"[ \t\r\f\v\u00a0\u200b]+")
# Trailing SEO keyword block, e.g. "truyen full, truyenfull, truyenfullvn, truyenfulllive".
# Anchored to the end of the text and requires at least two keywords, so a sentence that merely
# mentions "truyện full" (anywhere, or once at the very end) is never removed.
_SEO_KEYWORD = r"truy[eệ]n\s*full(?:\s*(?:vn|live)|\.(?:vn|live)|vn|live)?"
_SEO_TAIL = re.compile(
    rf"\s*\b{_SEO_KEYWORD}\b(?:[\s,.;:|/-]+{_SEO_KEYWORD}\b)+[\s,.;:|/-]*\Z", re.IGNORECASE
)


def _text(node: LexborNode | None) -> str | None:
    if node is None:
        return None
    value = _WS.sub(" ", node.text(deep=True, separator="", strip=False)).strip()
    return value or None


def _is_hidden(node: LexborNode) -> bool:
    style = (node.attributes.get("style") or "").replace(" ", "").lower()
    return "display:none" in style


def _is_ad(node: LexborNode) -> bool:
    ident = node.attributes.get("id") or ""
    classes = (node.attributes.get("class") or "").split()
    return ident.startswith("ads") or any(c.startswith("ads") for c in classes)


def _drop_noise(root: LexborNode) -> None:
    """Remove ads (id/class prefix "ads", never a substring match) and hidden elements.

    Walks top-down and never visits the children of a removed node.
    """
    stack = [root]
    while stack:
        node = stack.pop()
        for child in list(node.iter(include_text=False)):
            if child.tag in _NOISE_TAGS or _is_ad(child) or _is_hidden(child):
                child.decompose()
            else:
                stack.append(child)


def _block_text(root: LexborNode) -> str:
    """Flatten an element into paragraphs: <br>, <p> and <div> boundaries become line breaks."""
    html = root.html or ""
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"</?(?:p|div)\b[^>]*>", "\n", html, flags=re.IGNORECASE)
    text = LexborHTMLParser(f"<body>{html}</body>").body.text(deep=True, separator="", strip=False)
    lines = (_WS.sub(" ", line).strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line)


def strip_seo_tail(text: str) -> str:
    return _SEO_TAIL.sub("", text).rstrip()


def _input_value(tree: LexborHTMLParser, ident: str) -> str | None:
    node = tree.css_first(f"input#{ident}")
    return (node.attributes.get("value") or None) if node else None


def parse_toc_page(html: str, page: int) -> TocPage:
    tree = LexborHTMLParser(html)
    novel_id = _input_value(tree, "truyen-id")
    slug = _input_value(tree, "truyen-ascii")
    title = _text(tree.css_first('h3.title[itemprop="name"]'))
    if not (novel_id and slug and title):
        raise ParserBroken("novel page: missing truyen-id, truyen-ascii or title")
    total_raw = _input_value(tree, "total-page") or "1"
    if not total_raw.isdigit() or int(total_raw) < 1:
        raise ParserBroken(f"novel page: bad total-page {total_raw!r}")
    total_pages = int(total_raw)

    status_node = tree.css_first(".info span.text-success, .info span.text-primary")
    status = _STATUS.get((_text(status_node) or "").lower())
    cover = tree.css_first(".info-holder .book img")
    desc = tree.css_first(".desc-text")
    description = None
    if desc is not None:
        _drop_noise(desc)
        description = _block_text(desc) or None

    info = NovelInfo(
        source_novel_id=novel_id,
        url=f"https://truyenfull.live/{slug}/",
        slug=slug,
        title=title,
        author=_text(tree.css_first('.info a[itemprop="author"]')),
        cover_url=cover.attributes.get("src") if cover else None,
        description=description,
        status=status,  # type: ignore[arg-type]
    )

    links = tree.css("#list-chapter ul.list-chapter li a")
    first_index = (page - 1) * TOC_PAGE_SIZE + 1
    chapters = []
    for offset, link in enumerate(links):
        href = link.attributes.get("href") or ""
        chapter_title = _text(link)
        if not href.startswith("https://truyenfull.live/") or not chapter_title:
            raise ParserBroken(f"toc page {page}: bad chapter link {href!r}")
        chapters.append(ChapterRef(index=first_index + offset, title=chapter_title, url=href))
    if not chapters:
        raise ParserBroken(f"toc page {page}: no chapters")
    if page < total_pages and len(chapters) != TOC_PAGE_SIZE:
        raise ParserBroken(f"toc page {page}: {len(chapters)} chapters, expected {TOC_PAGE_SIZE}")
    return TocPage(info=info, page=page, total_pages=total_pages, chapters=chapters)


def parse_chapter_page(html: str) -> ChapterContent:
    tree = LexborHTMLParser(html)
    title = _text(tree.css_first("a.chapter-title"))
    body = tree.css_first("#chapter-c")
    if body is None:
        raise ParserBroken("chapter page: #chapter-c not found")
    _drop_noise(body)
    text = strip_seo_tail(_block_text(body))
    if title and len(text) < MIN_CHAPTER_CHARS:
        raise ParserBroken(f"chapter page: only {len(text)} characters of text")
    if not text:
        raise ParserBroken("chapter page: empty text")
    return ChapterContent(title=title or "", text=text)


def parse_search_page(html: str) -> list[NovelSummary]:
    tree = LexborHTMLParser(html)
    results = []
    for row in tree.css("#list-page div.row[itemtype]"):
        link = row.css_first("h3.truyen-title a")
        if link is None:
            continue
        cover = row.css_first("[data-image]")
        latest = row.css_first(".text-info a")
        results.append(
            NovelSummary(
                url=link.attributes.get("href") or "",
                title=_text(link) or "",
                author=_text(row.css_first(".author")),
                cover_url=cover.attributes.get("data-image") if cover else None,
                latest_chapter=_text(latest),
            )
        )
    return results
