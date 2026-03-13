"""Edge TTS service — uses Microsoft Edge's free TTS API via edge-tts library.
Voice: vi-VN-NamMinhNeural (Vietnamese male, no API key required, no char limit).

Important: _run_provider_chain() in the router is a synchronous function called from
async FastAPI routes. Calling asyncio.run() directly from such code raises
RuntimeError ("This event loop is already running"). We work around this by
running the async coroutine in a fresh ThreadPoolExecutor thread, which gets its
own clean event loop. This is the standard pattern for calling async libs from
sync code that runs inside an existing asyncio event loop.
"""
import asyncio
import concurrent.futures
import io
import logging

import edge_tts

logger = logging.getLogger(__name__)

EDGE_VOICE = "vi-VN-NamMinhNeural"


class EdgeTTSError(Exception):
    """Raised when Edge TTS synthesis fails."""


async def _synthesize_async(text: str, rate: str, volume: str) -> bytes:
    """Coroutine that streams Edge TTS audio into memory and returns bytes."""
    communicate = edge_tts.Communicate(text, EDGE_VOICE, rate=rate, volume=volume)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    audio = buf.getvalue()
    if not audio:
        raise EdgeTTSError("Edge TTS returned empty audio")
    return audio


def _run_coro_in_thread(coro) -> bytes:
    """Run an async coroutine in a fresh thread with its own event loop.
    Safe to call from within a running asyncio event loop (e.g. FastAPI handlers).
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(asyncio.run, coro)
        return future.result()


def synthesize(text: str, speed: float = 1.0) -> bytes:
    """Synthesize Vietnamese text via Edge TTS. Returns raw MP3 bytes.

    Args:
        text: Text to synthesize (no practical length limit).
        speed: Playback speed 0.5-2.0. Converted to Edge TTS rate string (+/-%).
    Returns:
        MP3 bytes.
    Raises:
        EdgeTTSError: On synthesis failure.
    """
    rate_pct = int((speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    try:
        return _run_coro_in_thread(_synthesize_async(text, rate=rate_str, volume="+0%"))
    except EdgeTTSError:
        raise
    except Exception as e:
        raise EdgeTTSError(f"Edge TTS synthesis failed: {e}") from e
