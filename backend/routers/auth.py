"""
Auth router — manage Google Cloud service account credentials upload.
POST /api/auth/upload-credentials  — saves the JSON file to backend/credentials/
GET  /api/auth/credentials-status  — check whether creds file exists AND test real connectivity
"""

import json
import os
import pathlib
import logging

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse

router = APIRouter()
logger = logging.getLogger(__name__)

# Where we store the uploaded service account file
CREDENTIALS_DIR = pathlib.Path(__file__).parent.parent / "credentials"
CREDENTIALS_FILE = CREDENTIALS_DIR / "service_account.json"


def _ensure_env_var_set():
    """
    If the credentials file exists on disk but the env var is not set
    (e.g. after a server restart), set it automatically.
    This is called at module import time so TTS works immediately.
    """
    if CREDENTIALS_FILE.exists() and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(CREDENTIALS_FILE)
        logger.info("Auto-loaded GOOGLE_APPLICATION_CREDENTIALS from %s", CREDENTIALS_FILE)


# Run immediately on import so TTS is functional after any server restart.
_ensure_env_var_set()


def _validate_service_account(data: dict) -> list[str]:
    """Return list of missing required fields, empty if valid."""
    required = ["type", "project_id", "private_key_id", "private_key", "client_email"]
    return [f for f in required if f not in data]


def _test_google_cloud_connection() -> tuple[bool, str]:
    """Test Google Cloud TTS connectivity via the cached singleton."""
    try:
        from services import tts_gemini
        client = tts_gemini.get_client()
        client.list_voices(language_code="vi-VN")
        return True, ""
    except Exception as e:
        return False, str(e)


@router.post("/upload-credentials")
async def upload_credentials(file: UploadFile = File(...)):
    """
    Accept a Google Cloud service account JSON file, validate it, then save
    it to backend/credentials/service_account.json.
    Also updates GOOGLE_APPLICATION_CREDENTIALS in the current process env.
    """
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="File phải có đuôi .json")

    content = await file.read()
    if len(content) > 1_000_000:  # 1 MB sanity limit
        raise HTTPException(status_code=400, detail="File quá lớn (tối đa 1 MB)")

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="File không phải JSON hợp lệ")

    # Validate required SA fields
    missing = _validate_service_account(data)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Thiếu trường trong service account JSON: {', '.join(missing)}",
        )
    if data.get("type") != "service_account":
        raise HTTPException(
            status_code=400,
            detail='Trường "type" phải là "service_account"',
        )

    # Save file
    CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_FILE.write_bytes(content)

    # Update env var in current process so new TTS calls pick it up immediately
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(CREDENTIALS_FILE)
    # Invalidate the cached TTS client so the next request uses the new credentials.
    from services import tts_gemini as _tts_gemini
    _tts_gemini.reset_client()

    logger.info("Service account credentials saved to %s", CREDENTIALS_FILE)

    # Test real connectivity immediately after saving
    connected, connect_error = _test_google_cloud_connection()

    return JSONResponse({
        "success": True,
        "path": str(CREDENTIALS_FILE),
        "project_id": data.get("project_id", ""),
        "client_email": data.get("client_email", ""),
        "google_cloud_connected": connected,
        "connect_error": connect_error if not connected else None,
    })


@router.get("/credentials-status")
async def credentials_status():
    """
    Return whether a valid credentials file exists AND test real Google Cloud connectivity.
    """
    # Always ensure env var is set if file exists (handles server restarts)
    _ensure_env_var_set()

    if not CREDENTIALS_FILE.exists():
        return {
            "configured": False,
            "source": None,
            "project_id": None,
            "client_email": None,
            "google_cloud_connected": False,
            "connect_error": "Chưa có file credentials",
        }

    try:
        data = json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {
            "configured": False,
            "source": "corrupted",
            "project_id": None,
            "client_email": None,
            "google_cloud_connected": False,
            "connect_error": "File credentials bị lỗi",
        }

    # Test actual Google Cloud connectivity
    connected, connect_error = _test_google_cloud_connection()

    return {
        "configured": True,
        "source": "uploaded",
        "project_id": data.get("project_id"),
        "client_email": data.get("client_email"),
        "google_cloud_connected": connected,
        "connect_error": connect_error if not connected else None,
    }


@router.get("/test-connection")
async def test_connection():
    """Quickly test Google Cloud TTS connectivity without re-uploading credentials."""
    _ensure_env_var_set()
    connected, error = _test_google_cloud_connection()
    return {
        "connected": connected,
        "error": error if not connected else None,
    }
