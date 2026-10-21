"""Source adapter contract (spec 5.2): data types, errors and the SourceAdapter protocol."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

NovelStatus = Literal["ongoing", "completed"]


class SourceError(Exception):
    """Transient source failure (network, 5xx, rate limit). The job may retry with backoff."""


class SourceBlocked(SourceError):
    """The source answered with an anti-bot challenge (Cloudflare). Never solved by the worker."""


class ParserBroken(Exception):
    """The page no longer matches the parser (markup change). Not retried."""


class NovelNotFound(Exception):
    """The novel does not exist or was removed (truyenfull redirects to its search page)."""


@dataclass(frozen=True)
class NovelSummary:
    url: str
    title: str
    author: str | None
    cover_url: str | None
    latest_chapter: str | None


@dataclass(frozen=True)
class ChapterRef:
    index: int  # 1-based position in the table of contents
    title: str
    url: str


@dataclass(frozen=True)
class NovelInfo:
    source_novel_id: str
    url: str  # canonical novel URL
    slug: str
    title: str
    author: str | None
    cover_url: str | None
    description: str | None
    status: NovelStatus | None


@dataclass(frozen=True)
class TocPage:
    info: NovelInfo
    page: int
    total_pages: int
    chapters: list[ChapterRef] = field(default_factory=list)


@dataclass(frozen=True)
class ChapterContent:
    title: str
    text: str  # original display text: one paragraph per line, joined with "\n"


class SourceAdapter(Protocol):
    id: str

    def matches(self, url: str) -> bool: ...

    def search(self, query: str) -> list[NovelSummary]: ...

    def toc_pages(self, url: str, start_page: int = 1) -> Iterator[TocPage]: ...

    def chapter(self, url: str) -> ChapterContent: ...
