"""Record real truyenfull.live pages as parser test fixtures.

Run from worker/:  uv run python scripts/record_truyenfull_fixtures.py
Re-run only when the site markup changes (ParserBroken in production); then update the
expected values in tests/sources/test_truyenfull_parse.py.

Pages are minimized before saving (scripts, styles, svg, comments and the account modal are
removed) and chapter bodies are cut to a head + tail excerpt (the repository is public, so it
keeps only short excerpts of the novels). Requests are spaced ~1.5 s apart.
"""

from __future__ import annotations

import datetime as dt
import re
import sys
import time
from pathlib import Path

import httpx
from selectolax.lexbor import LexborHTMLParser

BASE = "https://truyenfull.live"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "truyenfull"

# (fixture name, path, is_chapter)
PAGES: list[tuple[str, str, bool]] = [
    ("novel_full_p1.html", "/thong-phong-cua-quyen-than-linh-lam/", False),
    ("novel_full_p8.html", "/thong-phong-cua-quyen-than-linh-lam/trang-8/", False),
    (
        "novel_ongoing.html",
        "/thap-nien-70-kieu-nu-de-mang-thai-khien-thieu-gia-thu-do-tuyet-tu-them-khoc/",
        False,
    ),
    ("novel_old_p1.html", "/the-gioi-hoan-my/", False),
    ("novel_single_page.html", "/bao-long-than-tham/", False),
    ("chapter_new_2.html", "/thong-phong-cua-quyen-than-linh-lam/chuong-2/", True),
    ("chapter_new_354.html", "/thong-phong-cua-quyen-than-linh-lam/chuong-354/", True),
    ("chapter_old_1000.html", "/the-gioi-hoan-my/chuong-1000/", True),
    ("search_results.html", "/tim-kiem/?tukhoa=tien+nghich", False),
    ("search_paged.html", "/tim-kiem/?tukhoa=kiem", False),
    ("search_empty.html", "/tim-kiem/?tukhoa=zzqqxxnotfound", False),
    ("challenge_403.html", "/anh-sang-mua-dong-zhihu-free/", False),
]

DROP = (
    "script, style, noscript, svg, iframe, link, #modalAuth,"
    ' a[href*="/cdn-cgi/l/email-protection"], [data-cfemail]'
)
# Cover image paths carry long opaque tokens; parsers never read them, so they are shortened.
_COVER_TOKEN = re.compile(r"(static\.truyenfull\.live/cover/(?:o/)?)[A-Za-z0-9_=-]{20,}/")


def minimize(html: str) -> str:
    """Drop scripts, styles, the account modal and Cloudflare's encoded contact e-mail."""
    tree = LexborHTMLParser(html)
    for node in tree.css(DROP):
        node.decompose()
    out = re.sub(r"<!--.*?-->", "", tree.html or "", flags=re.S)
    return _COVER_TOKEN.sub(r"\1fixture/", out)


def _visible_len(fragment: str) -> int:
    return len(re.sub(r"<[^>]+>", "", fragment))


def excerpt_chapter(html: str, head_chars: int = 1200, tail_chars: int = 600) -> str:
    """Keep the first ~head_chars and last ~tail_chars of the chapter body, plus the hidden tail."""
    tree = LexborHTMLParser(html)
    full = tree.html or ""
    node = tree.css_first("#chapter-c")
    if node is None:
        return full
    outer = node.html or ""
    hidden = re.search(r'<p style="display:\s*none', outer)
    body_end = hidden.start() if hidden else outer.rfind("</div>")
    body, rest = outer[:body_end], outer[body_end:]
    parts = re.split(r"(?:<br\s*/?>\s*){2}", body)
    if len(parts) < 6:
        return full
    head: list[str] = []
    seen = 0
    for part in parts:
        head.append(part)
        seen += _visible_len(part)
        if seen >= head_chars:
            break
    tail: list[str] = []
    seen = 0
    for part in reversed(parts[len(head) :]):
        tail.insert(0, part)
        seen += _visible_len(part)
        if seen >= tail_chars:
            break
    return full.replace(outer, "<br><br>".join(head + tail) + rest, 1)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    log = [f"Recorded {dt.date.today().isoformat()} from {BASE}", ""]
    with httpx.Client(headers={"User-Agent": UA}, timeout=30, follow_redirects=False) as client:
        for name, path, is_chapter in PAGES:
            response = client.get(BASE + path)
            html = minimize(response.text)
            if is_chapter:
                html = excerpt_chapter(html)
            (OUT / name).write_text(html, encoding="utf-8", newline="\n")
            log.append(f"{name}: {response.status_code} {path} ({len(html)} chars)")
            print(log[-1])
            time.sleep(1.5)
    (OUT / "SOURCES.txt").write_text("\n".join(log) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
