"""Tests for the ADC client lazy-singleton and reset mechanism."""
import os
import pytest
from unittest.mock import patch, MagicMock
from services import tts_gemini


def test_get_client_raises_when_no_credentials():
    """get_client() must raise GeminiTTSError when env var is missing."""
    original = os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
    try:
        tts_gemini.reset_client()
        with pytest.raises(tts_gemini.GeminiTTSError, match="GOOGLE_APPLICATION_CREDENTIALS"):
            tts_gemini.get_client()
    finally:
        if original:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = original
        tts_gemini.reset_client()


def test_get_client_returns_same_instance():
    """get_client() must return the cached instance on repeated calls."""
    with patch("services.tts_gemini.texttospeech.TextToSpeechClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance
        with patch("os.path.exists", return_value=True):
            with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/fake/path.json"}):
                tts_gemini.reset_client()
                first = tts_gemini.get_client()
                second = tts_gemini.get_client()
                third = tts_gemini.get_client()
                assert first is second is third
                # Must construct exactly once despite three calls
                assert MockClient.call_count == 1
                tts_gemini.reset_client()


def test_reset_client_forces_reinit():
    """reset_client() must cause the next get_client() to create a new instance."""
    with patch("services.tts_gemini.texttospeech.TextToSpeechClient") as MockClient:
        MockClient.side_effect = [MagicMock(name="client_v1"), MagicMock(name="client_v2")]
        with patch("os.path.exists", return_value=True):
            with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/fake/path.json"}):
                tts_gemini.reset_client()
                first = tts_gemini.get_client()
                tts_gemini.reset_client()
                second = tts_gemini.get_client()
                assert first is not second
                assert MockClient.call_count == 2
                tts_gemini.reset_client()


def test_list_voices_uses_cached_singleton(monkeypatch):
    """list_voices() must call get_client(), not construct its own TextToSpeechClient."""
    mock_client = MagicMock()
    mock_client.list_voices.return_value = MagicMock(voices=[])
    # Inject the mock directly into the module-level cache
    monkeypatch.setattr(tts_gemini, "_client", mock_client)
    result = tts_gemini.list_voices("vi-VN")
    mock_client.list_voices.assert_called_once_with(language_code="vi-VN")
    assert result == []
    # Cleanup: clear injected mock so subsequent tests start fresh
    monkeypatch.setattr(tts_gemini, "_client", None)
