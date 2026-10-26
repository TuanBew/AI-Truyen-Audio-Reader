"""`worker run`: wires the job loop, heartbeat, Realtime wake, TTS and R2 for all job types."""

from __future__ import annotations

import logging
import threading
from importlib.metadata import version

from audiotruyen_worker.audio.baselines import Baselines
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.config import Settings
from audiotruyen_worker.db import make_client
from audiotruyen_worker.jobs.cleanup import make_cleanup_handler, run_gc
from audiotruyen_worker.jobs.handlers import ChapterPreparer, make_handlers
from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.runner import Heartbeat, Runner
from audiotruyen_worker.jobs.synthesize import make_synthesize_handler
from audiotruyen_worker.jobs.wake import RealtimeWake
from audiotruyen_worker.sources.truyenfull import TruyenfullAdapter
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.storage.r2 import R2Storage
from audiotruyen_worker.store import Store
from audiotruyen_worker.tts.base import TTSProvider
from audiotruyen_worker.tts.fake import FakeTTS
from audiotruyen_worker.tts.vieneu_provider import VieneuProvider

log = logging.getLogger(__name__)

WORKER_VERSION = version("audiotruyen-worker")


def make_tts(settings: Settings, *, fake: bool) -> TTSProvider:
    return FakeTTS() if fake else VieneuProvider(settings.models_dir, settings.tts_device)


def preload(tts: TTSProvider) -> None:
    """Load VieNeu in the background at start (about 30 s), so the first synthesize job meets
    the first-cluster budget (spec 7.3.2) instead of paying the load."""
    load = getattr(tts, "load", None)
    if load is None:
        return

    def run() -> None:
        try:
            load()
        except Exception:  # the synthesize job reports it to the owner
            log.exception("VieNeu preload failed")

    threading.Thread(target=run, name="tts-preload", daemon=True).start()


def build_runner(settings: Settings, tts: TTSProvider) -> tuple[Runner, AudioStore, R2Storage]:
    client = make_client(settings)
    store = Store(client)
    audio_store = AudioStore(client)
    r2 = R2Storage.from_settings(settings)
    adapter = TruyenfullAdapter()
    strategies = [HeuristicStrategy()]
    guarded = GuardedStorage(
        r2,
        client,
        enabled=settings.r2_uploads_enabled,
        max_bytes=settings.r2_max_bytes,
        max_puts=settings.r2_max_puts_per_month,
    )
    handlers = make_handlers(adapter, store, strategies)
    handlers["synthesize"] = make_synthesize_handler(
        preparer=ChapterPreparer(adapter, store, strategies),
        store=store,
        audio_store=audio_store,
        storage=guarded,
        tts=tts,
        baselines=Baselines(tts),
    )
    handlers["cleanup_r2"] = make_cleanup_handler(audio_store, r2)
    runner = Runner(
        JobQueue(client, settings.worker_id),
        handlers,
        version=WORKER_VERSION,
        device=lambda: tts.device,
    )
    return runner, audio_store, r2


def run_worker(settings: Settings, *, once: bool = False, fake_tts: bool = False) -> None:
    """Run until Ctrl+C. With once=True, drain the queue and return (no Realtime, no heartbeat)."""
    tts = make_tts(settings, fake=fake_tts)
    runner, audio_store, r2 = build_runner(settings, tts)
    if not once:
        preload(tts)  # first, so the GC below never delays the ~30 s model load (spec 7.3.2)
    try:
        run_gc(audio_store, r2)
    except Exception:  # GC is housekeeping; never block the worker on it
        log.exception("audio GC failed")
    if once:
        runner.beat()
        while runner.run_once():
            pass
        return
    stop = threading.Event()
    key = settings.supabase_service_role_key.get_secret_value()
    Heartbeat(runner, JobQueue(make_client(settings), settings.worker_id), stop).start()
    RealtimeWake(settings.supabase_url, key, runner.wake, stop).start()
    log.info("worker %s %s started (tts=%s)", settings.worker_id, WORKER_VERSION, tts.name)
    try:
        runner.run_forever(stop)
    finally:
        stop.set()
        log.info("worker stopped")
