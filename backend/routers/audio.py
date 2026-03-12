"""Audio router — save audio bytes to local disk in MP3 or WAV format."""

import os
import json
import time
import logging
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)
logger = logging.getLogger(__name__)

# Simple in-memory storage for last-used directory (single-user app)
_state: dict = {"last_save_dir": None}
_STATE_FILE = Path(__file__).parent.parent / ".audio_state.json"


def _load_state() -> None:
    if _STATE_FILE.exists():
        try:
            data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
            _state["last_save_dir"] = data.get("last_save_dir")
        except Exception:
            pass


def _save_state() -> None:
    try:
        _STATE_FILE.write_text(
            json.dumps({"last_save_dir": _state["last_save_dir"]}),
            encoding="utf-8",
        )
    except Exception:
        pass


_load_state()


class SaveResponse(BaseModel):
    saved_path: str
    file_size_bytes: int
    directory: str


@router.post("/save", response_model=SaveResponse)
@limiter.limit("120/minute")
async def save_audio(
    request: Request,
    audio: UploadFile = File(..., description="Audio file (mp3 or wav)"),
    directory: Optional[str] = Form(None, description="Absolute path to save directory"),
    filename: str = Form(..., description="Filename without extension"),
    audio_format: str = Form("mp3", pattern="^(mp3|wav)$"),
):
    """
    Save an uploaded audio file to a local directory.
    If directory is not provided, uses the last-used directory.
    """
    # Resolve save directory
    save_dir = directory or _state.get("last_save_dir")
    if not save_dir:
        raise HTTPException(
            status_code=400,
            detail="No save directory specified. Please provide a directory path.",
        )

    save_path = Path(save_dir)

    # Security: prevent path traversal and ensure it's absolute
    if not save_path.is_absolute():
        raise HTTPException(status_code=400, detail="Directory path must be absolute.")

    try:
        save_path.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot create directory: {e}")

    # Sanitise filename
    safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in filename)
    safe_name = safe_name.strip().replace(" ", "_") or f"audio_{int(time.time())}"
    output_file = save_path / f"{safe_name}.{audio_format}"

    # Avoid overwriting: append timestamp if file exists
    if output_file.exists():
        output_file = save_path / f"{safe_name}_{int(time.time())}.{audio_format}"

    # Write file
    content = await audio.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded audio is empty.")

    try:
        async with aiofiles.open(output_file, "wb") as f:
            await f.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {e}")

    # Persist directory for next request
    _state["last_save_dir"] = str(save_path)
    _save_state()

    logger.info(f"Audio saved: {output_file} ({len(content)} bytes)")

    return SaveResponse(
        saved_path=str(output_file),
        file_size_bytes=len(content),
        directory=str(save_path),
    )


@router.get("/last-directory")
async def get_last_directory():
    """Return the last-used save directory."""
    return {"directory": _state.get("last_save_dir")}


@router.post("/set-directory")
async def set_directory(directory: str = Form(...)):
    """Persist a new save directory without uploading a file."""
    p = Path(directory)
    if not p.is_absolute():
        raise HTTPException(status_code=400, detail="Path must be absolute.")
    _state["last_save_dir"] = str(p)
    _save_state()
    return {"directory": str(p)}
