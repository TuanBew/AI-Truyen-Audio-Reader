"""Scraper router — chapter text and TOC (full chapter list via AJAX API).

Key discovery (2026-03):
  truyenplus.vn paginates the chapter list via a JSON/AJAX endpoint:
    GET https://truyenplus.vn/get/listchap/{novel_id}?page=N
  Response: {"data": "<html-snippet-with-li-a-tags>"}

  The novel_id is embedded in the novel homepage HTML inside onclick attributes
  like: onclick='page(81099,2);'

  100 chapters per page, the paging div inside the data HTML indicates the last page.
"""

import asyncio
import re
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

ALLOWED_DOMAIN = "truyenplus.vn"
BASE_URL = "https://truyenplus.vn"
LISTCHAP_API = "https://truyenplus.vn/get/listchap/{novel_id}?page={page}"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
    "Referer": "https://truyenplus.vn/",
}
POLITE_DELAY_S = 0.8  # seconds between requests


def _validate_domain(url: str) -> None:
    """Raise HTTPException if URL is not from the allowed domain."""
    parsed = urlparse(url)
    if ALLOWED_DOMAIN not in parsed.netloc:
        raise HTTPException(
            status_code=400,
            detail=f"Only URLs from {ALLOWED_DOMAIN} are allowed.",
        )


