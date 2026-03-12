"""MiniMax TTS service (T2A v2 API)."""

import os
import httpx


class MiniMaxTTSError(Exception):
    pass


class MiniMaxQuotaError(MiniMaxTTSError):
    """Raised when MiniMax quota/balance is exhausted."""
    pass


MINIMAX_TTS_URL = "https://api.minimax.chat/v1/t2a_v2"


def synthesize(
    text: str,
    voice_id: str = "male-qn-qingse",
    model: str = "speech-01-turbo",
    speed: float = 1.0,
    audio_format: str = "mp3",
) -> bytes:
    """
    Synthesize text using MiniMax T2A v2 API.

    Raises:
        MiniMaxQuotaError: Quota/balance exhausted.
        MiniMaxTTSError: Other MiniMax errors.
    """
    api_key = os.getenv("MINIMAX_API_KEY")
    group_id = os.getenv("MINIMAX_GROUP_ID")

    if not api_key:
        raise MiniMaxTTSError("MINIMAX_API_KEY is not set.")
    if not group_id:
        raise MiniMaxTTSError("MINIMAX_GROUP_ID is not set.")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "text": text,
        "stream": False,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": max(0.5, min(2.0, speed)),
            "vol": 1.0,
            "pitch": 0,
        },
        "audio_setting": {
            "audio_sample_rate": 32000,
            "bitrate": 128000,
            "format": audio_format,
            "channel": 1,
        },
    }

    url = f"{MINIMAX_TTS_URL}?GroupId={group_id}"

    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        if e.response.status_code in (429, 402):
            raise MiniMaxQuotaError(f"MiniMax quota/balance exhausted: {e}")
        raise MiniMaxTTSError(f"MiniMax HTTP error {e.response.status_code}: {e}")
    except httpx.RequestError as e:
        raise MiniMaxTTSError(f"MiniMax network error: {e}")

    data = resp.json()

    # Check for API-level errors
    base_resp = data.get("base_resp", {})
    status_code = base_resp.get("status_code", 0)
    if status_code != 0:
        msg = base_resp.get("status_msg", "Unknown error")
        if status_code in (1008, 1009):  # balance / quota error codes
            raise MiniMaxQuotaError(f"MiniMax quota error ({status_code}): {msg}")
        raise MiniMaxTTSError(f"MiniMax API error ({status_code}): {msg}")

    audio_hex = data.get("data", {}).get("audio")
    if not audio_hex:
        raise MiniMaxTTSError("MiniMax returned no audio data.")

    # MiniMax returns hex-encoded audio
    return bytes.fromhex(audio_hex)
