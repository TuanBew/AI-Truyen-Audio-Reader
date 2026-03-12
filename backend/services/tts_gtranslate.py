"""Google Translate TTS — last-resort fallback only."""

import urllib.parse
import httpx


class GTTranslateTTSError(Exception):
    pass


def synthesize(
    text: str,
    lang: str = "vi",
    slow: bool = False,
) -> bytes:
    """
    Synthesize short text using the unofficial Google Translate TTS endpoint.
    WARNING: This is an unofficial API and may break at any time.
    Limited to ~200 chars per request due to URL length constraints.

    Raises:
        GTTranslateTTSError: On any failure.
    """
    # Truncate to safe length
    if len(text) > 200:
        text = text[:200]

    url = (
        "https://translate.google.com/translate_tts"
        f"?ie=UTF-8&q={urllib.parse.quote(text)}&tl={lang}"
        f"&slow={'true' if slow else 'false'}&client=tw-ob"
    )

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        "Referer": "https://translate.google.com/",
    }

    try:
        with httpx.Client(timeout=15, headers=headers) as client:
            resp = client.get(url)
            resp.raise_for_status()
        return resp.content
    except httpx.HTTPStatusError as e:
        raise GTTranslateTTSError(f"Google Translate TTS HTTP error: {e}")
    except httpx.RequestError as e:
        raise GTTranslateTTSError(f"Google Translate TTS network error: {e}")


def synthesize_long(text: str, lang: str = "vi") -> bytes:
    """
    Synthesize longer text by splitting into chunks of ≤200 chars at sentence boundaries.
    Concatenates raw MP3 bytes (may have minor artifacts at joins).
    """
    import re

    # Split at sentence/clause boundaries
    sentences = re.split(r"(?<=[.!?。！？])\s+", text)
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        if len(current) + len(sentence) <= 190:
            current = (current + " " + sentence).strip()
        else:
            if current:
                chunks.append(current)
            current = sentence[:190]
    if current:
        chunks.append(current)

    audio_parts = []
    for chunk in chunks:
        try:
            audio_parts.append(synthesize(chunk, lang=lang))
        except GTTranslateTTSError:
            pass  # skip failed chunk silently

    if not audio_parts:
        raise GTTranslateTTSError("All chunks failed in Google Translate TTS.")

    return b"".join(audio_parts)
