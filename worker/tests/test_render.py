import json
import subprocess
import threading
import time

import numpy as np
import pytest

from audiotruyen_worker.audio.render import AttemptSuperseded, ChapterRenderer, SegmentPlan
from audiotruyen_worker.jobs.runner import JobCancelled
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.fake import FakeTTS

NARRATOR = VoiceRef("narrator-id", preset="Đức Trí")
PREFIX = "audio/n/c/h/1"


def plans(count: int, chars: int = 60, voice: VoiceRef = NARRATOR) -> list[SegmentPlan]:
    return [SegmentPlan(i, "x" * chars, voice, "neutral", 0.0, i % 3 == 2) for i in range(count)]


class Recorder:
    def __init__(self, own_until: int | None = None):
        self.uploads: list[tuple[str, bytes, float]] = []
        self.progress: list[list[dict]] = []
        self.own_until = own_until
        self.lock = threading.Lock()

    def upload(self, key, data, content_type):
        assert content_type == "audio/webm"
        with self.lock:
            self.uploads.append((key, data, time.perf_counter()))
        return len(data)

    def on_progress(self, init_key, chunks):
        assert init_key == PREFIX + "/init.webm"
        self.progress.append([dict(c) for c in chunks])
        return self.own_until is None or len(chunks) <= self.own_until


def renderer(rec: Recorder, tts=None, check=lambda: None) -> ChapterRenderer:
    return ChapterRenderer(
        tts or FakeTTS(), rec.upload, rec.on_progress, PREFIX, lambda v: 1.0, NARRATOR, check=check
    )


def test_render_uploads_init_clusters_and_seekable_full_file(tmp_path):
    rec = Recorder()
    result = renderer(rec).render(plans(12))  # 12 x 3.3 s speech + pauses ~ 43 s
    keys = [k for k, _, _ in rec.uploads]
    assert keys[0] == PREFIX + "/init.webm" and keys[-1] == PREFIX + "/full.webm"
    assert keys[1:-1] == [f"{PREFIX}/seg-{i:04d}.webm" for i in range(len(result.chunks))]
    assert len(result.chunks) == 5
    chunks = result.chunks
    assert chunks[0]["start_ms"] == 0 and chunks[-1]["end_ms"] == result.duration_ms
    assert all(a["end_ms"] == b["start_ms"] for a, b in zip(chunks, chunks[1:], strict=False))
    timings = [result.timings[i] for i in range(12)]
    assert all(s < e for s, e in timings)
    assert all(a[1] < b[0] for a, b in zip(timings, timings[1:], strict=False))  # pauses between
    assert rec.progress[-1][-1]["end_ms"] is None  # last chunk's end known only at completion
    full = rec.uploads[-1][1]
    (tmp_path / "full.webm").write_bytes(full)
    fmt = json.loads(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
             str(tmp_path / "full.webm")],
            capture_output=True, text=True, check=True,
        ).stdout
    )["format"]  # fmt: skip
    assert float(fmt["duration"]) == pytest.approx(result.duration_ms / 1000, abs=0.05)
    assert b"\x1c\x53\xbb\x6b" in full  # Cues: seekable


class SlowTTS(FakeTTS):
    def synthesize(self, text, voice, emotion, intensity):
        time.sleep(0.05)
        return super().synthesize(text, voice, emotion, intensity)


def test_pipelined_first_cluster_uploads_before_synthesis_ends():
    rec = Recorder()
    start = time.perf_counter()
    renderer(rec, tts=SlowTTS()).render(plans(20))
    first_cluster = next(t for k, _, t in rec.uploads if k.endswith("seg-0000.webm"))
    assert first_cluster - start < 0.5 * (rec.uploads[-1][2] - start)


class FlakyTTS(FakeTTS):
    def __init__(self, fail_times: int):
        self.fail_times = fail_times
        self.voices: list[str] = []

    def synthesize(self, text, voice, emotion, intensity):
        self.voices.append(voice.voice_id)
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("cuda oom")
        return super().synthesize(text, voice, emotion, intensity)


def test_failed_segment_retries_then_falls_back_to_the_narrator():
    other = VoiceRef("male-id", preset="Thái Sơn")
    rec = Recorder()
    tts = FlakyTTS(fail_times=2)
    result = renderer(rec, tts=tts).render(plans(1, voice=other))
    assert tts.voices[:3] == ["male-id", "male-id", "narrator-id"]
    assert result.warnings == [{"segment": 0, "code": "tts_fallback_narrator"}]


def test_segment_that_always_fails_becomes_silence_with_a_warning():
    rec = Recorder()
    result = renderer(rec, tts=FlakyTTS(fail_times=99)).render(plans(2))
    assert {"segment": 0, "code": "tts_failed"} in result.warnings
    assert result.duration_ms > 0


class NoisyThenCleanTTS(FakeTTS):
    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        audio = super().synthesize(text, voice, emotion, intensity)
        if self.calls == 1:
            rng = np.random.default_rng(0)
            audio = audio + rng.normal(0, 0.02, audio.shape).astype(np.float32)
        return audio


def test_quality_guard_resynthesizes_a_noisy_take():
    rec = Recorder()
    tts = NoisyThenCleanTTS()
    r = ChapterRenderer(tts, rec.upload, rec.on_progress, PREFIX, lambda v: 2e-5, NARRATOR)
    result = r.render(plans(1))
    assert tts.calls == 2 and result.warnings == []


def test_superseded_attempt_stops_uploading():
    rec = Recorder(own_until=1)
    with pytest.raises(AttemptSuperseded):
        renderer(rec).render(plans(30))
    keys = [k for k, _, _ in rec.uploads]
    assert PREFIX + "/full.webm" not in keys
    assert len([k for k in keys if "/seg-" in k]) <= 3  # stops right after the fence trips


def test_cancellation_stops_the_render():
    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if calls["n"] > 3:
            raise JobCancelled("job")

    with pytest.raises(JobCancelled):
        renderer(Recorder(), check=check).render(plans(10))
