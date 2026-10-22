"""Polite HTTP client for scraping: request spacing with jitter, retries, challenge detection."""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

import httpx

from audiotruyen_worker.sources.base import NovelNotFound, SourceBlocked, SourceError

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
_CHALLENGE_MARKERS = ("<title>Just a moment...</title>", "challenge-platform", "_cf_chl_opt")
_RETRY_STATUS = {429, 500, 502, 503, 504}
_MAX_REDIRECTS = 3


def is_challenge(response: httpx.Response) -> bool:
    """Cloudflare managed challenge. Normal pages embed a Turnstile comment widget, so
    `cf-turnstile` alone is not a challenge marker; only challenge responses carry these."""
    if response.headers.get("cf-mitigated", "").lower() == "challenge":
        return True
    if response.status_code in (403, 503):
        body = response.text
        return any(marker in body for marker in _CHALLENGE_MARKERS)
    return False


class PoliteClient:
    """GET-only client. Spacing between request starts: base_interval + uniform(jitter)
    (default 0.7 s + 0.3-0.8 s = 1.0-1.5 s, about 1 request/s). Retries timeouts, transport
    errors, 429 and 5xx with exponential backoff (honours Retry-After up to 60 s)."""

    def __init__(
        self,
        *,
        allowed_hosts: frozenset[str],
        transport: httpx.BaseTransport | None = None,
        base_interval: float = 0.7,
        jitter: tuple[float, float] = (0.3, 0.8),
        max_retries: int = 3,
        timeout: float = 20.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        rng: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "vi,en;q=0.8"},
            timeout=timeout,
            follow_redirects=False,
            transport=transport,
        )
        self._allowed_hosts = allowed_hosts
        self._base_interval = base_interval
        self._jitter = jitter
        self._max_retries = max_retries
        self._clock = clock
        self._sleep = sleep
        self._rng = rng
        self._next_at = 0.0

    def close(self) -> None:
        self._client.close()

    def _wait_turn(self) -> None:
        now = self._clock()
        if now < self._next_at:
            self._sleep(self._next_at - now)
        self._next_at = self._clock() + self._base_interval + self._rng(*self._jitter)

    def _check_host(self, url: str) -> None:
        host = (urlsplit(url).hostname or "").lower()
        if host not in self._allowed_hosts:
            raise SourceError(f"refusing to fetch host {host!r}")

    def get_text(self, url: str) -> str:
        """Return the body of a 200 response. Raises NovelNotFound when the site redirects to
        its search page, SourceBlocked on a challenge, SourceError after retries."""
        self._check_host(url)
        for _ in range(_MAX_REDIRECTS + 1):
            response = self._get_with_retries(url)
            if response.is_redirect:
                target = urljoin(url, response.headers.get("location", ""))
                if urlsplit(target).path.startswith("/tim-kiem"):
                    raise NovelNotFound(url)
                self._check_host(target)
                url = target
                continue
            if response.status_code == 404:
                raise NovelNotFound(url)
            if response.status_code != 200:
                raise SourceError(f"HTTP {response.status_code} for {url}")
            return response.text
        raise SourceError(f"too many redirects for {url}")

    def _get_with_retries(self, url: str) -> httpx.Response:
        attempt = 0
        while True:
            self._wait_turn()
            try:
                response = self._client.get(url)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                error: Exception = exc
                retry_after = None
            else:
                if is_challenge(response):
                    raise SourceBlocked(f"Cloudflare challenge for {url}")
                if response.status_code not in _RETRY_STATUS:
                    return response
                error = SourceError(f"HTTP {response.status_code} for {url}")
                retry_after = _retry_after(response)
            attempt += 1
            if attempt > self._max_retries:
                raise SourceError(str(error)) from error
            self._sleep(retry_after if retry_after is not None else 2.0**attempt)


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after", "")
    return min(float(raw), 60.0) if raw.isdigit() else None
