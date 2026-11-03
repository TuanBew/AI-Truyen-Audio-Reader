import pytest

from audiotruyen_worker.audio.render import TTSFailing
from audiotruyen_worker.audio_store import AudioRow
from audiotruyen_worker.jobs.handlers import ChapterPreparer
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import (
    JobCancelled,
    JobContext,
    JobSkipped,
    PermanentJobError,
)
from audiotruyen_worker.jobs.synthesize import (
    NO_NARRATOR,
    NO_TEXT,
    STALE_SETTINGS,
    SUPERSEDED,
    audio_prefix,
    make_synthesize_handler,
)
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.storage.guard import UploadBlocked
from audiotruyen_worker.store import ChapterRow
from audiotruyen_worker.text.normalize import LexiconRule
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.fake import FakeTTS
from audiotruyen_worker.tts.vieneu_provider import TTSUnavailable

USER = "11111111-1111-1111-1111-111111111111"
NOVEL = "aaaaaaaa-0000-0000-0000-000000000001"
CHAPTER = "cccccccc-0000-0000-0000-000000000001"
TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần. Gió thổi qua rừng.\n…"
NARRATOR = VoiceRef("dddddddd-0000-0000-0000-000000000001", preset="Đức Trí")


class FakeStore:
    def __init__(self, text=TEXT):
        self.text = text
        self.saved_analysis = None

    def chapter(self, chapter_id, user_id):
        if user_id != USER or chapter_id != CHAPTER:
            return None
        return ChapterRow(CHAPTER, USER, NOVEL, 1, "https://truyenfull.live/a/chuong-1/", None)

    def chapter_text(self, chapter_id):
        return self.text

    def save_chapter_text(self, *args):
        pass

    def analysis(self, *args):
        return None

    def roster(self, novel_id):
        return []

    def save_analysis(self, user_id, chapter_id, digest, strategy, version, segments):
        self.saved_analysis = segments


class FakeAudioStore:
    def __init__(self, status="queued", voice_hash="vh", narrator=NARRATOR, own=True):
        self.status = status
        self.hash = voice_hash
        self.narrator = narrator
        self.own = own
        self.updates: list[dict] = []

    def voice_hash(self, novel_id):
        return self.hash

    def default_narrator(self, user_id):
        return self.narrator

    def begin(self, chapter_id, voice_hash):
        return AudioRow("audio-1", 2, self.status)

    def lexicon(self, user_id, novel_id):
        return [LexiconRule("Lâm Phong", "Lâm Phông")]

    def update(self, row, fields):
        self.updates.append(fields)
        return self.own


class FakeGuarded:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.keys: list[str] = []

    def check_enabled(self):
        if not self.enabled:
            raise UploadBlocked("tắt")

    def put(self, key, data, content_type):
        self.check_enabled()
        self.keys.append(key)
        return len(data)


class RecordingTTS(FakeTTS):
    def __init__(self):
        self.texts: list[str] = []

    def synthesize(self, text, voice, emotion, intensity):
        self.texts.append(text)
        return super().synthesize(text, voice, emotion, intensity)


def job(payload=None):
    return Job("j1", USER, "synthesize", payload or {"chapter_id": CHAPTER, "voice_hash": "vh"})


def handler(store=None, audio=None, storage=None, tts=None):
    store = store or FakeStore()
    return make_synthesize_handler(
        preparer=ChapterPreparer(None, store, [HeuristicStrategy()]),
        store=store,
        audio_store=audio or FakeAudioStore(),
        storage=storage or FakeGuarded(),
        tts=tts or RecordingTTS(),
        baselines=lambda v: 1.0,
    )


def test_synthesizes_all_segments_and_writes_the_ready_row():
    audio, storage, tts = FakeAudioStore(), FakeGuarded(), RecordingTTS()
    result = handler(audio=audio, storage=storage, tts=tts)(job(), JobContext(job()))
    prefix = audio_prefix(NOVEL, CHAPTER, "vh", 2)
    assert storage.keys[0] == prefix + "init.webm" and storage.keys[-1] == prefix + "full.webm"
    assert "lâm phông quát." in tts.texts  # lexicon applied, then vietnormalizer lowercases
    assert all(t for t in tts.texts)  # the punctuation-only "…" paragraph is not spoken
    final = audio.updates[-1]
    assert final["status"] == "ready" and final["provider"] == "fake"
    assert final["full_key"] == prefix + "full.webm"
    assert [s["i"] for s in final["segments"]] == [0, 1, 2]
    assert all(s["voice_id"] == NARRATOR.voice_id for s in final["segments"])
    assert final["segments"][0]["emotion"] == "angry"
    assert all(u["status"] == "partial" for u in audio.updates[:-1])
    assert result == {
        "chapter_audio_id": "audio-1", "attempt": 2, "duration_ms": final["duration_ms"],
        "chunks": len(final["chunks"]), "warnings": 0,
    }  # fmt: skip


def test_partial_updates_carry_timed_segments():
    lines = (
        f"“Ngươi dám!” Lâm Phong quát {n}. Trời tối dần, gió thổi qua rừng." for n in range(14)
    )
    text = chr(10).join(lines)
    audio = FakeAudioStore()
    handler(store=FakeStore(text), audio=audio)(job(), JobContext(job()))
    partials = [u for u in audio.updates if u["status"] == "partial"]
    assert partials
    for update in partials:
        segs = update["segments"]
        indexes = [s["i"] for s in segs]
        assert segs and indexes == sorted(set(indexes))
        assert all(s["start_ms"] < s["end_ms"] for s in segs)
        assert all({"src", "kind", "emotion"} <= s.keys() for s in segs)
        assert all(s["voice_id"] == NARRATOR.voice_id for s in segs)
    sizes = [len(u["segments"]) for u in partials]
    assert sizes == sorted(sizes)
    final = audio.updates[-1]
    assert [s["i"] for s in partials[-1]["segments"]] == [s["i"] for s in final["segments"]][
        : len(partials[-1]["segments"])
    ]


