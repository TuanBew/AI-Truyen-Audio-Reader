"""Segmentation (spec 5.3 step 2): paragraphs -> dialogue/narration pieces -> pieces of at most
MAX_CHARS split at sentence boundaries. Offsets index the ORIGINAL chapter text."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

MAX_CHARS = 250
Kind = Literal["narration", "dialogue"]

_DASHES = "-–—"
_QUOTE_PAIRS = {"“": "”", '"': '"', "«": "»"}
_SENTENCE_END = re.compile(r"[.!?…]+[\"”’»)\]]*\s+")
_CLAUSE_END = re.compile(r"[,;:]\s+")
_HAS_WORD = re.compile(r"\w")


@dataclass(frozen=True)
class Segment:
    i: int
    kind: Kind
    start: int  # inclusive offset in the original text
    end: int  # exclusive offset
    text: str  # original[start:end]
    paragraph: int
    paragraph_end: bool  # last segment of its paragraph (longer pause)


def _paragraphs(text: str) -> list[tuple[int, int]]:
    spans, pos = [], 0
    for line in text.split("\n"):
        start, end = pos, pos + len(line)
        pos = end + 1
        lead = len(line) - len(line.lstrip())
        trail = len(line.rstrip())
        if trail > lead:
            spans.append((start + lead, start + trail))
    return spans


def _dialogue_spans(text: str, start: int, end: int) -> list[tuple[int, int, Kind]]:
    """Split one paragraph into (start, end, kind) pieces covering it in order."""
    if text[start] in _DASHES:
        # Dash-led dialogue: "- Lời thoại - hắn nói." The speech runs to the next spaced dash.
        sep = re.compile(r"\s[" + _DASHES + r"]\s")
        match = sep.search(text, start + 1, end)
        if match is None:
            return [(start, end, "dialogue")]
        return [(start, match.start(), "dialogue"), (match.start(), end, "narration")]

    pieces: list[tuple[int, int, Kind]] = []
    pos = cursor = start
    while pos < end:
        ch = text[pos]
        closer = _QUOTE_PAIRS.get(ch)
        if closer is None:
            pos += 1
            continue
        close = text.find(closer, pos + 1, end)
        stop = end if close == -1 else close + 1
        if pos > cursor:
            pieces.append((cursor, pos, "narration"))
        pieces.append((pos, stop, "dialogue"))
        cursor = pos = stop
    if cursor < end:
        pieces.append((cursor, end, "narration"))
    return pieces


def _last_boundary(pattern: re.Pattern[str], text: str, start: int, limit: int) -> int | None:
    last = None
    for match in pattern.finditer(text, start, limit + 1):
        if start < match.end() <= limit:
            last = match.end()
    return last


def _split_long(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Greedy: cut at the last sentence end within MAX_CHARS, else the last clause end, else
    the last space, else hard at MAX_CHARS."""
    out: list[tuple[int, int]] = []
    while end - start > MAX_CHARS:
        limit = start + MAX_CHARS
        cut = _last_boundary(_SENTENCE_END, text, start, limit)
        if cut is None:
            cut = _last_boundary(_CLAUSE_END, text, start, limit)
        if cut is None:
            space = text.rfind(" ", start + 1, limit)
            cut = space if space > start else limit
        out.append((start, cut))
        start = cut
    out.append((start, end))
    return out


def _trim(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def segment_text(text: str) -> list[Segment]:
    segments: list[Segment] = []
    for p_index, (p_start, p_end) in enumerate(_paragraphs(text)):
        para: list[tuple[int, int, Kind]] = []
        for start, end, kind in _dialogue_spans(text, p_start, p_end):
            for s, e in _split_long(text, start, end):
                s, e = _trim(text, s, e)
                if e > s and _HAS_WORD.search(text, s, e):
                    para.append((s, e, kind))
        for n, (s, e, kind) in enumerate(para):
            segments.append(
                Segment(
                    i=len(segments),
                    kind=kind,
                    start=s,
                    end=e,
                    text=text[s:e],
                    paragraph=p_index,
                    paragraph_end=n == len(para) - 1,
                )
            )
    return segments
