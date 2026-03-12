"""
TTS router — tries providers in order: Gemini → OpenAI → MiniMax → Google Translate.
Returns audio bytes with provider info in headers.
"""

import base64
import io
import logging
import re as _re
from enum import Enum
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from services import tts_gemini, tts_openai, tts_minimax, tts_gtranslate
from google.cloud import texttospeech as gctts

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)
logger = logging.getLogger(__name__)

_ABBREV_RE = _re.compile(
    r'\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|No|Vol|pp|e\.g|i\.e)\.',
    _re.IGNORECASE
)
# Numbered list prefixes require a trailing space so "3.14" is NOT protected
_NUMBERED_LIST_RE = _re.compile(r'(?<!\d)\b\d+\.\s')


def _split_into_sentences(text: str) -> list[str]:
    """Vietnamese-aware sentence splitter. Max 300 chars per sentence."""
    text = text.replace('...', '\x00EL\x00')

    def _protect(m: _re.Match) -> str:
        return m.group(0).replace('.', '\x00DOT\x00')

    text = _ABBREV_RE.sub(_protect, text)
    text = _NUMBERED_LIST_RE.sub(_protect, text)

    parts = _re.split(r'(?<=[.!?…])\s+', text.strip())
    parts = [
        p.replace('\x00EL\x00', '...').replace('\x00DOT\x00', '.')
        for p in parts if p.strip()
    ]

    # Enforce 300-char max by splitting at last word boundary
    result: list[str] = []
    for part in parts:
        while len(part) > 300:
            split_pos = part.rfind(' ', 0, 300)
            if split_pos == -1:
                split_pos = 300
            result.append(part[:split_pos].strip())
            part = part[split_pos:].strip()
        if part:
            result.append(part)

    # Merge sentences shorter than 5 chars with the next one
    merged: list[str] = []
    i = 0
    while i < len(result):
        s = result[i]
        if len(s.strip()) < 5 and i + 1 < len(result):
            merged.append(s.strip() + ' ' + result[i + 1].strip())
            i += 2
        else:
            merged.append(s)
            i += 1

    return [s for s in merged if s.strip()]


class TTSProvider(str, Enum):
    gemini = "gemini"
    openai = "openai"
    minimax = "minimax"
    gtranslate = "gtranslate"


class TTSRequest(BaseModel):
    text: str = Field(..., max_length=8000, description="Text to synthesize")
    preferred_provider: TTSProvider = TTSProvider.gemini
    audio_format: str = Field("mp3", pattern="^(mp3|wav)$")
    # Gemini options
    gemini_voice: str = "vi-VN-Neural2-A"
    gemini_language: str = "vi-VN"
    # OpenAI options
    openai_voice: str = "nova"
    openai_model: str = "tts-1"
    # MiniMax options
    minimax_voice_id: str = "male-qn-qingse"
    # Common
    speed: float = Field(1.0, ge=0.5, le=2.0)
    pitch: float = Field(0.0, ge=-10.0, le=10.0)


class TTSResult(BaseModel):
    provider_used: str
    fallback_used: bool
    fallback_reason: Optional[str]
    audio_format: str


class SplitRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def text_max_length(cls, v: str) -> str:
        if len(v) > 5000:
            raise ValueError("Text exceeds 5000 character limit")
        return v


def _encoding_from_format(fmt: str) -> "gctts.AudioEncoding":
    """Map format string to Google AudioEncoding."""
    return {
        "mp3": gctts.AudioEncoding.MP3,
        "wav": gctts.AudioEncoding.LINEAR16,
    }.get(fmt, gctts.AudioEncoding.MP3)


