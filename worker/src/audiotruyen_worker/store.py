"""Database access for job handlers (service role, so every query scopes by user_id itself)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from postgrest.types import ReturnMethod

from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.speakers.base import Character

SOURCE = "truyenfull"
_CHAPTER_BATCH = 500


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class ChapterRow:
    id: str
    user_id: str
    novel_id: str
    index: int
    url: str
    text_hash: str | None


class Store:
    def __init__(self, client) -> None:
        self._db = client

    def upsert_novel(self, user_id: str, info: NovelInfo) -> str:
        row = {
            "user_id": user_id,
            "source": SOURCE,
            "source_novel_id": info.source_novel_id,
            "url": info.url,
            "slug": info.slug,
            "title": info.title,
            "author": info.author,
            "cover_url": info.cover_url,
            "description": info.description,
            "status": info.status,
        }
        data = (
            self._db.table("novels")
            .upsert(row, on_conflict="user_id,source,source_novel_id")
            .execute()
            .data
        )
        return data[0]["id"]

    def upsert_chapters(self, user_id: str, novel_id: str, chapters: Sequence[ChapterRef]) -> None:
        """Insert new TOC entries and refresh title/url of existing ones on (novel_id, index).
        Never deletes and never touches fetched text."""
        rows = [
            {
                "user_id": user_id,
                "novel_id": novel_id,
                "index": c.index,
                "title": c.title,
                "url": c.url,
            }
            for c in chapters
        ]
        for start in range(0, len(rows), _CHAPTER_BATCH):
            self._db.table("chapters").upsert(
                rows[start : start + _CHAPTER_BATCH],
                on_conflict="novel_id,index",
                returning=ReturnMethod.minimal,
            ).execute()

    def finish_toc(self, novel_id: str, chapter_count: int) -> None:
        self._db.table("novels").update(
            {"chapter_count": chapter_count, "last_checked_at": _now()}
        ).eq("id", novel_id).execute()

    def chapter(self, chapter_id: str, user_id: str) -> ChapterRow | None:
        data = (
            self._db.table("chapters")
            .select("id,user_id,novel_id,index,url,text_hash")
            .eq("id", chapter_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
            .data
        )
        return ChapterRow(**data[0]) if data else None

    def save_chapter_text(self, chapter_id: str, text: str, text_hash: str) -> None:
        self._db.table("chapters").update(
            {"text": text, "text_hash": text_hash, "fetched_at": _now()}
        ).eq("id", chapter_id).execute()

    def roster(self, novel_id: str) -> list[Character]:
        data = (
            self._db.table("characters")
            .select("name,gender,aliases")
            .eq("novel_id", novel_id)
            .execute()
            .data
        )
        return [Character(r["name"], r["gender"], tuple(r["aliases"] or ())) for r in data]

    def has_analysis(self, chapter_id: str, text_hash: str, strategy: str, version: int) -> bool:
        data = (
            self._db.table("chapter_analysis")
            .select("chapter_id")
            .eq("chapter_id", chapter_id)
            .eq("text_hash", text_hash)
            .eq("strategy", strategy)
            .eq("strategy_version", version)
            .limit(1)
            .execute()
            .data
        )
        return bool(data)

    def save_analysis(
        self,
        user_id: str,
        chapter_id: str,
        text_hash: str,
        strategy: str,
        version: int,
        segments: list[dict[str, Any]],
    ) -> None:
        self._db.table("chapter_analysis").upsert(
            {
                "user_id": user_id,
                "chapter_id": chapter_id,
                "text_hash": text_hash,
                "strategy": strategy,
                "strategy_version": version,
                "segments": segments,
            },
            on_conflict="chapter_id,text_hash,strategy,strategy_version",
            returning=ReturnMethod.minimal,
        ).execute()
