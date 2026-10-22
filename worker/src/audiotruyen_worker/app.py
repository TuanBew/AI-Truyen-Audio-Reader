"""`worker run`: wires the job loop, heartbeat and Realtime wake for the M2a job types."""

from __future__ import annotations

import logging
import threading
from importlib.metadata import version

from audiotruyen_worker.config import Settings
from audiotruyen_worker.db import make_client
from audiotruyen_worker.jobs.handlers import make_handlers
from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.runner import Heartbeat, Runner
from audiotruyen_worker.jobs.wake import RealtimeWake
from audiotruyen_worker.sources.truyenfull import TruyenfullAdapter
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.store import Store

log = logging.getLogger(__name__)

WORKER_VERSION = version("audiotruyen-worker")
DEVICE = "cpu"  # M2b reports cuda once VieNeu loads


def build_runner(settings: Settings) -> Runner:
    client = make_client(settings)
    handlers = make_handlers(TruyenfullAdapter(), Store(client), [HeuristicStrategy()])
    return Runner(
        JobQueue(client, settings.worker_id), handlers, version=WORKER_VERSION, device=DEVICE
    )


def run_worker(settings: Settings, *, once: bool = False) -> None:
    """Run until Ctrl+C. With once=True, drain the queue and return (no Realtime, no heartbeat)."""
    runner = build_runner(settings)
    if once:
        runner.beat()
        while runner.run_once():
            pass
        return
    stop = threading.Event()
    key = settings.supabase_service_role_key.get_secret_value()
    Heartbeat(runner, JobQueue(make_client(settings), settings.worker_id), stop).start()
    RealtimeWake(settings.supabase_url, key, runner.wake, stop).start()
    log.info("worker %s %s started (%s)", settings.worker_id, WORKER_VERSION, DEVICE)
    try:
        runner.run_forever(stop)
    finally:
        stop.set()
        log.info("worker stopped")
