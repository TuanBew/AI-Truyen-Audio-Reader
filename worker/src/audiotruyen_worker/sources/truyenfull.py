"""truyenfull.live adapter (spec 2.1, 5.2)."""

from __future__ import annotations

import re
from collections.abc import Iterator
from urllib.parse import quote_plus, urlsplit

from audiotruyen_worker.sources.base import ChapterContent, NovelSummary, TocPage
from audiotruyen_worker.sources.http import PoliteClient
from audiotruyen_worker.sources.truyenfull_parse import (
    parse_chapter_page,
    parse_search_page,
    parse_toc_page,
)

BASE = "https://truyenfull.live"
HOSTS = frozenset({"truyenfull.live", "www.truyenfull.live"})
_SLUG = re.compile(r"^[a-z0-9-]+$")


def novel_slug(url: str) -> str:
    """First path segment of a truyenfull novel or chapter URL."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() not in HOSTS:
        raise ValueError(f"not a truyenfull URL: {url}")
    segments = [s for s in parts.path.split("/") if s]
    if not segments or not _SLUG.match(segments[0]) or segments[0] in {"tim-kiem", "danh-sach"}:
        raise ValueError(f"not a truyenfull novel URL: {url}")
    return segments[0]


class TruyenfullAdapter:
    id = "truyenfull"

    def __init__(self, client: PoliteClient | None = None) -> None:
        self._client = client or PoliteClient(allowed_hosts=HOSTS)

    def matches(self, url: str) -> bool:
        try:
            novel_slug(url)
        except ValueError:
            return False
        return True

    def search(self, query: str) -> list[NovelSummary]:
        html = self._client.get_text(f"{BASE}/tim-kiem/?tukhoa={quote_plus(query.strip())}")
        return parse_search_page(html)

    def toc_pages(self, url: str, start_page: int = 1) -> Iterator[TocPage]:
        """Yield table-of-contents pages from start_page to the last one, one request each.
        start_page lets check_updates read only the pages that can hold new chapters."""
        slug = novel_slug(url)
        page = max(1, start_page)
        while True:
            page_url = f"{BASE}/{slug}/" if page == 1 else f"{BASE}/{slug}/trang-{page}/"
            toc = parse_toc_page(self._client.get_text(page_url), page)
            yield toc
            if page >= toc.total_pages:
                return
            page += 1

    def chapter(self, url: str) -> ChapterContent:
        novel_slug(url)  # validates host and shape
        return parse_chapter_page(self._client.get_text(url))
