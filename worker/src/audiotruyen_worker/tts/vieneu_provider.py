"""VieNeu-TTS v3 Turbo provider (spec 2.2, 5.6). Needs the `cuda` (GPU) or `tts` (CPU, ONNX)
extra. Model files live in a dedicated Hugging Face cache under worker/models: huggingface_hub
<1.0 keeps each repo's blobs in its own folder, which onnxruntime's external-data check accepts
(the shared sharded cache of hub 2.x broke the ONNX CPU path in spike S3)."""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path

import numpy as np

from audiotruyen_worker.tts.base import SAMPLE_RATE, TTSUnavailable, VoiceRef, temperature_for

__all__ = ["TTSUnavailable", "VieneuProvider"]

log = logging.getLogger(__name__)


def _use_cache(cache_dir: Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = str(cache_dir)
    hub = sys.modules.get("huggingface_hub.constants")
    if hub is not None:  # imported earlier: its module-level default was read already
        hub.HF_HUB_CACHE = str(cache_dir)


def _cuda_available() -> bool:
    try:
        import torch
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


class VieneuProvider:
    name = "vieneu"
    sample_rate = SAMPLE_RATE

    def __init__(self, models_dir: Path, device: str = "auto") -> None:
        if device not in ("auto", "cuda", "cpu"):
            raise ValueError(f"bad TTS device {device!r}")
        self._models_dir = models_dir
        self._requested = device
        self._device: str | None = None
        self._tts = None
        self._failure: TTSUnavailable | None = None  # latched load failure (process lifetime)
        self._lock = threading.Lock()

    @property
    def device(self) -> str:
        if self._device:
            return self._device
        return "unavailable" if self._failure is not None else "loading"

    def load(self) -> None:
        """Load the model once (thread-safe). Called in the background at worker start. Any
        failure becomes TTSUnavailable and is latched: later calls raise it at once without
        retrying (the owner fixes the cause and restarts the worker)."""
        with self._lock:
            if self._tts is not None:
                return
            if self._failure is not None:
                raise self._failure
            try:
                self._load()
            except TTSUnavailable as exc:
                self._failure = exc
                raise
            except Exception as exc:  # ImportError, OSError, RuntimeError (CUDA), ...
                log.exception("VieNeu failed to load")
                # the message is for logs and never carries the raw error text
                self._failure = TTSUnavailable(f"VieNeu failed to load ({type(exc).__name__})")
                raise self._failure from exc

    def _load(self) -> None:
        _use_cache(self._models_dir / "hf")
        try:
            from vieneu import Vieneu
        except ImportError as exc:
            raise TTSUnavailable("vieneu is not installed (uv sync --extra cuda)") from exc
        device = self._requested
        if device == "auto":
            device = "cuda" if _cuda_available() else "cpu"
        if device == "cuda":
            tts = Vieneu(device="cuda", backend="pytorch")
        else:
            tts = Vieneu(device="cpu", backend="onnx")
        if tts.sample_rate != SAMPLE_RATE:
            raise TTSUnavailable(f"unexpected sample rate {tts.sample_rate}")
        self._tts, self._device = tts, device
        log.info("VieNeu loaded (device=%s, backend=%s)", device, tts.backend)

    def synthesize(self, text: str, voice: VoiceRef, emotion: str, intensity: float) -> np.ndarray:
        self.load()
        assert self._tts is not None
        kwargs: dict = {"temperature": temperature_for(emotion, intensity)}
        if voice.ref_path:
            kwargs["ref_audio"] = voice.ref_path
        elif voice.preset:
            kwargs["voice"] = voice.preset
        else:
            raise ValueError(f"voice {voice.voice_id} has neither a preset nor a reference clip")
        audio = self._tts.infer(text, **kwargs)
        return np.asarray(audio, dtype=np.float32).reshape(-1)
