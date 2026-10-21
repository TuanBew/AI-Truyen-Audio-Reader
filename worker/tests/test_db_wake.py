import threading
import time

import pytest

from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.wake import RealtimeWake

pytestmark = pytest.mark.db


def test_enqueue_to_claim_under_two_seconds_with_realtime(admin_client, owner):
    """Perf budget (7.3.2): enqueue -> claim < 2 s while the worker is online."""
    from tests.conftest import SERVICE, URL

    wake, stop = threading.Event(), threading.Event()
    listener = RealtimeWake(URL, SERVICE, wake, stop)
    listener.start()
    try:
        assert listener.subscribed.wait(20), "realtime subscription failed"
        queue = JobQueue(admin_client, "w-latency")
        # Warm-up: right after Realtime starts (fresh `supabase start`) the first changes can be
        # missed; the 30 s poll covers that in production. Wait for one real change event.
        # (SUBSCRIBED itself sets the event, so clear it before every warm-up insert.)
        warmed = False
        deadline = time.monotonic() + 30
        while not warmed and time.monotonic() < deadline:
            wake.clear()
            admin_client.table("jobs").insert(
                {"user_id": owner["id"], "type": "search", "payload": {"query": "warm"}}
            ).execute()
            warmed = wake.wait(3)
        assert warmed, "realtime never delivered a job change"
        while queue.claim(["search"]):
            pass
        for n in range(3):
            wake.clear()
            start = time.perf_counter()
            admin_client.table("jobs").insert(
                {"user_id": owner["id"], "type": "search", "payload": {"query": str(n)}}
            ).execute()
            assert wake.wait(2), "no realtime wake within 2 s"
            claimed = queue.claim(["search"])
            elapsed = time.perf_counter() - start
            assert claimed is not None and elapsed < 2.0, f"enqueue->claim took {elapsed:.2f}s"
    finally:
        stop.set()
