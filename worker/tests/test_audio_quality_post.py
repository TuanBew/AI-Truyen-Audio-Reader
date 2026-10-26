from pathlib import Path

import numpy as np
import pytest

from audiotruyen_worker.audio.baselines import BASE_CLIPS_DIR, DEFAULT_BASELINE, Baselines
from audiotruyen_worker.audio.post import (
    PEAK_LIMIT,
    TARGET_RMS,
    finish_segment,
    normalize,
    pause_ms,
    trim,
)
from audiotruyen_worker.audio.quality import hf_ratio, is_noisy
from audiotruyen_worker.tts.base import VoiceRef

SR = 48_000


def tone(seconds: float, freq: float = 220.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def test_hf_ratio_rises_with_hiss():
    rng = np.random.default_rng(1)
    clean = tone(1.0)
    hiss = clean + rng.normal(0, 0.01, clean.shape).astype(np.float32)
    assert hf_ratio(clean) < 1e-4
    assert hf_ratio(hiss) > 10 * hf_ratio(clean)


def test_hf_ratio_skips_silence_and_short_audio():
    assert hf_ratio(np.zeros(SR, dtype=np.float32)) is None
    assert hf_ratio(tone(0.01)) is None


@pytest.mark.parametrize(
    ("clip", "expected"),
    [("narrator.wav", 0.56e-3), ("male.wav", 0.64e-3), ("female.wav", 0.41e-3)],
)
def test_archived_base_clips_reproduce_the_m0_baselines(clip, expected):
    import soundfile as sf

    audio, rate = sf.read(BASE_CLIPS_DIR / clip, dtype="float32")
    assert rate == SR
    assert hf_ratio(audio) == pytest.approx(expected, abs=0.01e-3)


def test_is_noisy_threshold():
    assert is_noisy(1.5e-3, 0.56e-3) and not is_noisy(1.3e-3, 0.56e-3) and not is_noisy(None, 1e-3)


class _CountingTTS:
    name, sample_rate, device = "count", SR, "cpu"

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        return tone(1.0)


def test_baselines_use_archived_clips_then_calibrate_once_then_default(tmp_path):
    tts = _CountingTTS()
    baselines = Baselines(tts)
    assert baselines(VoiceRef("v1", preset="Đức Trí")) == pytest.approx(0.56e-3, abs=0.01e-3)
    other = VoiceRef("v2", preset="Hải Đăng")
    first = baselines(other)
    assert baselines(other) == first and tts.calls == 1  # calibrated once, cached
    assert Baselines(tts, clips_dir=Path(tmp_path))(VoiceRef("v3", ref_path="missing.wav")) == (
        DEFAULT_BASELINE
    )


def test_trim_keeps_speech_with_a_small_pad():
    audio = np.concatenate([np.zeros(SR), tone(0.5), np.zeros(SR)])
    out = trim(audio)
    assert int(0.5 * SR) <= len(out) <= int(0.5 * SR) + 2 * int(0.02 * SR) + 2
    assert len(trim(np.zeros(100, dtype=np.float32))) == 0


def test_normalize_reaches_target_and_respects_the_peak_limit():
    quiet = normalize(tone(0.5, amp=0.01))
    assert float(np.sqrt(np.mean(quiet**2))) == pytest.approx(TARGET_RMS, rel=0.01)
    spiky = np.zeros(SR, dtype=np.float32)
    spiky[100] = 0.5
    assert float(np.max(np.abs(normalize(spiky)))) == pytest.approx(PEAK_LIMIT)


@pytest.mark.parametrize(
    ("emotion", "paragraph_end", "expected"),
    [("neutral", False, 250), ("sad", False, 450), ("tender", True, 650), ("angry", False, 150),
     ("shout", True, 350), ("happy", False, 250)],
)  # fmt: skip
def test_pause_by_emotion(emotion, paragraph_end, expected):
    assert pause_ms(emotion, paragraph_end) == expected


def test_finish_segment_reports_speech_length():
    pcm, speech = finish_segment(tone(0.5), "neutral", False)
    assert len(pcm) == speech + 250 * SR // 1000
    assert pcm.dtype == np.float32
