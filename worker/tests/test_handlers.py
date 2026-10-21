from pathlib import Path

import pytest

from audiotruyen_worker.jobs.handlers import analysis_document, make_handlers, text_hash
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobCancelled, JobContext, PermanentJobError
from audiotruyen_worker.sources.base import (
    ChapterContent,
    ChapterRef,
    NovelInfo,
    NovelSummary,
    TocPage,
)
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.store import ChapterRow

USER = "11111111-1111-1111-1111-111111111111"
CHAPTER = "cccccccc-0000-0000-0000-000000000001"


def job(type_="search", payload=None):
    return Job(id="j1", user_id=USER, type=type_, payload=payload or {})


INFO = NovelInfo(
    "45719", "https://truyenfull.live/a/", "a", "Truyện A", "Tác giả", None, None, "ongoing"
)


class FakeAdapter:
    id = "truyenfull"

    def __init__(self, pages=None, text="", events=None):
        self.pages = pages or []
        self.text = text
        self.events = events if events is not None else []

    def matches(self, url):
        return url.startswith("https://truyenfull.live/")

    def search(self, query):
        self.events.append(("search", query))
        return [
            NovelSummary(f"https://truyenfull.live/n{i}/", f"N{i}", None, None, None)
            for i in range(40)
        ]

    def toc_pages(self, url, start_page=1):
        for page in self.pages:
            self.events.append(("page", page.page))
            yield page

    def chapter(self, url):
        self.events.append(("chapter", url))
        return ChapterContent("Chương 1", self.text)


class FakeStore:
    def __init__(self, events=None, chapter_row=None, analysis=False):
        self.events = events if events is not None else []
        self.chapter_row = chapter_row
        self.analysis = analysis
        self.saved_text = None
        self.saved_analysis = None

    def upsert_novel(self, user_id, info):
        self.events.append(("novel", info.source_novel_id))
        return "novel-uuid"

    def upsert_chapters(self, user_id, novel_id, chapters):
        self.events.append(("chapters", [c.index for c in chapters]))

    def finish_toc(self, novel_id, count):
        self.events.append(("finish", count))

    def chapter(self, chapter_id, user_id):
        return self.chapter_row if user_id == USER else None

    def save_chapter_text(self, chapter_id, text, digest):
        self.saved_text = (chapter_id, text, digest)

    def roster(self, novel_id):
        return []

    def has_analysis(self, chapter_id, digest, strategy, version):
        return self.analysis

    def save_analysis(self, user_id, chapter_id, digest, strategy, version, segments):
        self.saved_analysis = (strategy, version, segments)


def _page(n, indexes, total):
    return TocPage(
        INFO,
        n,
        total,
        [ChapterRef(i, f"Chương {i}", f"https://truyenfull.live/a/chuong-{i}/") for i in indexes],
    )


def test_search_caps_results_and_validates_query():
    handlers = make_handlers(FakeAdapter(), FakeStore(), [HeuristicStrategy()])
    result = handlers["search"](job("search", {"query": " kiếm "}), JobContext(job()))
    assert len(result["items"]) == 30
    assert result["items"][0]["url"] == "https://truyenfull.live/n0/"
    with pytest.raises(PermanentJobError):
        handlers["search"](job("search", {"query": "x" * 101}), JobContext(job()))


def test_fetch_novel_commits_each_page_before_reading_the_next():
    events: list = []
    adapter = FakeAdapter([_page(1, range(1, 51), 2), _page(2, range(51, 54), 2)], events=events)
    handlers = make_handlers(adapter, FakeStore(events), [HeuristicStrategy()])
    result = handlers["fetch_novel"](
        job("fetch_novel", {"url": "https://truyenfull.live/a/"}), JobContext(job())
    )
    assert result == {"novel_id": "novel-uuid", "chapter_count": 53}
    assert [e[0] for e in events] == ["page", "novel", "chapters", "page", "chapters", "finish"]


