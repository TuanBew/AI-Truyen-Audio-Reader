import json
import subprocess
import threading
import time

import numpy as np
import pytest

from audiotruyen_worker.audio.render import (
    AttemptSuperseded,
    ChapterRenderer,
    SegmentPlan,
    TTSFailing,
)
from audiotruyen_worker.jobs.runner import JobCancelled
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.fake import FakeTTS
from audiotruyen_worker.tts.vieneu_provider import TTSUnavailable

NARRATOR = VoiceRef("narrator-id", preset="Đức Trí")
PREFIX = "audio/n/c/h/1"


def plans(count: int, chars: int = 60, voice: VoiceRef = NARRATOR) -> list[SegmentPlan]:
    return [SegmentPlan(i, "x" * chars, voice, "neutral", 0.0, i % 3 == 2) for i in range(count)]


class Recorder:
    def __init__(self, own_until: int | None = None):
        self.uploads: list[tuple[str, bytes, float]] = []
        self.progress: list[list[dict]] = []
        self.timings: list[dict[int, tuple[int, int]]] = []
        self.own_until = own_until
        self.lock = threading.Lock()

    def upload(self, key, data, content_type):
        assert content_type == "audio/webm"
        with self.lock:
            self.uploads.append((key, data, time.perf_counter()))
        return len(data)

    def on_progress(self, init_key, chunks, timings):
        assert init_key == PREFIX + "/init.webm"
        self.progress.append([dict(c) for c in chunks])
        self.timings.append(timings)
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


def test_progress_receives_timings_so_far():
    rec = Recorder()
    result = renderer(rec).render(plans(12))
    assert len(rec.timings) == len(rec.progress) > 1
    sizes = [len(t) for t in rec.timings]
    assert sizes == sorted(sizes) and sizes[0] >= 1
    assert sizes[0] < sizes[-1]  # the first snapshot is demonstrably partial ("so far")
    assert len({id(t) for t in rec.timings}) == len(rec.timings)  # a fresh copy per call
    last = rec.timings[-1]
    assert all(result.timings[i] == span for i, span in last.items())  # subset, equal values
    expected = dict(result.timings)
    for snapshot in rec.timings:  # every snapshot is a copy of the renderer's own dict
        assert snapshot is not result.timings
        snapshot[999] = (0, 1)
        snapshot.clear()
    assert result.timings == expected


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


def test_isolated_failed_segment_becomes_silence_with_a_warning():
    rec = Recorder()
    # fail_times=2: both attempts of segment 0 fail, every other segment is fine (1 of 5 = 20%)
    result = renderer(rec, tts=FlakyTTS(fail_times=2)).render(plans(5))
    assert result.warnings == [{"segment": 0, "code": "tts_failed"}]
    assert result.timings[0] == pytest.approx((0, 500), abs=1)  # 500 ms of silence, not trimmed
    assert result.timings[1][0] == pytest.approx(750, abs=1)  # after the 250 ms pause
    assert all(e > s for s, e in result.timings.values())


class NoisyThenDeadTTS(FakeTTS):
    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        if self.calls > 1:
            raise RuntimeError("cuda oom")
        audio = super().synthesize(text, voice, emotion, intensity)
        rng = np.random.default_rng(0)
        return audio + rng.normal(0, 0.02, audio.shape).astype(np.float32)


def test_failed_retakes_never_replace_an_audible_noisy_take():
    rec = Recorder()
    r = ChapterRenderer(
        NoisyThenDeadTTS(), rec.upload, rec.on_progress, PREFIX, lambda v: 2e-5, NARRATOR
    )
    result = r.render(plans(1))  # 60 chars = 3.3 s of (noisy) speech
    start, end = result.timings[0]
    assert end - start > 3000
    assert result.warnings == [{"segment": 0, "code": "quality_guard_exhausted"}]


def test_warnings_do_not_leak_between_renders():
    tts = FlakyTTS(fail_times=2)
    r = renderer(Recorder(), tts=tts)
    assert len(r.render(plans(5)).warnings) == 1
    tts.fail_times = 2
    assert len(r.render(plans(5)).warnings) == 1


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


