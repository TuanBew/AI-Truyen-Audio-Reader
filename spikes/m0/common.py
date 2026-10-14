"""Shared helpers for the M0 spikes. THROWAWAY CODE: not part of the product."""

from __future__ import annotations

import re
import sys

SAMPLE_RATE = 48_000
DEFAULT_CHAPTER_URL = "https://truyenfull.live/ga-nham-cho-dai-lao-trong-van-nien-dai/chuong-1/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

_SEO_TAIL = re.compile(r"truyen ?full.*$", re.IGNORECASE | re.DOTALL)
_DOTTED = re.compile(r"(?<!\w)((?:\w\.){2,}\w)(?!\w)")
_SENTENCE = re.compile(r".+?(?:[.!?…]+[\"”’)]*(?=\s)|$)", re.DOTALL)


def utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")


def extract_chapter_text(html: str) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    node = soup.select_one("#chapter-c")
    if node is None:
        raise ValueError("#chapter-c not found")
    for junk in node.select('[id^="ads"], [class*="ads"]'):
        junk.decompose()
    for br in node.find_all("br"):
        br.replace_with("\n")
    text = _SEO_TAIL.sub("", node.get_text())
    lines = (line.strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def fetch_chapter_text(url: str) -> str:
    import httpx

    response = httpx.get(url, headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=30)
    response.raise_for_status()
    return extract_chapter_text(response.text)


def deobfuscate(text: str) -> str:
    return _DOTTED.sub(lambda m: m.group(1).replace(".", ""), text)


def _wrap(sentence: str, max_chars: int) -> list[str]:
    if len(sentence) <= max_chars:
        return [sentence]
    parts: list[str] = []
    current = ""
    for token in re.split(r"(?<=,)\s+|\s+", sentence):
        candidate = f"{current} {token}".strip()
        if len(candidate) > max_chars and current:
            parts.append(current)
            current = token
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def split_sentences(text: str, max_chars: int = 250) -> list[str]:
    out: list[str] = []
    for paragraph in text.split("\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        for match in _SENTENCE.findall(paragraph):
            sentence = match.strip()
            if sentence:
                out.extend(_wrap(sentence, max_chars))
    return out
