"""Realtime wake-up (spec 5.1, 7.3.2): a background thread subscribes to queued-job inserts and
updates and sets an Event, so the loop claims within ~1 s instead of waiting for the 30 s poll.
Reconnects with backoff forever; polling keeps working while it is down."""

from __future__ import annotations

import asyncio
import logging
import threading

from realtime import AsyncRealtimeClient, RealtimeSubscribeStates

log = logging.getLogger(__name__)


class RealtimeWake(threading.Thread):
    def __init__(
        self,
        supabase_url: str,
        api_key: str,
        wake: threading.Event,
        stop: threading.Event,
        *,
        check_seconds: float = 5.0,
        max_backoff: float = 60.0,
    ) -> None:
        super().__init__(name="realtime-wake", daemon=True)
        self._url = supabase_url.rstrip("/") + "/realtime/v1"
        self._key = api_key
        self.wake = wake
        self.stop = stop
        self.subscribed = threading.Event()
        self._check_seconds = check_seconds
        self._max_backoff = max_backoff

    def run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        backoff = 1.0
        while not self.stop.is_set():
            try:
                await self._session()
                backoff = 1.0
            except Exception as exc:  # network or server error: retry with backoff
                log.warning(
                    "realtime wake disconnected (%s); polling continues", type(exc).__name__
                )
            self.subscribed.clear()
            if self.stop.wait(0):
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff)

    async def _session(self) -> None:
        client = AsyncRealtimeClient(self._url, token=self._key, auto_reconnect=False)
        try:
            await client.connect()
            channel = client.channel("worker-jobs")
            on_change = lambda _payload: self.wake.set()  # noqa: E731
            channel.on_postgres_changes("INSERT", on_change, table="jobs", schema="public")
            channel.on_postgres_changes(
                "UPDATE", on_change, table="jobs", schema="public", filter="status=eq.queued"
            )

            def on_state(state: RealtimeSubscribeStates, error: Exception | None) -> None:
                if state == RealtimeSubscribeStates.SUBSCRIBED:
                    self.subscribed.set()
                    self.wake.set()  # catch anything queued while we were disconnected
                    log.info("realtime wake subscribed")
                elif error is not None:
                    log.warning("realtime wake state %s: %s", state.value, type(error).__name__)

            await channel.subscribe(on_state)
            while not self.stop.is_set() and client.is_connected:
                await asyncio.sleep(self._check_seconds)
        finally:
            try:
                await client.close()
            except Exception:  # closing a dead socket may fail; nothing to clean up
                pass
