"""synthesize job (spec 5.1, 5.3 step 4, 5.6): one chapter, one voice_hash, one new attempt.
M2b speaks every segment with the default narrator preset; per-speaker voices and emotion refs
come in M4."""

from __future__ import annotations

import logging
from typing import Any

from audiotruyen_worker.audio.render import AttemptSuperseded, ChapterRenderer, SegmentPlan
from audiotruyen_worker.audio_store import AudioRow, AudioStore
from audiotruyen_worker.jobs.handlers import (
    ChapterPreparer,
    owned_chapter,
    payload_str,
    payload_uuid,
)
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobCancelled, JobContext, JobSkipped, PermanentJobError
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.store import Store
from audiotruyen_worker.text.normalize import normalize_for_tts
from audiotruyen_worker.tts.base import TTSProvider

log = logging.getLogger(__name__)

NO_NARRATOR = "Chưa có giọng đọc mặc định. Chạy: uv run worker init-voices"
STALE_SETTINGS = "Cài đặt giọng đọc hoặc từ điển phát âm đã đổi; job này không còn cần chạy."
SUPERSEDED = "Một lượt tạo audio mới hơn đã thay thế lượt này."
NO_TEXT = "Chương không có nội dung để đọc."


def audio_prefix(novel_id: str, chapter_id: str, voice_hash: str, attempt: int) -> str:
    return f"audio/{novel_id}/{chapter_id}/{voice_hash}/{attempt}/"


def timed_segments(
    analysis: list[dict], timings: dict[int, tuple[int, int]], voice_id: str
) -> list[dict]:
    """Analysis entries that have a timing, sorted by i, extended with voice and span. The web
    relies on chapter_audio.segments being sorted by i and holding only timed segments."""
    return [
        {
            **seg,
            "voice_id": voice_id,
            "start_ms": timings[seg["i"]][0],
            "end_ms": timings[seg["i"]][1],
        }
        for seg in sorted(analysis, key=lambda seg: seg["i"])
        if seg["i"] in timings
    ]


def _mark_failed(audio_store: AudioStore, audio: AudioRow) -> None:
    """Best effort: a failure here must never mask the error that is being handled."""
    try:
        audio_store.update(audio, {"status": "failed"})
    except Exception:
        log.exception("could not mark chapter_audio %s failed", audio.id)


def make_synthesize_handler(
    *,
    preparer: ChapterPreparer,
    store: Store,
    audio_store: AudioStore,
    storage: GuardedStorage,
    tts: TTSProvider,
    baselines,
    ffmpeg: str = "ffmpeg",
):
    def synthesize(job: Job, ctx: JobContext) -> dict[str, Any]:
        row = owned_chapter(store, job, payload_uuid(job, "chapter_id"))
        voice_hash = payload_str(job, "voice_hash", 64)
        if audio_store.voice_hash(row.novel_id) != voice_hash:
            raise JobSkipped(STALE_SETTINGS)
        storage.check_enabled()  # kill switch: fail before any work, nothing uploaded
        narrator = audio_store.default_narrator(job.user_id)
        if narrator is None:
            raise PermanentJobError(NO_NARRATOR)
        chapter = preparer.prepare(job, row, ctx, refetch=False)
        audio = audio_store.begin(row.id, voice_hash)
        if audio.status == "ready":
            return {"chapter_audio_id": audio.id, "attempt": audio.attempt, "already_ready": True}

        rules = audio_store.lexicon(job.user_id, row.novel_id)
        plans = []
        for seg in chapter.analysis:
            start, end = seg["src"]
            text = normalize_for_tts(chapter.text[start:end], rules)
            if text:
                plans.append(
                    SegmentPlan(
                        seg["i"], text, narrator, seg["emotion"], seg["intensity"], seg["pe"]
                    )
                )

        if not plans:
            _mark_failed(audio_store, audio)
            raise PermanentJobError(NO_TEXT)

        def progress(
            init_key: str | None, chunks: list[dict], timings: dict[int, tuple[int, int]]
        ) -> bool:
            segments = timed_segments(chapter.analysis, timings, narrator.voice_id)
            return audio_store.update(
                audio,
                {"init_key": init_key, "chunks": chunks, "status": "partial", "segments": segments},
            )

        renderer = ChapterRenderer(
            tts,
            storage.put,
            progress,
            audio_prefix(row.novel_id, row.id, voice_hash, audio.attempt),
            baselines,
            narrator,
            check=ctx.check,
            ffmpeg=ffmpeg,
        )
        try:
            result = renderer.render(plans)
        except AttemptSuperseded as exc:
            raise JobSkipped(SUPERSEDED) from exc
        except JobCancelled:
            raise  # lease lost: the next attempt takes over; write nothing
        except Exception:
            _mark_failed(audio_store, audio)
            raise

        segments = timed_segments(chapter.analysis, result.timings, narrator.voice_id)
        final = {
            "status": "ready",
            "provider": tts.name,
            "init_key": result.init_key,
            "chunks": result.chunks,
            "full_key": result.full_key,
            "duration_ms": result.duration_ms,
            "segments": segments,
            "warnings": result.warnings,
        }
        if not audio_store.update(audio, final):
            raise JobSkipped(SUPERSEDED)
        log.info(
            "chapter %s attempt %d ready: %d ms, %d clusters, %d warnings",
            row.id, audio.attempt, result.duration_ms, len(result.chunks), len(result.warnings),
        )  # fmt: skip
        return {
            "chapter_audio_id": audio.id,
            "attempt": audio.attempt,
            "duration_ms": result.duration_ms,
            "chunks": len(result.chunks),
            "warnings": len(result.warnings),
        }

    return synthesize
