"""cleanup_r2 jobs and audio GC (spec 4.2, 7.3.1): delete ledger keys from R2, then mark them."""

from __future__ import annotations

import logging
import re
from typing import Any

from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.jobs.handlers import payload_str
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobContext, PermanentJobError

log = logging.getLogger(__name__)

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CLEANUP_PREFIX = re.compile(rf"^(audio/{_UUID}/({_UUID}/)?|voices/{_UUID}/)$")
MAX_GC_ROUNDS = 100


def make_cleanup_handler(audio_store: AudioStore, storage):
    def cleanup_r2(job: Job, ctx: JobContext) -> dict[str, Any]:
        prefix = payload_str(job, "prefix", 200)
        if not CLEANUP_PREFIX.match(prefix):
            raise PermanentJobError("Job dọn R2 có prefix không hợp lệ.")
        deleted, after = 0, ""
        while keys := audio_store.live_keys(prefix, after):
            storage.delete_many(keys)
            deleted += audio_store.mark_deleted(keys)
            after = keys[-1]
            ctx.check()
        return {"prefix": prefix, "deleted": deleted}

    return cleanup_r2


def run_gc(audio_store: AudioStore, storage) -> dict[str, int]:
    """Delete abandoned attempts and stale voice_hash audio, then drop the stale rows.

    Rows are dropped only when the candidates ran out. If MAX_GC_ROUNDS ended the loop first,
    a stale row may still own live keys; dropping it would make them unreachable for both GC
    and the cleanup triggers, so nothing is dropped and the next run continues.
    """
    deleted, stale_rows, exhausted = 0, set(), False
    for _ in range(MAX_GC_ROUNDS):
        candidates = audio_store.gc_candidates()
        if not candidates:
            exhausted = True
            break
        keys = [c.key for c in candidates]
        storage.delete_many(keys)
        deleted += audio_store.mark_deleted(keys)
        stale_rows.update(c.chapter_audio_id for c in candidates if c.stale)
    if not exhausted:
        log.warning(
            "audio GC stopped early after %d rounds; no rows dropped, %d objects deleted",
            MAX_GC_ROUNDS,
            deleted,
        )
        return {"deleted": deleted, "stale_rows": 0}
    audio_store.delete_audio_rows(sorted(stale_rows))
    if deleted or stale_rows:
        log.info("audio GC: %d objects deleted, %d stale rows dropped", deleted, len(stale_rows))
    return {"deleted": deleted, "stale_rows": len(stale_rows)}
