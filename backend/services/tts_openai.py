"""OpenAI TTS service."""

import os
from openai import OpenAI, RateLimitError, AuthenticationError


class OpenAITTSError(Exception):
    pass


class OpenAIQuotaError(OpenAITTSError):
    """Raised when OpenAI rate limit / quota is hit."""
    pass


VALID_VOICES = {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}
VALID_MODELS = {"tts-1", "tts-1-hd"}


def synthesize(
    text: str,
    voice: str = "nova",
    model: str = "tts-1",
    response_format: str = "mp3",
    speed: float = 1.0,
) -> bytes:
    """
    Synthesize text using OpenAI TTS API.

    Raises:
        OpenAIQuotaError: Rate limit or quota exhausted.
        OpenAITTSError: Other OpenAI errors.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise OpenAITTSError("OPENAI_API_KEY is not set.")

    voice = voice if voice in VALID_VOICES else "nova"
    model = model if model in VALID_MODELS else "tts-1"
    speed = max(0.25, min(4.0, speed))  # clamp to API limits

    client = OpenAI(api_key=api_key)

    try:
        response = client.audio.speech.create(
            model=model,
            voice=voice,
            input=text,
            response_format=response_format,
            speed=speed,
        )
        return response.content
    except RateLimitError as e:
        raise OpenAIQuotaError(f"OpenAI TTS quota/rate limit: {e}")
    except AuthenticationError as e:
        raise OpenAITTSError(f"OpenAI authentication failed: {e}")
    except Exception as e:
        raise OpenAITTSError(f"OpenAI TTS error: {e}")
