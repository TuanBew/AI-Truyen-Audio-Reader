"""Quality-guard baselines per voice (spec 5.6): the HF ratio of the voice's neutral reference.
For the three default presets that is the archived M0 base clip; other presets are calibrated
once with a fixed sentence; clone voices use their reference clip. Cached per voice."""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from audiotruyen_worker.audio.quality import hf_ratio
from audiotruyen_worker.config import WORKER_ROOT
from audiotruyen_worker.tts.base import TTSProvider, VoiceRef

log = logging.getLogger(__name__)

BASE_CLIPS_DIR = WORKER_ROOT.parent / "assets" / "voice-refs" / "m0" / "base"
BASE_CLIPS = {"Đức Trí": "narrator.wav", "Thái Sơn": "male.wav", "Mỹ Duyên": "female.wav"}
CALIBRATION_TEXT = "Hôm nay trời trong xanh, gió nhẹ thổi qua những hàng cây ven đường."
DEFAULT_BASELINE = 0.6e-3  # median of the three M0 base clips, used when nothing can be measured


def _clip_ratio(path: Path) -> float | None:
    audio, rate = sf.read(path, dtype="float32", always_2d=False)
    if rate != 48_000:
        raise ValueError(f"{path.name}: {rate} Hz, expected 48000")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return hf_ratio(np.asarray(audio, dtype=np.float32))


class Baselines:
    def __init__(self, tts: TTSProvider, clips_dir: Path = BASE_CLIPS_DIR) -> None:
        self._tts = tts
        self._clips_dir = clips_dir
        self._cache: dict[str, float] = {}
        self._lock = threading.Lock()

    def __call__(self, voice: VoiceRef) -> float:
        key = f"preset:{voice.preset}" if voice.preset else f"ref:{voice.ref_path}"
        with self._lock:
            if key not in self._cache:
                self._cache[key] = self._measure(voice)
            return self._cache[key]

    def _measure(self, voice: VoiceRef) -> float:
        ratio: float | None = None
        try:
            if voice.preset and voice.preset in BASE_CLIPS:
                ratio = _clip_ratio(self._clips_dir / BASE_CLIPS[voice.preset])
            elif voice.preset:
                neutral = VoiceRef(voice.voice_id, preset=voice.preset)
                ratio = hf_ratio(self._tts.synthesize(CALIBRATION_TEXT, neutral, "neutral", 0.0))
            elif voice.ref_path:
                ratio = _clip_ratio(Path(voice.ref_path))
        except Exception:  # the guard must never block synthesis
            log.exception("baseline for %s failed; using the default", voice.voice_id)
        return ratio if ratio else DEFAULT_BASELINE
