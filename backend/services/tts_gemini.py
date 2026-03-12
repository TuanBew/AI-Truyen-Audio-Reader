"""Gemini ADC (Application Default Credentials) TTS service."""

import os
import re
from typing import TypedDict, Optional


class WordTiming(TypedDict):
    word: str
    start_ms: float
    end_ms: float


from google.cloud import texttospeech
from google.api_core.exceptions import ResourceExhausted, PermissionDenied


class GeminiTTSError(Exception):
    pass


class GeminiQuotaError(GeminiTTSError):
    """Raised when API quota is exhausted."""
    pass


# Lazy singleton. reset_client() invalidates it; next get_client() re-creates.
_client: "texttospeech.TextToSpeechClient | None" = None


def get_client() -> "texttospeech.TextToSpeechClient":
    """Return the cached TTS client, creating it on first call.

    Raises:
        GeminiTTSError: if GOOGLE_APPLICATION_CREDENTIALS is missing or invalid.
    """
    global _client
    if _client is None:
        credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if not credentials_path or not os.path.exists(credentials_path):
            raise GeminiTTSError(
                "GOOGLE_APPLICATION_CREDENTIALS not set or file not found. "
                "Upload your service account JSON via Settings → Google Cloud."
            )
        try:
            _client = texttospeech.TextToSpeechClient()
        except Exception as e:
            raise GeminiTTSError(f"Failed to initialise Google TTS client: {e}")
    return _client


def reset_client() -> None:
    """Invalidate the cached client. Call after saving new credentials.

    The next call to get_client() will re-instantiate using the current
    GOOGLE_APPLICATION_CREDENTIALS env var value.
    """
    global _client
    _client = None


def _text_to_ssml_with_marks(text: str) -> tuple[str, list[str]]:
    """
    Convert plain text to SSML with <mark> tags around each word.
    Returns (ssml_string, list_of_word_strings).
    """
    # Split into tokens preserving spaces/punctuation positions
    words = re.findall(r'\S+', text)
    ssml_parts = ["<speak>"]
    for i, word in enumerate(words):
        # Sanitize word for mark name (alphanumeric + underscore only)
        safe_id = f"w{i}"
        ssml_parts.append(f'<mark name="{safe_id}"/>{word}')
    ssml_parts.append("</speak>")
    return " ".join(ssml_parts), words


def synthesize(
    text: str,
    language_code: str = "vi-VN",
    voice_name: str = "vi-VN-Neural2-A",
    speaking_rate: float = 1.0,
    pitch: float = 0.0,
    audio_encoding: texttospeech.AudioEncoding = texttospeech.AudioEncoding.MP3,
) -> bytes:
    """
    Synthesize text using Google Cloud TTS with Application Default Credentials.

    Raises:
        GeminiQuotaError: API quota exhausted.
        GeminiTTSError: Other errors (bad creds, invalid params, etc.)
    """
    client = get_client()

    synthesis_input = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(
        language_code=language_code,
        name=voice_name,
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=audio_encoding,
        speaking_rate=speaking_rate,
        pitch=pitch,
    )

    try:
        response = client.synthesize_speech(
            input=synthesis_input,
            voice=voice,
            audio_config=audio_config,
        )
        return response.audio_content
    except ResourceExhausted as e:
        raise GeminiQuotaError(f"Google TTS quota exhausted: {e}")
    except PermissionDenied as e:
        raise GeminiTTSError(f"Google TTS permission denied (check service account): {e}")
    except Exception as e:
        raise GeminiTTSError(f"Google TTS error: {e}")


def synthesize_with_timing(
    text: str,
    language_code: str = "vi-VN",
    voice_name: str = "vi-VN-Neural2-A",
    speaking_rate: float = 1.0,
    pitch: float = 0.0,
    audio_encoding: texttospeech.AudioEncoding = texttospeech.AudioEncoding.MP3,
) -> tuple[bytes, list[WordTiming]]:
    """
    Synthesize text using Google Cloud TTS with SSML mark-based word timings.

    Converts plain text → SSML with <mark> tags, then calls synthesize_speech
    with enable_time_pointing=[SSML_MARK] to get per-word timestamps.

    Returns:
        (audio_bytes, word_timings) where each timing is {word, start_ms, end_ms}.

    Raises:
        GeminiQuotaError: API quota exhausted.
        GeminiTTSError: Other errors.
    """
    client = get_client()

    ssml_text, words = _text_to_ssml_with_marks(text)

    synthesis_input = texttospeech.SynthesisInput(ssml=ssml_text)
    voice = texttospeech.VoiceSelectionParams(
        language_code=language_code,
        name=voice_name,
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=audio_encoding,
        speaking_rate=speaking_rate,
        pitch=pitch,
    )

    try:
        response = client.synthesize_speech(
            input=synthesis_input,
            voice=voice,
            audio_config=audio_config,
            enable_time_pointing=[
                texttospeech.SynthesizeSpeechRequest.TimepointType.SSML_MARK
            ],
        )

        audio_bytes = response.audio_content

        # Build timings from timepoints
        timings: list[WordTiming] = []
        timepoints = list(response.timepoints) if hasattr(response, "timepoints") else []

        if timepoints and words:
            for tp in timepoints:
                # mark_name is "w{i}" — extract the index
                try:
                    idx = int(tp.mark_name[1:])
                    if 0 <= idx < len(words):
                        timings.append(WordTiming(
                            word=words[idx],
                            start_ms=tp.time_seconds * 1000,
                            end_ms=tp.time_seconds * 1000,  # filled below
                        ))
                except (ValueError, IndexError):
                    pass

            # Estimate end times from next word's start
            for i in range(len(timings) - 1):
                timings[i]["end_ms"] = timings[i + 1]["start_ms"]
            if timings:
                timings[-1]["end_ms"] = timings[-1]["start_ms"] + 400  # last word ~400ms

        return audio_bytes, timings

    except ResourceExhausted as e:
        raise GeminiQuotaError(f"Google TTS quota exhausted: {e}")
    except PermissionDenied as e:
        raise GeminiTTSError(f"Google TTS permission denied (check service account): {e}")
    except Exception as e:
        raise GeminiTTSError(f"Google TTS error: {e}")


def list_voices(language_code: str = "vi-VN") -> list[dict]:
    """Return available voices for a language."""
    try:
        client = get_client()
        resp = client.list_voices(language_code=language_code)
        return [
            {
                "name": v.name,
                "gender": texttospeech.SsmlVoiceGender(v.ssml_gender).name,
                "language_codes": list(v.language_codes),
            }
            for v in resp.voices
        ]
    except Exception:
        return []
