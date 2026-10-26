"""Per-segment post-processing (spec 5.6): trim silence, normalize loudness, append the pause."""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 48_000
TARGET_RMS = 0.1  # about -20 dBFS
PEAK_LIMIT = 0.97
SILENCE = 0.01  # |x| below this at the edges is trimmed
EDGE_PAD = int(0.02 * SAMPLE_RATE)  # keep 20 ms around speech so onsets are not clipped

PAUSE_MS = {"neutral": 250, "sad": 450, "tender": 450, "angry": 150, "shout": 150}
DEFAULT_PAUSE_MS = 250
PARAGRAPH_EXTRA_MS = 200


def pause_ms(emotion: str, paragraph_end: bool) -> int:
    return PAUSE_MS.get(emotion, DEFAULT_PAUSE_MS) + (PARAGRAPH_EXTRA_MS if paragraph_end else 0)


def trim(pcm: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(pcm) >= SILENCE)
    if loud.size == 0:
        return pcm[:0]
    start = max(0, int(loud[0]) - EDGE_PAD)
    end = min(len(pcm), int(loud[-1]) + 1 + EDGE_PAD)
    return pcm[start:end]


def normalize(pcm: np.ndarray) -> np.ndarray:
    if pcm.size == 0:
        return pcm
    rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
    if rms < 1e-6:
        return pcm
    out = pcm * (TARGET_RMS / rms)
    peak = float(np.max(np.abs(out)))
    if peak > PEAK_LIMIT:
        out = out * (PEAK_LIMIT / peak)
    return out.astype(np.float32)


def finish_segment(pcm: np.ndarray, emotion: str, paragraph_end: bool) -> tuple[np.ndarray, int]:
    """Trimmed, normalized speech followed by the emotion/paragraph pause (float32 mono), and
    the number of speech samples before the pause (for segment timings)."""
    # last resort for a best-of-retries take that still has NaN/inf: never let it reach ffmpeg
    clean = np.nan_to_num(np.asarray(pcm, dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    speech = normalize(trim(clean))
    silence = np.zeros(pause_ms(emotion, paragraph_end) * SAMPLE_RATE // 1000, dtype=np.float32)
    return np.concatenate([speech, silence]), len(speech)
