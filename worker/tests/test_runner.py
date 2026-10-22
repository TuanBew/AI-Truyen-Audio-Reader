import threading
import time

import pytest

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import (
    SHUTDOWN_MESSAGE,
    JobCancelled,
    JobContext,
    PermanentJobError,
    Runner,
    describe_failure,
)
from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError

USER = "11111111-1111-1111-1111-111111111111"


class FakeQueue:
    worker_id = "w-test"

    def __init__(self, jobs=()):
        self.jobs = list(jobs)
        self.claimed_types: list[list[str]] = []
        self.finished: list[tuple] = []
        self.failed: list[tuple] = []
        self.beats: list[str | None] = []
        self.owned = True

    def claim(self, types):
        self.claimed_types.append(list(types))
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, version, device, job_id):
        self.beats.append(job_id)
        return self.owned

    def finish(self, job_id, status, result=None, error=None):
        self.finished.append((job_id, status, result))
        return True

    def fail(self, job_id, error, retryable):
        self.failed.append((job_id, error, retryable))
        return "queued" if retryable else "failed"


def job(type_="search", payload=None):
    return Job(id="j1", user_id=USER, type=type_, payload=payload or {})


def test_runner_claims_only_handled_types_and_finishes():
    queue = FakeQueue([job()])
    runner = Runner(
        queue,
        {"search": lambda j, c: {"items": []}, "fetch_novel": lambda j, c: None},
        version="v",
        device="cpu",
    )
    assert runner.run_once() is True
    assert queue.claimed_types == [["fetch_novel", "search"]]
    assert queue.finished == [("j1", "done", {"items": []})]
    assert runner.run_once() is False


@pytest.mark.parametrize(
    ("exc", "retryable"),
    [
        (SourceError("HTTP 502"), True),
        (SourceBlocked("challenge"), True),
        (ParserBroken("no #chapter-c"), False),
        (NovelNotFound("x"), False),
        (PermanentJobError("Job thiếu trường 'url'."), False),
        (RuntimeError("bug"), True),
    ],
)
def test_runner_records_failures_with_vietnamese_messages(exc, retryable):
    def boom(j, c):
        raise exc

    queue = FakeQueue([job()])
    Runner(queue, {"search": boom}, version="v", device="cpu").run_once()
    ((job_id, message, was_retryable),) = queue.failed
    assert job_id == "j1" and was_retryable is retryable
    assert message == describe_failure(exc)[0]
    assert "bug" not in message  # raw exception text of unexpected errors stays in the log


def test_lost_lease_cancels_the_running_handler_without_writing():
    queue = FakeQueue([job()])
    started, release = threading.Event(), threading.Event()

    def slow(j, ctx):
        started.set()
        release.wait(5)
        ctx.check()
        return {"never": True}

    runner = Runner(queue, {"search": slow}, version="v", device="cpu")
    worker = threading.Thread(target=runner.run_once)
    worker.start()
    assert started.wait(5)
    queue.owned = False
    runner.beat()
    release.set()
    worker.join(5)
    assert queue.beats == ["j1"]
    assert queue.finished == [] and queue.failed == []


def test_keyboard_interrupt_hands_the_job_back():
    def interrupted(j, c):
        raise KeyboardInterrupt

    queue = FakeQueue([job()])
    with pytest.raises(KeyboardInterrupt):
        Runner(queue, {"search": interrupted}, version="v", device="cpu").run_once()
    assert queue.failed == [("j1", SHUTDOWN_MESSAGE, True)]
    assert SHUTDOWN_MESSAGE == "Worker đã dừng giữa chừng."


def test_heartbeat_without_job_reports_none():
    queue = FakeQueue()
    Runner(queue, {}, version="v", device="cpu").beat()
    assert queue.beats == [None]


def test_context_check_raises_after_cancel():
    ctx = JobContext(job())
    ctx.check()
    ctx.cancelled.set()
    with pytest.raises(JobCancelled):
        ctx.check()


@pytest.mark.parametrize(
    "exc",
    [
        SourceError("HTTP 502 for https://internal.example/zzleak"),
        SourceBlocked("challenge zzleak"),
        ParserBroken("no #chapter-c zzleak"),
        NovelNotFound("zzleak"),
        RuntimeError("[Errno 11001] getaddrinfo failed zzleak"),
    ],
)
def test_failure_messages_never_contain_the_exception_text(exc):
    message, _ = describe_failure(exc)
    assert "zzleak" not in message and str(exc) not in message


def test_stale_heartbeat_does_not_cancel_the_next_job():
    first, second = JobContext(job()), JobContext(Job(id="j2", user_id=USER, type="search"))

    class SwappingQueue(FakeQueue):
        def heartbeat(self, version, device, job_id):
            # While the RPC for j1 is in flight, the main thread finishes j1 and claims j2.
            with runner._lock:
                runner._current = second
            return super().heartbeat(version, device, job_id)

    queue = SwappingQueue()
    queue.owned = False
    runner = Runner(queue, {}, version="v", device="cpu")
    with runner._lock:
        runner._current = first
    runner.beat()
    assert queue.beats == ["j1"]
    assert not second.cancelled.is_set()


def test_keyboard_interrupt_survives_a_failed_hand_back():
    class BrokenQueue(FakeQueue):
        def fail(self, job_id, error, retryable):
            raise RuntimeError("network down")

    def interrupted(j, c):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        Runner(BrokenQueue([job()]), {"search": interrupted}, version="v", device="cpu").run_once()


def test_run_forever_stops_promptly_while_idle():
    # Event.wait with a long timeout is not interruptible by Ctrl+C on Windows; the idle wait
    # must run in short slices so a stop (or Ctrl+C) is seen within about a second.
    queue = FakeQueue()
    runner = Runner(
        queue, {"search": lambda j, c: None}, version="v", device="cpu", poll_seconds=30.0
    )
    stop = threading.Event()
    loop = threading.Thread(target=runner.run_forever, args=(stop,), daemon=True)
    loop.start()
    deadline = time.monotonic() + 5
    while not queue.claimed_types and time.monotonic() < deadline:
        time.sleep(0.01)
    assert queue.claimed_types
    time.sleep(0.2)
    stop.set()
    loop.join(1.5)
    assert not loop.is_alive()


def test_run_forever_wakes_early_and_clears_the_wake():
    queue = FakeQueue()
    runner = Runner(
        queue, {"search": lambda j, c: None}, version="v", device="cpu", poll_seconds=30.0
    )
    stop = threading.Event()
    loop = threading.Thread(target=runner.run_forever, args=(stop,), daemon=True)
    loop.start()
    deadline = time.monotonic() + 5
    while not queue.claimed_types and time.monotonic() < deadline:
        time.sleep(0.01)
    runner.wake.set()
    deadline = time.monotonic() + 1.5
    while len(queue.claimed_types) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(queue.claimed_types) == 2
    time.sleep(0.2)
    assert len(queue.claimed_types) == 2  # the wake was cleared, so the loop is idle again
    assert not runner.wake.is_set()
    stop.set()
    loop.join(1.5)
    assert not loop.is_alive()
