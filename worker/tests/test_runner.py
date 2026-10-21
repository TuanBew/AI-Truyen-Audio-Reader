import threading

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
