import os
import sys
import types

import numpy as np
import pytest

from audiotruyen_worker.tts.base import VoiceRef, temperature_for
from audiotruyen_worker.tts.fake import FakeTTS
from audiotruyen_worker.tts.vieneu_provider import TTSUnavailable, VieneuProvider


def test_fake_tts_length_follows_text_and_tone_is_stable_per_voice():
    tts = FakeTTS()
    short = tts.synthesize("a", VoiceRef("v1"), "neutral", 0.0)
    long = tts.synthesize("x" * 100, VoiceRef("v1"), "neutral", 0.0)
    assert len(short) == int(0.3 * 48_000)
    assert len(long) == int(5.5 * 48_000)
    assert short.dtype == np.float32 and float(np.max(np.abs(long))) <= 0.2 + 1e-6
    assert np.array_equal(long, tts.synthesize("x" * 100, VoiceRef("v1"), "sad", 1.0))


@pytest.mark.parametrize(
    ("emotion", "intensity", "expected"),
    [("neutral", 1.0, 0.8), ("angry", 0.0, 0.8), ("angry", 0.5, 0.875), ("shout", 1.0, 0.95),
     ("sad", 7.0, 0.95)],
)  # fmt: skip
def test_temperature(emotion, intensity, expected):
    assert temperature_for(emotion, intensity) == pytest.approx(expected)


class _FakeVieneu:
    instances: list = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.backend = kwargs["backend"]
        self.sample_rate = 48_000
        self.calls: list = []
        _FakeVieneu.instances.append(self)

    def infer(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return np.ones(480, dtype=np.float64)


@pytest.fixture
def fake_vieneu(monkeypatch, tmp_path):
    _FakeVieneu.instances = []
    monkeypatch.setitem(sys.modules, "vieneu", types.SimpleNamespace(Vieneu=_FakeVieneu))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    return tmp_path


def test_provider_uses_its_own_hf_cache_and_onnx_on_cpu(fake_vieneu):
    provider = VieneuProvider(fake_vieneu, device="cpu")
    assert provider.device == "loading"
    audio = provider.synthesize("xin chào", VoiceRef("v", preset="Đức Trí"), "neutral", 0.0)
    assert os.environ["HF_HUB_CACHE"] == str(fake_vieneu / "hf")
    (instance,) = _FakeVieneu.instances
    assert instance.kwargs == {"device": "cpu", "backend": "onnx"}
    assert instance.calls == [("xin chào", {"temperature": 0.8, "voice": "Đức Trí"})]
    assert audio.dtype == np.float32 and provider.device == "cpu"


def test_provider_loads_once_and_clones_from_ref(fake_vieneu):
    provider = VieneuProvider(fake_vieneu, device="cuda")
    provider.load()
    provider.synthesize("a", VoiceRef("v", preset="P", ref_path="angry.wav"), "angry", 1.0)
    (instance,) = _FakeVieneu.instances
    assert instance.kwargs == {"device": "cuda", "backend": "pytorch"}
    assert instance.calls[0][1] == {"temperature": 0.95, "ref_audio": "angry.wav"}
    with pytest.raises(ValueError):
        provider.synthesize("a", VoiceRef("v"), "neutral", 0.0)


def test_provider_reports_missing_vieneu(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "vieneu", None)  # import fails
    with pytest.raises(TTSUnavailable):
        VieneuProvider(tmp_path).load()


def test_provider_rejects_unknown_device(tmp_path):
    with pytest.raises(ValueError):
        VieneuProvider(tmp_path, device="tpu")


class _BrokenVieneu(_FakeVieneu):
    error: BaseException | None = RuntimeError("CUDA error: out of memory")
    rate = 48_000

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if _BrokenVieneu.error is not None:
            raise _BrokenVieneu.error
        self.sample_rate = _BrokenVieneu.rate


@pytest.fixture
def broken_vieneu(monkeypatch, tmp_path):
    _FakeVieneu.instances = []
    _BrokenVieneu.error = RuntimeError("CUDA error: out of memory")
    _BrokenVieneu.rate = 48_000
    monkeypatch.setitem(sys.modules, "vieneu", types.SimpleNamespace(Vieneu=_BrokenVieneu))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    return tmp_path


@pytest.mark.parametrize("error", [RuntimeError("CUDA error: out of memory"), OSError("no disk")])
def test_load_failure_becomes_tts_unavailable_and_is_latched(broken_vieneu, error):
    _BrokenVieneu.error = error
    provider = VieneuProvider(broken_vieneu, device="cuda")
    with pytest.raises(TTSUnavailable) as first:
        provider.load()
    assert "CUDA error" not in str(first.value) and "no disk" not in str(first.value)
    with pytest.raises(TTSUnavailable):
        provider.synthesize("a", VoiceRef("v", preset="P"), "neutral", 0.0)
    with pytest.raises(TTSUnavailable):
        provider.load()
    assert len(_FakeVieneu.instances) == 1  # the model constructor ran once, not per call
    assert provider.device == "unavailable"


def test_unexpected_sample_rate_is_latched_as_unavailable(broken_vieneu):
    _BrokenVieneu.error = None
    _BrokenVieneu.rate = 24_000
    provider = VieneuProvider(broken_vieneu, device="cpu")
    for _ in range(2):
        with pytest.raises(TTSUnavailable):
            provider.load()
    assert len(_FakeVieneu.instances) == 1 and provider.device == "unavailable"


def test_missing_vieneu_is_latched_too(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "vieneu", None)
    provider = VieneuProvider(tmp_path)
    for _ in range(2):
        with pytest.raises(TTSUnavailable, match="not installed"):
            provider.load()
    assert provider.device == "unavailable"
