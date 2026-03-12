import httpx
import asyncio
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    "Accept-Language": "vi-VN,vi;q=0.9",
    "Referer": "https://truyenplus.vn/",
}

async def main():
    url = "https://truyenplus.vn/huyen-giam-tien-toc/chuong-1-wy_edfwgTHUp"
    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=25) as client:
        resp = await client.get(url)
        soup = BeautifulSoup(resp.text, "lxml")

    print("=== Tags with ID ===")
    for tag in soup.find_all(["div", "article", "section"], id=True):
        t = tag.get_text(strip=True)[:50]
        print(f"  id={tag['id']!r} tag={tag.name} text={t!r}")

    print()
    print("=== Divs with large text content (>200 chars) ===")
    for tag in soup.find_all(["div", "article"], class_=True):
        cls = " ".join(tag.get("class", []))
        text = tag.get_text(strip=True)
        if len(text) > 200:
            print(f"  class={cls!r} len={len(text)} first80={text[:80]!r}")

    print()
    print("=== All headings ===")
    for h in soup.find_all(["h1", "h2", "h3"]):
        print(f"  {h.name} class={h.get('class')} text={h.get_text(strip=True)[:80]!r}")

    print()
    print("=== Nav links (prev/next) ===")
    for a in soup.find_all("a"):
        text = a.get_text(strip=True)
        href = a.get("href", "")
        cls = " ".join(a.get("class", []))
        if any(kw in text for kw in ["Trước", "tiếp", "trước", "Tiếp", "Prev", "Next", "prev", "next"]):
            print(f"  a class={cls!r} href={href!r} text={text!r}")

asyncio.run(main())