def test_upload_error_is_raised_and_stops_everything_after_it():
    rec = Recorder()

    def failing_upload(key, data, content_type):
        if key.endswith("seg-0001.webm"):
            raise ValueError("r2 down")
        return rec.upload(key, data, content_type)

    r = ChapterRenderer(FakeTTS(), failing_upload, rec.on_progress, PREFIX, lambda v: 1.0, NARRATOR)
    with pytest.raises(ValueError, match="r2 down"):
        r.render(plans(30))
    assert [k for k, _, _ in rec.uploads] == [PREFIX + "/init.webm", PREFIX + "/seg-0000.webm"]


def test_cancellation_stops_the_render():
    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if calls["n"] > 3:
            raise JobCancelled("job")

    with pytest.raises(JobCancelled):
        renderer(Recorder(), check=check).render(plans(10))


class UnavailableTTS(FakeTTS):
    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        raise TTSUnavailable("vieneu failed to load")


def test_tts_unavailable_aborts_the_render_and_uploads_no_full_file():
    rec = Recorder()
    tts = UnavailableTTS()
    with pytest.raises(TTSUnavailable):
        renderer(rec, tts=tts).render(plans(6))
    assert tts.calls == 1  # never retried through the fallback chain
    assert PREFIX + "/full.webm" not in [k for k, _, _ in rec.uploads]


class SegmentsFailTTS(FakeTTS):
    """Fails every attempt of the segments whose text starts with 'F'."""

    def synthesize(self, text, voice, emotion, intensity):
        if text.startswith("F"):
            raise RuntimeError("cuda oom")
        return super().synthesize(text, voice, emotion, intensity)


def mixed(pattern: str) -> list[SegmentPlan]:
    return [
        SegmentPlan(i, ("F" if ch == "F" else "x") * 60, NARRATOR, "neutral", 0.0, False)
        for i, ch in enumerate(pattern)
    ]


def test_three_consecutive_total_failures_trip_the_breaker_early():
    rec = Recorder()
    with pytest.raises(TTSFailing):
        renderer(rec, tts=SegmentsFailTTS()).render(mixed("FFF" + "o" * 40))
    assert PREFIX + "/full.webm" not in [k for k, _, _ in rec.uploads]


def test_more_than_a_quarter_failed_segments_fail_the_render_at_the_end():
    rec = Recorder()
    with pytest.raises(TTSFailing):  # 3 of 10 = 30%, never 3 in a row
        renderer(rec, tts=SegmentsFailTTS()).render(mixed("FoFoFooooo"))
    assert PREFIX + "/full.webm" not in [k for k, _, _ in rec.uploads]


def test_a_quarter_or_less_failed_segments_still_render():
    result = renderer(Recorder(), tts=SegmentsFailTTS()).render(mixed("FFoooooo"))
    assert [w["segment"] for w in result.warnings] == [0, 1]  # 2 of 8 = 25%, in a row but < 3


def test_failures_separated_by_audio_do_not_count_as_consecutive():
    result = renderer(Recorder(), tts=SegmentsFailTTS()).render(mixed("FFoFFoFFo" + "o" * 21))
    assert len(result.warnings) == 6  # 6 of 30 = 20%


class SilentTTS(FakeTTS):
    """Non-empty takes that are all silence, then (optionally) a real take."""

    def __init__(self, silent_takes: int):
        self.silent_takes = silent_takes
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        audio = super().synthesize(text, voice, emotion, intensity)
        return audio * 0.0 if self.calls <= self.silent_takes else audio


def test_a_silent_take_counts_as_failed_and_goes_through_the_retry_chain():
    tts = SilentTTS(silent_takes=1)
    result = renderer(Recorder(), tts=tts).render(plans(1))
    assert tts.calls == 2 and result.warnings == [{"segment": 0, "code": "tts_fallback_retry"}]
    start, end = result.timings[0]
    assert end - start > 3000  # the audible retry, not silence


def test_segment_whose_every_take_is_silent_becomes_failed_silence():
    other = VoiceRef("other-id", preset="Thái Sơn")
    tts = SilentTTS(silent_takes=3)  # voice, retry, narrator: all three attempts of segment 0
    result = renderer(Recorder(), tts=tts).render(plans(5, voice=other))
    assert result.warnings == [{"segment": 0, "code": "tts_failed"}]
    assert result.timings[0] == pytest.approx((0, 500), abs=1)


def test_remux_timeout_is_a_clear_error(monkeypatch):
    def hang(*args, **kwargs):
        assert kwargs.get("timeout") == 120
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", hang)
    with pytest.raises(RuntimeError, match="timed out"):
        renderer(Recorder()).render(plans(2))