def test_fetch_novel_rejects_foreign_urls():
    handlers = make_handlers(FakeAdapter(), FakeStore(), [HeuristicStrategy()])
    with pytest.raises(PermanentJobError):
        handlers["fetch_novel"](
            job("fetch_novel", {"url": "https://example.com/a/"}), JobContext(job())
        )


def test_fetch_novel_stops_between_pages_when_cancelled():
    adapter = FakeAdapter([_page(1, range(1, 51), 2), _page(2, range(51, 54), 2)])
    store = FakeStore()
    ctx = JobContext(job())
    ctx.cancelled.set()
    with pytest.raises(JobCancelled):
        make_handlers(adapter, store, [HeuristicStrategy()])["fetch_novel"](
            job("fetch_novel", {"url": "https://truyenfull.live/a/"}), ctx
        )
    assert store.events == []


TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần."


def test_fetch_chapter_saves_text_and_analysis():
    row = ChapterRow(CHAPTER, USER, "novel-uuid", 1, "https://truyenfull.live/a/chuong-1/", None)
    store = FakeStore(chapter_row=row)
    handlers = make_handlers(FakeAdapter(text=TEXT), store, [HeuristicStrategy()])
    result = handlers["fetch_chapter"](
        job("fetch_chapter", {"chapter_id": CHAPTER}), JobContext(job())
    )
    assert result == {"chars": len(TEXT), "segments": 3, "strategy": "heuristic"}
    assert store.saved_text == (CHAPTER, TEXT, text_hash(TEXT))
    strategy, version, segments = store.saved_analysis
    assert (strategy, version) == ("heuristic", 1)
    assert segments[0] == {
        "i": 0, "kind": "dialogue", "src": [0, 12], "p": 0, "pe": False,
        "speaker": None, "gender": "unknown", "emotion": "angry", "intensity": 0.7,
    }  # fmt: skip
    assert [s["src"] for s in segments] == [[0, 12], [13, 28], [29, 42]]


def test_fetch_chapter_skips_unchanged_text_and_existing_analysis():
    row = ChapterRow(CHAPTER, USER, "novel-uuid", 1, "u", text_hash(TEXT))
    store = FakeStore(chapter_row=row, analysis=True)
    make_handlers(FakeAdapter(text=TEXT), store, [HeuristicStrategy()])["fetch_chapter"](
        job("fetch_chapter", {"chapter_id": CHAPTER}), JobContext(job())
    )
    assert store.saved_text is None and store.saved_analysis is None


@pytest.mark.parametrize(
    "payload",
    [{}, {"chapter_id": "not-a-uuid"}, {"chapter_id": "dddddddd-0000-0000-0000-000000000009"}],
)
def test_fetch_chapter_rejects_bad_or_foreign_chapter_ids(payload):
    handlers = make_handlers(
        FakeAdapter(text=TEXT), FakeStore(chapter_row=None), [HeuristicStrategy()]
    )
    with pytest.raises(PermanentJobError):
        handlers["fetch_chapter"](job("fetch_chapter", payload), JobContext(job()))


def test_analysis_document_matches_segments():
    from audiotruyen_worker.text.segment import segment_text

    segs = segment_text(TEXT)
    labels = HeuristicStrategy().analyze(segs, [])
    doc = analysis_document(segs, labels)
    assert [d["i"] for d in doc] == [0, 1, 2]
    assert all(TEXT[d["src"][0] : d["src"][1]] == s.text for d, s in zip(doc, segs, strict=True))


def test_pipeline_budget_on_a_real_chapter():
    """Perf budget (7.3.2): parse + segment + heuristic for one chapter stays far below 100 ms."""
    import time

    from audiotruyen_worker.sources.truyenfull_parse import parse_chapter_page
    from audiotruyen_worker.text.segment import segment_text

    html = (Path(__file__).parent / "fixtures" / "truyenfull" / "chapter_new_354.html").read_text(
        encoding="utf-8"
    )
    start = time.perf_counter()
    for _ in range(10):
        segs = segment_text(parse_chapter_page(html).text)
        HeuristicStrategy().analyze(segs, [])
    assert (time.perf_counter() - start) / 10 < 0.1
