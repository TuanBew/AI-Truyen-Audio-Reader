from pathlib import Path

import httpx
import pytest

from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError
from audiotruyen_worker.sources.http import PoliteClient
from audiotruyen_worker.sources.truyenfull import HOSTS, TruyenfullAdapter, novel_slug

FIXTURES = Path(__file__).parent / "fixtures" / "truyenfull"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_client(handler, clock: FakeClock | None = None, **kwargs) -> PoliteClient:
    clock = clock or FakeClock()
    return PoliteClient(
        allowed_hosts=HOSTS,
        transport=httpx.MockTransport(handler),
        clock=clock,
        sleep=clock.sleep,
        rng=lambda lo, hi: lo,
        **kwargs,
    )


def test_requests_are_spaced_by_interval_plus_jitter():
    clock = FakeClock()
    client = make_client(lambda request: httpx.Response(200, text="ok"), clock)
    for _ in range(3):
        client.get_text("https://truyenfull.live/a/")
    assert clock.sleeps == [pytest.approx(1.0), pytest.approx(1.0)]


def test_challenge_raises_source_blocked_without_retry():
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(
            403, headers={"cf-mitigated": "challenge"}, text=fixture("challenge_403.html")
        )

    with pytest.raises(SourceBlocked):
        make_client(handler).get_text("https://truyenfull.live/x-free/")
    assert len(calls) == 1


def test_challenge_detected_from_body_without_header():
    handler = lambda request: httpx.Response(403, text=fixture("challenge_403.html"))  # noqa: E731
    with pytest.raises(SourceBlocked):
        make_client(handler).get_text("https://truyenfull.live/x-free/")


def test_normal_page_with_turnstile_widget_is_not_a_challenge():
    html = fixture("chapter_new_2.html")
    assert "cf-turnstile" in html
    client = make_client(lambda request: httpx.Response(200, text=html))
    assert client.get_text("https://truyenfull.live/a/chuong-2/") == html


def test_5xx_is_retried_with_backoff_then_succeeds():
    clock = FakeClock()
    responses = iter(
        [httpx.Response(502), httpx.Response(503, text="busy"), httpx.Response(200, text="ok")]
    )
    client = make_client(lambda request: next(responses), clock)
    assert client.get_text("https://truyenfull.live/a/") == "ok"
    assert 2.0 in clock.sleeps and 4.0 in clock.sleeps


def test_retry_after_is_honoured_and_capped():
    clock = FakeClock()
    responses = iter(
        [httpx.Response(429, headers={"retry-after": "120"}), httpx.Response(200, text="ok")]
    )
    make_client(lambda request: next(responses), clock).get_text("https://truyenfull.live/a/")
    assert 60.0 in clock.sleeps


def test_gives_up_after_max_retries():
    client = make_client(lambda request: httpx.Response(500), max_retries=2)
    with pytest.raises(SourceError, match="HTTP 500"):
        client.get_text("https://truyenfull.live/a/")


def test_timeouts_are_retried():
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) < 3:
            raise httpx.ConnectTimeout("slow")
        return httpx.Response(200, text="ok")

    assert make_client(handler).get_text("https://truyenfull.live/a/") == "ok"
    assert len(attempts) == 3


def test_redirect_to_search_means_novel_removed():
    def handler(request):
        return httpx.Response(
            301, headers={"location": "https://truyenfull.live/tim-kiem/?tukhoa=tien-nghich"}
        )

    with pytest.raises(NovelNotFound):
        make_client(handler).get_text("https://truyenfull.live/tien-nghich/")


def test_redirect_within_site_is_followed():
    def handler(request):
        if request.url.path == "/old/":
            return httpx.Response(301, headers={"location": "/new/"})
        return httpx.Response(200, text="moved")

    assert make_client(handler).get_text("https://truyenfull.live/old/") == "moved"


def test_redirect_to_other_host_is_refused():
    handler = lambda request: httpx.Response(302, headers={"location": "https://evil.example/"})  # noqa: E731
    with pytest.raises(SourceError, match="refusing"):
        make_client(handler).get_text("https://truyenfull.live/a/")


def test_other_hosts_are_refused_before_any_request():
    calls = []
    client = make_client(lambda request: calls.append(1) or httpx.Response(200))
    with pytest.raises(SourceError):
        client.get_text("https://example.com/")
    assert calls == []


@pytest.mark.parametrize(
    ("url", "slug"),
    [
        ("https://truyenfull.live/the-gioi-hoan-my/", "the-gioi-hoan-my"),
        ("https://truyenfull.live/the-gioi-hoan-my/chuong-1000/", "the-gioi-hoan-my"),
        ("https://www.truyenfull.live/the-gioi-hoan-my", "the-gioi-hoan-my"),
    ],
)
def test_novel_slug(url, slug):
    assert novel_slug(url) == slug


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/a/",
        "https://truyenfull.live/",
        "https://truyenfull.live/tim-kiem/?tukhoa=a",
    ],
)
def test_matches_rejects_non_novel_urls(url):
    assert TruyenfullAdapter(make_client(lambda r: httpx.Response(200))).matches(url) is False


def _site(routes: dict[str, tuple[int, str]]):
    seen: list[str] = []

    def handler(request):
        key = request.url.path + (f"?{request.url.query.decode()}" if request.url.query else "")
        seen.append(key)
        status, name = routes[key]
        return httpx.Response(status, text=fixture(name))

    return handler, seen


def test_toc_pages_walks_from_start_page_to_last():
    pages = {
        f"/thong-phong-cua-quyen-than-linh-lam/trang-{n}/": (200, "novel_full_p8.html")
        for n in (7, 8)
    }
    handler, seen = _site(pages)
    # page 7 is served with the page-8 fixture, which is a short page: page 7 of 8 must be full
    adapter = TruyenfullAdapter(make_client(handler))
    with pytest.raises(ParserBroken):
        list(adapter.toc_pages("https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/", 7))
    assert seen == ["/thong-phong-cua-quyen-than-linh-lam/trang-7/"]


def test_toc_pages_single_page_novel():
    handler, seen = _site({"/bao-long-than-tham/": (200, "novel_single_page.html")})
    pages = list(
        TruyenfullAdapter(make_client(handler)).toc_pages(
            "https://truyenfull.live/bao-long-than-tham/chuong-3/"
        )
    )
    assert [p.page for p in pages] == [1]
    assert len(pages[0].chapters) == 19
    assert seen == ["/bao-long-than-tham/"]


def test_toc_pages_last_page_only():
    handler, seen = _site(
        {"/thong-phong-cua-quyen-than-linh-lam/trang-8/": (200, "novel_full_p8.html")}
    )
    pages = list(
        TruyenfullAdapter(make_client(handler)).toc_pages(
            "https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/", 8
        )
    )
    assert [c.index for c in pages[0].chapters] == [351, 352, 353, 354]


def test_search_and_chapter():
    handler, seen = _site(
        {
            "/tim-kiem/?tukhoa=ti%C3%AAn+ngh%E1%BB%8Bch": (200, "search_results.html"),
            "/the-gioi-hoan-my/chuong-1000/": (200, "chapter_old_1000.html"),
        }
    )
    adapter = TruyenfullAdapter(make_client(handler))
    assert [r.title for r in adapter.search("  tiên nghịch ")] == [
        "Tiên Nghịch Chi Hậu",
        "Tiên Nghịch Nhị Bản",
    ]
    assert (
        adapter.chapter("https://truyenfull.live/the-gioi-hoan-my/chuong-1000/").title
        == "Chương 1000: Bảo dịch phong ba"
    )
