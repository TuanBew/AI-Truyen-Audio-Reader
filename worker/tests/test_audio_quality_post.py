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


def test_heavy_hiss_fails_closed_not_open():
    rng = np.random.default_rng(2)
    noisy = tone(1.0) + rng.normal(0, 0.1, SR).astype(np.float32)
    white = rng.normal(0, 0.1, SR).astype(np.float32)
    assert hf_ratio(noisy) == float("inf") and is_noisy(hf_ratio(noisy), 0.56e-3)
    assert hf_ratio(white) == float("inf") and is_noisy(hf_ratio(white), 0.56e-3)


def test_short_or_quiet_takes_still_skip_the_guard():
    rng = np.random.default_rng(3)
    assert hf_ratio(rng.normal(0, 0.1, int(0.2 * SR)).astype(np.float32)) is None  # < 0.5 s
    assert hf_ratio(rng.normal(0, 0.005, SR).astype(np.float32)) is None  # whispered overall


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_non_finite_take_is_defective_without_warnings(bad):
    import warnings

    audio = tone(1.0)
    audio[1000] = bad
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        ratio = hf_ratio(audio)
    assert ratio == float("inf") and is_noisy(ratio, 0.56e-3)


def test_finish_segment_scrubs_non_finite_samples():
    audio = tone(0.5)
    audio[100], audio[200], audio[300] = np.nan, np.inf, -np.inf
    pcm, speech = finish_segment(audio, "neutral", False)
    assert np.isfinite(pcm).all() and speech > 0


def test_fake_tts_output_still_gives_a_finite_ratio():
    from audiotruyen_worker.tts.fake import FakeTTS

    ratio = hf_ratio(FakeTTS().synthesize("Xin chào các bạn", VoiceRef("v"), "neutral", 0.0))
    assert ratio is not None and np.isfinite(ratio)


def _write_clip(path, audio):
    import soundfile as sf

    sf.write(path, audio, SR, subtype="FLOAT")
    return str(path)


def test_baseline_ignores_non_finite_ratios_from_defective_references(tmp_path):
    rng = np.random.default_rng(4)
    hiss_clip = _write_clip(tmp_path / "hiss.wav", rng.normal(0, 0.1, SR).astype(np.float32))
    nan_audio = tone(1.0)
    nan_audio[1000] = np.nan
    nan_clip = _write_clip(tmp_path / "nan.wav", nan_audio)
    baselines = Baselines(_CountingTTS())
    assert baselines(VoiceRef("c1", ref_path=hiss_clip)) == DEFAULT_BASELINE
    assert baselines(VoiceRef("c2", ref_path=nan_clip)) == DEFAULT_BASELINE


def test_baseline_calibration_with_a_hissy_take_falls_back_to_default():
    class _HissTTS(_CountingTTS):
        def synthesize(self, text, voice, emotion, intensity):
            return np.random.default_rng(5).normal(0, 0.1, SR).astype(np.float32)

    assert Baselines(_HissTTS())(VoiceRef("v9", preset="Hải Đăng")) == DEFAULT_BASELINE
