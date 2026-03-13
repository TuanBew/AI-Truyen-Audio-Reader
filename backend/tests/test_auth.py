"""Tests for auth router — credential upload triggers client reset."""
import pytest
import json
import io
from unittest.mock import patch
from services import tts_gemini


VALID_SA = {
    "type": "service_account",
    "project_id": "test-project",
    "private_key_id": "key123",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    "client_email": "test@test-project.iam.gserviceaccount.com",
}


async def test_upload_credentials_resets_gemini_client(client, tmp_path, monkeypatch):
    """Uploading credentials must call tts_gemini.reset_client() exactly once."""
    reset_calls = []
    monkeypatch.setattr(tts_gemini, "reset_client", lambda: reset_calls.append(1))

    with patch("routers.auth.CREDENTIALS_DIR", tmp_path), \
         patch("routers.auth.CREDENTIALS_FILE", tmp_path / "service_account.json"), \
         patch("routers.auth._test_google_cloud_connection", return_value=(True, "")):

        response = await client.post(
            "/api/auth/upload-credentials",
            files={"file": ("service_account.json",
                            io.BytesIO(json.dumps(VALID_SA).encode()),
                            "application/json")},
        )

    assert response.status_code == 200
    assert len(reset_calls) == 1, f"reset_client() must be called once; called {len(reset_calls)} times"
