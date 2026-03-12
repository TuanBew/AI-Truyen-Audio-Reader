"""
Coqui XTTS-v2 Vietnamese TTS service — synchronous HTTP client.

Calls the Coqui TTS server hosting thivux/XTTS-v2-vietnamse.

User setup:
  pip install TTS
  tts-server --model_name tts_models/vi/thivux/xtts_v2 --port 5002

API:
  GET http://{endpoint}/api/tts?text={encoded_text}&language=vi
  → WAV audio bytes

Note: Synchronous httpx is used intentionally to avoid asyncio.run() deadlock
inside the synchronous _run_provider_chain() function in routers/tts.py.
"""

import os
import urllib.parse

import httpx


class XTTSTTSError(Exception):
    pass


class XTTSQuotaError(XTTSTTSError):
    pass


_DEFAULT_ENDPOINT = "http://localhost:5002"
_MAX_TEXT_LENGTH = 300


def synthesize(
    text: str,
    language: str = "vi",
    endpoint: str | None = None,
) -> bytes:
    """
    Synthesize a single sentence via Coqui TTS HTTP API (synchronous).

    Args:
        text: Sentence to synthesize. Must be ≤300 chars.
        language: Language code (default: "vi").
        endpoint: Server base URL. Falls back to XTTS_ENDPOINT env var.

    Returns:
        WAV audio bytes.

    Raises:
        XTTSTTSError: Server unreachable, error response, or text too long.
        XTTSQuotaError: HTTP 429 / 503.
    """
    if len(text) > _MAX_TEXT_LENGTH:
        raise XTTSTTSError(
            f"Text length {len(text)} exceeds {_MAX_TEXT_LENGTH}-char VRAM-safety limit."
        )

    base = endpoint or os.getenv("XTTS_ENDPOINT", _DEFAULT_ENDPOINT)
    url = f"{base}/api/tts?text={urllib.parse.quote(text)}&language={language}"

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(url)
    except httpx.ConnectError as e:
        raise XTTSTTSError(
            f"XTTS server unreachable at {base}. "
            "Is the Coqui TTS server running? See README → XTTS Setup. "
            f"Detail: {e}"
        )
    except httpx.TimeoutException as e:
        raise XTTSTTSError(f"XTTS request timed out (30s): {e}")
    except httpx.HTTPError as e:
        raise XTTSTTSError(f"XTTS HTTP error: {e}")

    if response.status_code in (429, 503):
        raise XTTSQuotaError(f"XTTS server overloaded (HTTP {response.status_code})")
    if response.status_code != 200:
        raise XTTSTTSError(
            f"XTTS returned HTTP {response.status_code}: {response.text[:200]}"
        )
    return response.content