def _run_provider_chain(
    body: TTSRequest,
    use_timing: bool = False,
) -> tuple[bytes, str, bool, str, list]:
    """
    Try providers in order starting from preferred_provider.

    Returns:
        (audio_bytes, provider_used, fallback_used, fallback_reason, word_timings)
        word_timings is [] when use_timing=False or provider doesn't support it.
    """
    audio_bytes: Optional[bytes] = None
    provider_used = body.preferred_provider
    fallback_used = False
    fallback_reason: str = ""
    word_timings: list = []

    all_providers = [
        TTSProvider.gemini,
        TTSProvider.openai,
        TTSProvider.minimax,
        TTSProvider.gtranslate,
    ]
    start_idx = all_providers.index(body.preferred_provider)
    ordered = all_providers[start_idx:] + all_providers[:start_idx]

    for idx, provider in enumerate(ordered):
        try:
            if provider == TTSProvider.gemini:
                encoding = _encoding_from_format(body.audio_format)
                if use_timing:
                    audio_bytes, word_timings = tts_gemini.synthesize_with_timing(
                        text=body.text,
                        language_code=body.gemini_language,
                        voice_name=body.gemini_voice,
                        speaking_rate=body.speed,
                        pitch=body.pitch,
                        audio_encoding=encoding,
                    )
                else:
                    audio_bytes = tts_gemini.synthesize(
                        text=body.text,
                        language_code=body.gemini_language,
                        voice_name=body.gemini_voice,
                        speaking_rate=body.speed,
                        pitch=body.pitch,
                        audio_encoding=encoding,
                    )

            elif provider == TTSProvider.openai:
                audio_bytes = tts_openai.synthesize(
                    text=body.text,
                    voice=body.openai_voice,
                    model=body.openai_model,
                    response_format=body.audio_format,
                    speed=body.speed,
                )

            elif provider == TTSProvider.minimax:
                audio_bytes = tts_minimax.synthesize(
                    text=body.text,
                    voice_id=body.minimax_voice_id,
                    speed=body.speed,
                    audio_format=body.audio_format,
                )

            elif provider == TTSProvider.gtranslate:
                audio_bytes = tts_gtranslate.synthesize_long(
                    text=body.text,
                    lang=body.gemini_language[:2],
                )

            # Success!
            if idx > 0:
                fallback_used = True
            provider_used = provider
            break

        except (
            tts_gemini.GeminiQuotaError,
            tts_openai.OpenAIQuotaError,
            tts_minimax.MiniMaxQuotaError,
        ) as e:
            reason = f"{provider.value} quota exhausted: {e}"
            logger.warning(reason)
            if not fallback_reason:
                fallback_reason = reason
            continue

        except (
            tts_gemini.GeminiTTSError,
            tts_openai.OpenAITTSError,
            tts_minimax.MiniMaxTTSError,
            tts_gtranslate.GTTranslateTTSError,
        ) as e:
            reason = f"{provider.value} error: {e}"
            logger.warning(reason)
            if not fallback_reason:
                fallback_reason = reason
            continue

    if audio_bytes is None:
        raise HTTPException(
            status_code=503,
            detail="All TTS providers failed. Check API keys and credentials.",
        )

    return audio_bytes, provider_used.value, fallback_used, fallback_reason, word_timings


@router.post("/synthesize")
@limiter.limit("60/minute")
async def synthesize(request: Request, body: TTSRequest):
    """
    Synthesize text to audio.
    Tries providers in priority order, falling back on quota/auth errors.
    Returns audio stream with X-Provider-Used header.
    """
    audio_bytes, provider_used, fallback_used, fallback_reason, _ = _run_provider_chain(body)

    content_type = "audio/mpeg" if body.audio_format == "mp3" else "audio/wav"

    return StreamingResponse(
        io.BytesIO(audio_bytes),
        media_type=content_type,
        headers={
            "X-Provider-Used": provider_used,
            "X-Fallback-Used": str(fallback_used).lower(),
            "X-Fallback-Reason": fallback_reason or "",
            "Content-Length": str(len(audio_bytes)),
        },
    )


@router.post("/synthesize-with-timing")
@limiter.limit("60/minute")
async def synthesize_with_timing(request: Request, body: TTSRequest):
    """
    Synthesize text to audio AND return word-level timing data.

    Response JSON:
    {
        "audio_b64": "<base64 audio>",
        "audio_format": "mp3" | "wav",
        "provider_used": "gemini" | ...,
        "fallback_used": bool,
        "fallback_reason": str | null,
        "word_timings": [{"word": str, "start_ms": float, "end_ms": float}, ...]
                        (empty list if provider doesn't support it)
    }
    """
    audio_bytes, provider_used, fallback_used, fallback_reason, word_timings = (
        _run_provider_chain(body, use_timing=True)
    )

    return JSONResponse({
        "audio_b64": base64.b64encode(audio_bytes).decode("utf-8"),
        "audio_format": body.audio_format,
        "provider_used": provider_used,
        "fallback_used": fallback_used,
        "fallback_reason": fallback_reason or None,
        "word_timings": word_timings,
    })


@router.get("/voices/gemini")
async def list_gemini_voices(language_code: str = "vi-VN"):
    """List available Gemini/Google TTS voices."""
    return tts_gemini.list_voices(language_code=language_code)


@router.post("/split-sentences")
@limiter.limit("120/minute")
async def split_sentences(request: Request, body: SplitRequest):
    """Split chapter text into Vietnamese sentences for sentence-by-sentence TTS."""
    sentences = _split_into_sentences(body.text)
    return {"sentences": sentences, "count": len(sentences)}
