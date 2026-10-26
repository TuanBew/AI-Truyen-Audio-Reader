"""TTS provider contract (spec 5.6)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np

SAMPLE_RATE = 48_000
NEUTRAL_TEMPERATURE = 0.8
MAX_TEMPERATURE = 0.95


@dataclass(frozen=True)
class VoiceRef:
    """A voice to speak with: a VieNeu preset (no clone) or a reference clip to clone from."""

    voice_id: str
    preset: str | None = None
    ref_path: str | None = None


class TTSProvider(Protocol):
    name: str
    sample_rate: int

    @property
    def device(self) -> str: ...

    def synthesize(self, text: str, voice: VoiceRef, emotion: str, intensity: float) -> np.ndarray:
        """float32 mono at `sample_rate`."""
        ...


def temperature_for(emotion: str, intensity: float) -> float:
    """0.8 for neutral speech, up to 0.95 scaled by intensity for expressive segments."""
    if emotion == "neutral":
        return NEUTRAL_TEMPERATURE
    level = min(max(intensity, 0.0), 1.0)
    return round(NEUTRAL_TEMPERATURE + (MAX_TEMPERATURE - NEUTRAL_TEMPERATURE) * level, 3)
