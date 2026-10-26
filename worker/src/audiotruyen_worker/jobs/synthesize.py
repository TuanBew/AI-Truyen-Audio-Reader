"""synthesize job (spec 5.1, 5.3 step 4, 5.6): one chapter, one voice_hash, one new attempt.
M2b speaks every segment with the default narrator preset; per-speaker voices and emotion refs
come in M4."""

from __future__ import annotations

import logging
from typing import Any

from audiotruyen_worker.audio.render import AttemptSuperseded, ChapterRenderer, SegmentPlan
from audiotruyen_worker.audio_store import AudioStore
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


def audio_prefix(novel_id: str, chapter_id: str, voice_hash: str, attempt: int) -> str:
    return f"audio/{novel_id}/{chapter_id}/{voice_hash}/{attempt}/"


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

        def progress(init_key: str, chunks: list[dict]) -> bool:
            return audio_store.update(
                audio, {"init_key": init_key, "chunks": chunks, "status": "partial"}
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
            audio_store.update(audio, {"status": "failed"})
            raise

        segments = []
        for seg in chapter.analysis:
            if seg["i"] in result.timings:
                start_ms, end_ms = result.timings[seg["i"]]
                segments.append(
                    {**seg, "voice_id": narrator.voice_id, "start_ms": start_ms, "end_ms": end_ms}
                )
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