def _clean_text(text: str) -> str:
    """Strip zero-width chars and normalise line endings."""
    text = re.sub(r"\u200b|\u200c|\u200d|\ufeff", "", text)
    text = re.sub(r"\r\n|\r", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Chapter scraper — single chapter text
# ---------------------------------------------------------------------------

class ChapterResponse(BaseModel):
    novel_title: str
    chapter_title: str
    chapter_number: Optional[int]
    content: str
    prev_url: Optional[str]
    next_url: Optional[str]
    source_url: str


@router.get("/chapter", response_model=ChapterResponse)
@limiter.limit("30/minute")
async def scrape_chapter(
    request: Request,
    url: str = Query(..., description="Chapter URL on truyenplus.vn"),
):
    """Scrape a single chapter's text content from truyenplus.vn."""
    _validate_domain(url)
    await asyncio.sleep(POLITE_DELAY_S)

    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=25) as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Network error: {e}")

    soup = BeautifulSoup(resp.text, "lxml")

    # --- Novel title: breadcrumb or h1 ---
    novel_title = ""
    crumb = soup.select("nav.breadcrumb a, .breadcrumb-item a, ol.breadcrumb a, .breadcrumb a")
    if len(crumb) >= 2:
        novel_title = crumb[1].get_text(strip=True)
    if not novel_title:
        h1 = soup.select_one("h1")
        if h1:
            novel_title = h1.get_text(strip=True)

    # --- Chapter title: look inside the content area or use page h2 ---
    chapter_title = ""
    # truyenplus.vn places the chapter heading in h2 after the reading div
    for sel in ["#vungdoc h2", "h2.chapter-title", ".chapter-title h2", "h2"]:
        tag = soup.select_one(sel)
        if tag:
            chapter_title = tag.get_text(strip=True)
            break
    # Fallback: use page <title>
    if not chapter_title:
        title_tag = soup.select_one("title")
        if title_tag:
            chapter_title = title_tag.get_text(strip=True).split("|")[0].strip()

    chapter_number = None
    m = re.search(r"ch[uư]ơng[- _]*(\d+)", chapter_title, re.IGNORECASE)
    if m:
        chapter_number = int(m.group(1))

    # --- Chapter content ---
    # truyenplus.vn puts chapter text in div#vungdoc
    content_div = soup.select_one("#vungdoc, #chapter-c, .chapter-content, .box-chap, article")
    if not content_div:
        raise HTTPException(status_code=422, detail="Could not find chapter content on page.")

    # Remove noise elements: scripts, ads, headings, and navigation links
    for tag in content_div.select("script, style, .ads, .ad, ins, .adsbox, h1, h2, h3, a"):
        tag.decompose()

    # Utility to detect short nav/header paragraphs (≤ 12 words and no period)
    def _is_nav_paragraph(text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return True
        words = stripped.split()
        # Short lines that look like navigation or metadata
        if len(words) <= 12 and "." not in stripped and "!" not in stripped and "?" not in stripped:
            nav_keywords = ["chương", "trước", "tiếp", "ebook", "tải", "giám", "tộc"]
            lower = stripped.lower()
            if any(kw in lower for kw in nav_keywords):
                return True
        return False

    paragraphs = [
        _clean_text(p.get_text())
        for p in content_div.find_all("p")
        if p.get_text(strip=True) and not _is_nav_paragraph(p.get_text())
    ]
    if not paragraphs:
        # Fallback: split raw text by newlines, still filter nav lines
        raw = content_div.get_text("\n")
        paragraphs = [
            _clean_text(line)
            for line in raw.splitlines()
            if line.strip() and not _is_nav_paragraph(line)
        ]

    content = "\n\n".join(paragraphs)

    # --- Prev / Next navigation ---
    # truyenplus.vn uses <a class="prev"> and <a class="next">
    prev_url = next_url = None

    prev_tag = soup.select_one("a.prev, a.prev-chap, a[rel='prev'], a.btn-prev")
    if not prev_tag:
        for a in soup.find_all("a"):
            text = a.get_text(strip=True)
            href = a.get("href", "")
            if "trước" in text and (href.startswith("/") or href.startswith("http")):
                prev_tag = a
                break

    if prev_tag:
        href = prev_tag.get("href", "")
        if href.startswith("/"):
            prev_url = BASE_URL + href
        elif href.startswith("http"):
            prev_url = href

    next_tag = soup.select_one("a.next, a.next-chap, a[rel='next'], a.btn-next")
    if not next_tag:
        for a in soup.find_all("a"):
            text = a.get_text(strip=True)
            href = a.get("href", "")
            if "tiếp" in text and (href.startswith("/") or href.startswith("http")):
                next_tag = a
                break

    if next_tag:
        href = next_tag.get("href", "")
        if href.startswith("/"):
            next_url = BASE_URL + href
        elif href.startswith("http"):
            next_url = href

    return ChapterResponse(
        novel_title=novel_title,
        chapter_title=chapter_title,
        chapter_number=chapter_number,
        content=content,
        prev_url=prev_url,
        next_url=next_url,
        source_url=url,
    )


# ---------------------------------------------------------------------------
# TOC scraper — all chapters via AJAX API
# ---------------------------------------------------------------------------

class ChapterMeta(BaseModel):
    title: str
    number: Optional[int]
    url: str


class TocResponse(BaseModel):
    novel_title: str
    novel_url: str
    novel_id: int
    total_chapters: int
    total_pages: int
    chapters: list[ChapterMeta]


async def _get_novel_id(client: httpx.AsyncClient, novel_url: str) -> tuple[int, str]:
    """
    Fetch the novel homepage and extract:
      - novel_id  (from onclick='page(81099,2)')
      - novel_title (from h1)
    """
    await asyncio.sleep(POLITE_DELAY_S)
    resp = await client.get(novel_url)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "lxml")

    # Extract novel_id from any onclick="page(ID, N)" attribute
    novel_id: Optional[int] = None
    for tag in soup.find_all(onclick=True):
        m = re.search(r"page\((\d+)\s*,", tag["onclick"])
        if m:
            novel_id = int(m.group(1))
            break

    if novel_id is None:
        # Try looking in script tags
        for script in soup.find_all("script"):
            m = re.search(r"page\((\d+)\s*,", script.get_text())
            if m:
                novel_id = int(m.group(1))
                break

    if novel_id is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Could not extract novel_id from page. "
                "The site may have changed its structure."
            ),
        )

    title_tag = soup.select_one("h1.truyen-title, h1")
    novel_title = title_tag.get_text(strip=True) if title_tag else ""

    return novel_id, novel_title


