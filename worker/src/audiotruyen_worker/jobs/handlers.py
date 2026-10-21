"""M2a job handlers: search, fetch_novel, fetch_chapter (spec 5.1-5.4)."""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Sequence
from dataclasses import asdict
from typing import Any

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import Handler, JobContext, PermanentJobError
from audiotruyen_worker.sources.base import SourceAdapter
from audiotruyen_worker.speakers.base import SegmentLabel, SpeakerStrategy, run_chain
from audiotruyen_worker.store import Store
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


def _payload_str(job: Job, key: str, max_len: int = 2000) -> str:
    value = job.payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise PermanentJobError(f"Job thiếu hoặc sai trường '{key}'.")
    return value.strip()


def make_handlers(
    adapter: SourceAdapter, store: Store, strategies: Sequence[SpeakerStrategy]
) -> dict[str, Handler]:
    def search(job: Job, ctx: JobContext) -> dict[str, Any]:
        query = _payload_str(job, "query", MAX_QUERY_CHARS)
        items = adapter.search(query)[:MAX_SEARCH_RESULTS]
        return {"items": [asdict(item) for item in items]}

    def fetch_novel(job: Job, ctx: JobContext) -> dict[str, Any]:
        url = _payload_str(job, "url")
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
        chapter_id = _payload_str(job, "chapter_id", 64)
        try:
            uuid.UUID(chapter_id)
        except ValueError as exc:
            raise PermanentJobError("Job có chapter_id không hợp lệ.") from exc
        row = store.chapter(chapter_id, job.user_id)
        if row is None:
            raise PermanentJobError("Không tìm thấy chương này trong thư viện.")
        content = adapter.chapter(row.url)
        ctx.check()
        digest = text_hash(content.text)
        if digest != row.text_hash:
            store.save_chapter_text(row.id, content.text, digest)
        segments = segment_text(content.text)
        result = run_chain(strategies, segments, store.roster(row.novel_id))
        if not store.has_analysis(row.id, digest, result.strategy, result.version):
            store.save_analysis(
                job.user_id, row.id, digest, result.strategy, result.version,
                analysis_document(segments, result.labels),
            )  # fmt: skip
        return {"chars": len(content.text), "segments": len(segments), "strategy": result.strategy}

    return {"search": search, "fetch_novel": fetch_novel, "fetch_chapter": fetch_chapter}
