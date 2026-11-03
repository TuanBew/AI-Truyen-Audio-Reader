"""`--fake-tts` (spec 5.9): sine tones whose length follows the text, for tests and E2E runs."""

from __future__ import annotations

import zlib

import numpy as np

from audiotruyen_worker.tts.base import SAMPLE_RATE, VoiceRef

SECONDS_PER_CHAR = 0.055
MIN_SECONDS = 0.3


class FakeTTS:
    name = "fake"
    sample_rate = SAMPLE_RATE
    device = "fake"

    def synthesize(self, text: str, voice: VoiceRef, emotion: str, intensity: float) -> np.ndarray:
        seconds = max(MIN_SECONDS, SECONDS_PER_CHAR * len(text))
        n = int(seconds * SAMPLE_RATE)
        freq = 180 + zlib.crc32(voice.voice_id.encode()) % 220  # stable per voice
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        envelope = np.minimum(1.0, np.minimum(t, seconds - t) / 0.02)  # 20 ms fades, no clicks
        return (0.2 * np.sin(2 * np.pi * freq * t) * envelope).astype(np.float32)