def test_outdated_voice_hash_is_skipped():
    with pytest.raises(JobSkipped, match=STALE_SETTINGS):
        handler(audio=FakeAudioStore(voice_hash="other"))(job(), JobContext(job()))


def test_kill_switch_fails_before_any_audio_row():
    audio = FakeAudioStore()
    with pytest.raises(UploadBlocked):
        handler(audio=audio, storage=FakeGuarded(enabled=False))(job(), JobContext(job()))
    assert audio.updates == []


def test_missing_narrator_is_permanent():
    with pytest.raises(PermanentJobError, match=NO_NARRATOR):
        handler(audio=FakeAudioStore(narrator=None))(job(), JobContext(job()))


def test_ready_row_is_not_synthesized_again():
    tts, audio = RecordingTTS(), FakeAudioStore(status="ready")
    result = handler(audio=audio, tts=tts)(job(), JobContext(job()))
    assert result["already_ready"] is True and tts.texts == []
    assert audio.updates == []


def test_superseded_attempt_is_skipped():
    with pytest.raises(JobSkipped, match=SUPERSEDED):
        handler(audio=FakeAudioStore(own=False))(job(), JobContext(job()))


class FailingUpload(FakeGuarded):
    def put(self, key, data, content_type):
        if key.endswith("full.webm"):
            raise ConnectionError("r2 down")
        return super().put(key, data, content_type)


def test_failure_after_begin_marks_the_row_failed():
    audio = FakeAudioStore()
    with pytest.raises(ConnectionError):
        handler(audio=audio, storage=FailingUpload())(job(), JobContext(job()))
    assert audio.updates[-1] == {"status": "failed"}
    assert audio.updates[0]["status"] == "partial"


@pytest.mark.parametrize(
    "payload",
    [{"chapter_id": CHAPTER}, {"chapter_id": "x", "voice_hash": "vh"},
     {"chapter_id": "dddddddd-0000-0000-0000-000000000009", "voice_hash": "vh"}],
)  # fmt: skip
def test_bad_payloads_are_permanent(payload):
    with pytest.raises(PermanentJobError):
        handler()(job(payload), JobContext(job(payload)))


class FinalWriteLost(FakeAudioStore):
    def update(self, row, fields):
        super().update(row, fields)
        return fields.get("status") != "ready"


def test_lost_fence_on_the_final_write_is_skipped_without_failing_the_row():
    audio = FinalWriteLost()
    with pytest.raises(JobSkipped, match=SUPERSEDED):
        handler(audio=audio)(job(), JobContext(job()))
    assert audio.updates[-1]["status"] == "ready"
    assert not any(u == {"status": "failed"} for u in audio.updates)


def test_lease_lost_mid_render_writes_nothing_more():
    ctx = JobContext(job())

    class CancellingTTS(RecordingTTS):
        def synthesize(self, text, voice, emotion, intensity):
            ctx.cancelled.set()  # the heartbeat thread lost the lease
            return super().synthesize(text, voice, emotion, intensity)

    audio = FakeAudioStore()
    with pytest.raises(JobCancelled):
        handler(audio=audio, tts=CancellingTTS())(job(), ctx)
    assert not any(u.get("status") in ("failed", "ready") for u in audio.updates)


def test_failed_marker_error_does_not_mask_the_original_failure():
    class BrokenFailedWrite(FakeAudioStore):
        def update(self, row, fields):
            if fields.get("status") == "failed":
                raise RuntimeError("supabase down")
            return super().update(row, fields)

    with pytest.raises(ConnectionError, match="r2 down"):
        handler(audio=BrokenFailedWrite(), storage=FailingUpload())(job(), JobContext(job()))


def test_chapter_without_speakable_text_is_permanent_and_marks_the_row_failed():
    audio, tts = FakeAudioStore(), RecordingTTS()
    with pytest.raises(PermanentJobError, match=NO_TEXT):
        handler(store=FakeStore(text="…\n—"), audio=audio, tts=tts)(job(), JobContext(job()))
    assert audio.updates == [{"status": "failed"}] and tts.texts == []


class UnavailableTTS(FakeTTS):
    def synthesize(self, text, voice, emotion, intensity):
        raise TTSUnavailable("vieneu failed to load")


class BrokenTTS(FakeTTS):
    def synthesize(self, text, voice, emotion, intensity):
        raise RuntimeError("cuda oom")


def test_tts_unavailable_fails_the_row_and_never_marks_it_ready():
    audio = FakeAudioStore()
    with pytest.raises(TTSUnavailable):
        handler(audio=audio, tts=UnavailableTTS())(job(), JobContext(job()))
    assert audio.updates[-1] == {"status": "failed"}
    assert not any(u.get("status") == "ready" for u in audio.updates)


def test_a_tts_that_fails_every_segment_fails_the_row_and_never_marks_it_ready():
    audio = FakeAudioStore()
    with pytest.raises(TTSFailing):
        handler(audio=audio, tts=BrokenTTS())(job(), JobContext(job()))
    assert audio.updates[-1] == {"status": "failed"}
    assert not any(u.get("status") == "ready" for u in audio.updates)
