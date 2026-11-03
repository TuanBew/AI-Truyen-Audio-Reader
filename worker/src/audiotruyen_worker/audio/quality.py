"""Segment quality guard metric (spec 5.6, M0 "S1 female-noise debug"): median over vowel-like
frames of power(4-12 kHz) / power(0-4 kHz). Higher means more hiss."""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 48_000
FRAME = int(0.040 * SAMPLE_RATE)  # 40 ms Hann frames
HOP = int(0.020 * SAMPLE_RATE)  # 20 ms hop
MIN_RMS = 0.03
MAX_ZCR = 0.06
MIN_GUARDED = SAMPLE_RATE // 2  # 0.5 s: a longer loud take with no vowel-like frame is all hiss
GUARD_FACTOR = 2.5  # re-synthesize when ratio > 2.5 x the voice baseline (tune on real chapters)

_WINDOW = np.hanning(FRAME).astype(np.float32)
_FREQS = np.fft.rfftfreq(FRAME, 1.0 / SAMPLE_RATE)
_LOW = _FREQS < 4000
_HIGH = (_FREQS >= 4000) & (_FREQS < 12000)


def hf_ratio(pcm: np.ndarray) -> float | None:
    """Median HF/LF power ratio over vowel-like frames.

    Returns inf (always noisy, the renderer retries) for a take with non-finite samples, and for
    a take of at least 0.5 s that is loud overall yet has no vowel-like frame (pure hiss fails
    the ZCR gate). Returns None, skipping the guard, for takes shorter than one frame, shorter
    than 0.5 s without a qualifying frame, or quiet overall (whispered)."""
    x = np.asarray(pcm, dtype=np.float32)
    if x.ndim != 1:
        raise ValueError("mono audio expected")
    if not np.isfinite(x).all():
        return float("inf")
    if len(x) < FRAME:
        return None
    count = 1 + (len(x) - FRAME) // HOP
    frames = np.lib.stride_tricks.sliding_window_view(x, FRAME)[::HOP][:count]
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    signs = np.signbit(frames)
    zcr = np.mean(signs[:, 1:] != signs[:, :-1], axis=1)
    keep = (rms >= MIN_RMS) & (zcr <= MAX_ZCR)
    if not keep.any():
        loud = len(x) >= MIN_GUARDED and float(np.sqrt(np.mean(x * x))) >= MIN_RMS
        return float("inf") if loud else None
    spectrum = np.abs(np.fft.rfft(frames[keep] * _WINDOW, axis=1)) ** 2
    low = spectrum[:, _LOW].sum(axis=1)
    high = spectrum[:, _HIGH].sum(axis=1)
    ratios = high / np.maximum(low, 1e-12)
    return float(np.median(ratios))


def is_noisy(ratio: float | None, baseline: float) -> bool:
    return ratio is not None and ratio > GUARD_FACTOR * baseline
