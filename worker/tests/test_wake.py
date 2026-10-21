import asyncio
import logging
import threading
import time

from realtime import RealtimeSubscribeStates

from audiotruyen_worker.jobs import wake as wake_mod
from audiotruyen_worker.jobs.wake import RealtimeWake

KEY = "service-role-secret-value-123"
_real_sleep = asyncio.sleep


def _fake_client(state, listen_seconds, connects):
    """A Realtime client whose socket "drops" after listen_seconds while is_connected stays True,
    like realtime 2.32 with auto_reconnect=False."""

    class _Channel:
        def on_postgres_changes(self, *_args, **_kwargs):
            return self

        async def subscribe(self, callback):
            error = None if state == RealtimeSubscribeStates.SUBSCRIBED else RuntimeError("x")
            callback(state, error)
            return self

    class _Client:
        is_connected = True

        def __init__(self, url, token, auto_reconnect):
            assert token == KEY and auto_reconnect is False
            self._listen_task = None

        async def connect(self):
            connects.append(time.monotonic())
            self._listen_task = asyncio.create_task(_real_sleep(listen_seconds))

        def channel(self, _topic):
            return _Channel()

        async def close(self):
            if self._listen_task:
                self._listen_task.cancel()

    return _Client


def _run(monkeypatch, state, listen_seconds, until):
    connects, sleeps = [], []

    async def fake_sleep(delay):
        sleeps.append(delay)
        await _real_sleep(0.01)

    monkeypatch.setattr(
        wake_mod, "AsyncRealtimeClient", _fake_client(state, listen_seconds, connects)
    )
    monkeypatch.setattr(wake_mod.asyncio, "sleep", fake_sleep)
    wake, stop = threading.Event(), threading.Event()
    # check_seconds is long so a session can only end through the ended event, not polling.
    listener = RealtimeWake("http://x", KEY, wake, stop, check_seconds=10.0, max_backoff=4.0)
    listener.start()
    deadline = time.monotonic() + 5
    while not until(connects) and time.monotonic() < deadline:
        time.sleep(0.01)
    stop.set()
    listener.join(timeout=5)
    assert not listener.is_alive()
    return connects, sleeps, wake


def test_reconnects_after_the_socket_drops_and_resets_backoff(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="audiotruyen_worker.jobs.wake")
    connects, sleeps, wake = _run(
        monkeypatch, RealtimeSubscribeStates.SUBSCRIBED, 0.05, lambda c: len(c) >= 3
    )
    assert len(connects) >= 3
    assert wake.is_set()
    assert sleeps and all(delay == 1.0 for delay in sleeps)  # every session reached SUBSCRIBED
    assert "realtime wake session ended" in caplog.text and KEY not in caplog.text


def test_channel_error_ends_the_session_and_backoff_grows(monkeypatch):
    connects, sleeps, _wake = _run(
        monkeypatch, RealtimeSubscribeStates.CHANNEL_ERROR, 60, lambda c: len(c) >= 4
    )
    assert len(connects) >= 4
    assert sleeps[:4] == [1.0, 2.0, 4.0, 4.0]  # doubles, capped at max_backoff
