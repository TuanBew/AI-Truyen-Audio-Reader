"""Job handlers for the text side: search, fetch_novel, fetch_chapter (spec 5.1-5.4), and the
chapter preparation that synthesize shares (text + cached analysis)."""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import Handler, JobContext, PermanentJobError
from audiotruyen_worker.sources.base import SourceAdapter
from audiotruyen_worker.speakers.base import SegmentLabel, SpeakerStrategy, run_chain
from audiotruyen_worker.store import ChapterRow, Store
from audiotruyen_worker.text.segment import Segment, segment_text

log = logging.getLogger(__name__)

MAX_SEARCH_RESULTS = 30
MAX_QUERY_CHARS = 100


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def analysis_document(
    segments: Sequence[Segment], labels: Sequence[SegmentLabel]
) -> list[dict[str, Any]]:
    """chapter_analysis.segments: spec 4.1 fields known before synthesis (no voice, no timing)."""
    by_i = {label.i: label for label in labels}
    return [
        {
            "i": s.i,
            "kind": s.kind,
            "src": [s.start, s.end],
            "p": s.paragraph,
            "pe": s.paragraph_end,
            "speaker": by_i[s.i].speaker,
            "gender": by_i[s.i].gender,
            "emotion": by_i[s.i].emotion,
            "intensity": by_i[s.i].intensity,
        }
        for s in segments
    ]


def payload_str(job: Job, key: str, max_len: int = 2000) -> str:
    value = job.payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise PermanentJobError(f"Job thiếu hoặc sai trường '{key}'.")
    return value.strip()


def payload_uuid(job: Job, key: str) -> str:
    value = payload_str(job, key, 64)
    try:
        uuid.UUID(value)
    except ValueError as exc:
        raise PermanentJobError(f"Job có {key} không hợp lệ.") from exc
    return value


def owned_chapter(store: Store, job: Job, chapter_id: str) -> ChapterRow:
    row = store.chapter(chapter_id, job.user_id)
    if row is None:
        raise PermanentJobError("Không tìm thấy chương này trong thư viện.")
    return row


@dataclass(frozen=True)
class PreparedChapter:
    row: ChapterRow
    text: str
    digest: str
    analysis: list[dict[str, Any]]
    strategy: str


class ChapterPreparer:
    """Chapter text (fetched when asked or missing) plus its speaker/emotion analysis, reusing a
    cached analysis in chain order before running the chain (an LLM strategy bills quota)."""

    def __init__(
        self, adapter: SourceAdapter, store: Store, strategies: Sequence[SpeakerStrategy]
    ) -> None:
        self._adapter = adapter
        self._store = store
        self._strategies = strategies

    def prepare(
        self, job: Job, row: ChapterRow, ctx: JobContext, *, refetch: bool
    ) -> PreparedChapter:
        text = None if refetch else self._store.chapter_text(row.id)
        if text is None:
            text = self._adapter.chapter(row.url).text
            ctx.check()
        digest = text_hash(text)
        if digest != row.text_hash:
            self._store.save_chapter_text(row.id, text, digest)
        for strategy in self._strategies:
            cached = self._store.analysis(row.id, digest, strategy.name, strategy.version)
            if cached is not None:
                return PreparedChapter(row, text, digest, cached, strategy.name)
        segments = segment_text(text)
        result = run_chain(self._strategies, segments, self._store.roster(row.novel_id))
        document = analysis_document(segments, result.labels)
        self._store.save_analysis(
            job.user_id, row.id, digest, result.strategy, result.version, document
        )
        return PreparedChapter(row, text, digest, document, result.strategy)


def make_handlers(
    adapter: SourceAdapter, store: Store, strategies: Sequence[SpeakerStrategy]
) -> dict[str, Handler]:
    preparer = ChapterPreparer(adapter, store, strategies)

    def search(job: Job, ctx: JobContext) -> dict[str, Any]:
        query = payload_str(job, "query", MAX_QUERY_CHARS)
        items = adapter.search(query)[:MAX_SEARCH_RESULTS]
        return {"items": [asdict(item) for item in items]}

    def fetch_novel(job: Job, ctx: JobContext) -> dict[str, Any]:
        url = payload_str(job, "url")
        if not adapter.matches(url):
            raise PermanentJobError("Đường dẫn không phải một truyện trên truyenfull.live.")
        novel_id: str | None = None
        count = 0
        for page in adapter.toc_pages(url):
            ctx.check()
            if novel_id is None:
                novel_id = store.upsert_novel(job.user_id, page.info)
            # Each page is committed as soon as it is read, so the first 50 chapters are
            # readable while the rest of a long table of contents is still loading.
            store.upsert_chapters(job.user_id, novel_id, page.chapters)
            count = page.chapters[-1].index
        assert novel_id is not None  # toc_pages yields at least one page or raises
        store.finish_toc(novel_id, count)
        return {"novel_id": novel_id, "chapter_count": count}

    def fetch_chapter(job: Job, ctx: JobContext) -> dict[str, Any]:
        row = owned_chapter(store, job, payload_uuid(job, "chapter_id"))
        chapter = preparer.prepare(job, row, ctx, refetch=True)
        return {
            "chars": len(chapter.text),
            "segments": len(chapter.analysis),
            "strategy": chapter.strategy,
        }

    return {"search": search, "fetch_novel": fetch_novel, "fetch_chapter": fetch_chapter}