async def _fetch_listchap_page(
    client: httpx.AsyncClient, novel_id: int, page: int
) -> tuple[list[ChapterMeta], int]:
    """
    Call GET /get/listchap/{novel_id}?page={page}
    Returns: (chapters_on_this_page, last_page_number)
    """
    url = LISTCHAP_API.format(novel_id=novel_id, page=page)
    await asyncio.sleep(POLITE_DELAY_S)
    resp = await client.get(url)
    resp.raise_for_status()

    data = resp.json()
    html_fragment = data.get("data", "")
    if not html_fragment:
        return [], 0

    soup = BeautifulSoup(html_fragment, "lxml")

    # Collect all chapter links
    chapters: list[ChapterMeta] = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.startswith("/"):
            continue
        full_url = BASE_URL + href
        title = a.get_text(strip=True)
        num_match = re.search(r"(\d+)", title)
        number = int(num_match.group(1)) if num_match else None
        chapters.append(ChapterMeta(title=title, number=number, url=full_url))

    # Find the last page number from the paging div
    last_page = page
    paging_div = soup.select_one(".paging, div.paging")
    if paging_div:
        # onclick='page(81099, 11)' — find the max page number
        for tag in paging_div.find_all(onclick=True):
            m = re.search(r"page\(\d+\s*,\s*(\d+)\)", tag["onclick"])
            if m:
                last_page = max(last_page, int(m.group(1)))

    return chapters, last_page


@router.get("/toc", response_model=TocResponse)
@limiter.limit("5/minute")
async def scrape_toc(
    request: Request,
    url: str = Query(..., description="Novel homepage URL on truyenplus.vn"),
):
    """
    Scrape the full table of contents for a novel using the site's AJAX API.

    Strategy:
    1. Fetch novel homepage to extract novel_id and title
    2. Call GET /get/listchap/{novel_id}?page=1 to get chapters 1-100 and total pages
    3. Fetch remaining pages concurrently (with polite delay between batches)
    """
    _validate_domain(url)

    # Normalise to novel homepage (strip chapter path if given a chapter URL)
    parsed = urlparse(url)
    path_parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(path_parts) >= 2 and "chuong" in path_parts[-1]:
        novel_path = "/" + path_parts[0] + "/"
    else:
        novel_path = parsed.path
    novel_url = f"https://{ALLOWED_DOMAIN}{novel_path}"

    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=25) as client:
        # Step 1: Get novel ID + title
        try:
            novel_id, novel_title = await _get_novel_id(client, novel_url)
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Network error: {e}")

        # Step 2: Fetch page 1 to learn total_pages
        try:
            first_page_chapters, total_pages = await _fetch_listchap_page(client, novel_id, 1)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Could not fetch chapter list: {e}")

        if total_pages < 1:
            total_pages = 1

        all_chapters: list[ChapterMeta] = list(first_page_chapters)

        # Step 3: Fetch remaining pages (in small batches to be polite)
        BATCH_SIZE = 3
        remaining_pages = list(range(2, total_pages + 1))
        for i in range(0, len(remaining_pages), BATCH_SIZE):
            batch = remaining_pages[i : i + BATCH_SIZE]
            tasks = [_fetch_listchap_page(client, novel_id, p) for p in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    continue  # skip failed pages
                page_chapters, _ = result
                all_chapters.extend(page_chapters)
            # Extra polite pause between batches
            if i + BATCH_SIZE < len(remaining_pages):
                await asyncio.sleep(1.0)

    # De-duplicate (same URL may appear if pages overlap)
    seen: set[str] = set()
    unique_chapters: list[ChapterMeta] = []
    for ch in all_chapters:
        if ch.url not in seen:
            seen.add(ch.url)
            unique_chapters.append(ch)

    if not unique_chapters:
        raise HTTPException(status_code=422, detail="No chapters found. Check the novel URL.")

    return TocResponse(
        novel_title=novel_title,
        novel_url=novel_url,
        novel_id=novel_id,
        total_chapters=len(unique_chapters),
        total_pages=total_pages,
        chapters=unique_chapters,
    )
