"""Tests for XTTS-v2 Coqui TTS synchronous HTTP service."""
import pytest
import httpx
from unittest.mock import patch, MagicMock
from services.tts_xtts import synthesize, XTTSTTSError, XTTSQuotaError


def test_synthesize_returns_bytes_on_success():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.content = b"RIFF....WAV"

    with patch("services.tts_xtts.httpx.Client") as MockClient:
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get = MagicMock(return_value=mock_response)
        MockClient.return_value = mock_client

        result = synthesize("Xin chào", endpoint="http://localhost:5002")
        assert result == b"RIFF....WAV"


def test_synthesize_raises_quota_on_429():
    mock_response = MagicMock(status_code=429)

    with patch("services.tts_xtts.httpx.Client") as MockClient:
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get = MagicMock(return_value=mock_response)
        MockClient.return_value = mock_client

        with pytest.raises(XTTSQuotaError):
            synthesize("text", endpoint="http://localhost:5002")


def test_synthesize_raises_error_on_connection_refused():
    with patch("services.tts_xtts.httpx.Client") as MockClient:
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get = MagicMock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        MockClient.return_value = mock_client

        with pytest.raises(XTTSTTSError, match="unreachable"):
            synthesize("text", endpoint="http://localhost:5002")


def test_synthesize_rejects_text_over_300_chars():
    with pytest.raises(XTTSTTSError, match="300"):
        synthesize("x" * 301, endpoint="http://localhost:5002")
