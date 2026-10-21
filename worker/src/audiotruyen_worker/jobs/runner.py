"""Job loop (spec 5.1): one job at a time, Realtime wake with polling fallback, heartbeat thread
that extends the lease and cancels the running handler when the lease is lost."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError

log = logging.getLogger(__name__)


SHUTDOWN_MESSAGE = "Worker đã dừng giữa chừng; job sẽ được chạy lại."


class JobCancelled(Exception):
    """Raised by JobContext.check() when the job must stop (lease lost or shutdown)."""


class PermanentJobError(Exception):
    """A failure that retrying cannot fix. The message is shown to the owner (Vietnamese)."""


@dataclass
class JobContext:
    job: Job
    cancelled: threading.Event = field(default_factory=threading.Event)

    def check(self) -> None:
        if self.cancelled.is_set():
            raise JobCancelled(self.job.id)


Handler = Callable[[Job, JobContext], Mapping[str, Any] | None]


class Queue(Protocol):
    worker_id: str

    def claim(self, types: list[str]) -> Job | None: ...
    def heartbeat(self, version: str, device: str, job_id: str | None) -> bool: ...
    def finish(
        self, job_id: str, status: str, result: dict | None = None, error: str | None = None
    ) -> bool: ...
    def fail(self, job_id: str, error: str, retryable: bool) -> str | None: ...


def describe_failure(exc: BaseException) -> tuple[str, bool]:
    """(Vietnamese message for the owner, retryable)."""
    if isinstance(exc, PermanentJobError):
        return str(exc), False
    if isinstance(exc, NovelNotFound):
        return "Không tìm thấy truyện trên truyenfull (truyện có thể đã bị gỡ).", False
    if isinstance(exc, ParserBroken):
        return (
            "Không đọc được trang truyenfull, có thể trang đã đổi cấu trúc. "
            "Xem worker/logs/worker.log.",
            False,
        )
    if isinstance(exc, SourceBlocked):
        return (
            "Truyenfull đang chặn truy cập tự động (Cloudflare) cho trang này. "
            "Worker sẽ thử lại sau.",
            True,
        )
    if isinstance(exc, SourceError):
        return "Không tải được trang truyenfull. Worker sẽ thử lại sau.", True
    return (
        f"Lỗi không mong muốn trong worker ({type(exc).__name__}). Xem worker/logs/worker.log.",
        True,
    )


class Runner:
    def __init__(
        self,
        queue: Queue,
        handlers: Mapping[str, Handler],
        *,
        version: str,
        device: str,
        wake: threading.Event | None = None,
        poll_seconds: float = 30.0,
    ) -> None:
        self.queue = queue
        self.handlers = dict(handlers)
        self.version = version
        self.device = device
        self.wake = wake or threading.Event()
        self.poll_seconds = poll_seconds
        self._current: JobContext | None = None
        self._lock = threading.Lock()

    @property
    def current_job_id(self) -> str | None:
        with self._lock:
            return self._current.job.id if self._current else None

    def run_once(self) -> bool:
        """Claim and run one job. Returns False when the queue had nothing for us."""
        job = self.queue.claim(sorted(self.handlers))
        if job is None:
            return False
        ctx = JobContext(job)
        with self._lock:
            self._current = ctx
        try:
            self._execute(job, ctx)
        finally:
            with self._lock:
                self._current = None
        return True

    def _execute(self, job: Job, ctx: JobContext) -> None:
        log.info(
            "job %s %s started (attempt %d/%d)", job.id, job.type, job.attempts, job.max_attempts
        )
        try:
            result = self.handlers[job.type](job, ctx)
        except JobCancelled:
            log.warning("job %s stopped: lease lost", job.id)
            return  # the job was requeued by requeue_expired_jobs; nothing to write
        except KeyboardInterrupt:
            # Ctrl+C: hand the job back now instead of waiting for its lease to expire.
            try:
                self.queue.fail(job.id, SHUTDOWN_MESSAGE, True)
            except Exception:  # the lease expiry requeues it; never swallow the Ctrl+C
                log.exception("could not hand job %s back", job.id)
            raise
        except Exception as exc:  # every failure is recorded on the job row
            message, retryable = describe_failure(exc)
            log.exception("job %s failed (retryable=%s)", job.id, retryable)
            status = self.queue.fail(job.id, message, retryable)
            log.info("job %s -> %s", job.id, status)
            return
        if not self.queue.finish(job.id, "done", dict(result) if result else None):
            log.warning("job %s finished but the lease was already lost", job.id)
        else:
            log.info("job %s done", job.id)

    def cancel_current(self, job_id: str) -> None:
        """Cancel the running job only if it is still job_id (a stale heartbeat must not
        cancel the job claimed after it)."""
        with self._lock:
            if self._current is not None and self._current.job.id == job_id:
                self._current.cancelled.set()

    def beat(self, queue: Queue | None = None) -> None:
        """One heartbeat (from the heartbeat thread, with its own client). Cancels the running
        job when its lease was lost."""
        job_id = self.current_job_id
        owned = (queue or self.queue).heartbeat(self.version, self.device, job_id)
        if job_id and not owned:
            log.warning("lease lost for job %s; stopping it", job_id)
            self.cancel_current(job_id)

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                ran = self.run_once()
            except Exception:  # network blip talking to Supabase: back off, keep the loop alive
                log.exception("job loop error")
                ran = False
                stop.wait(5)
            if not ran:
                self.wake.wait(self.poll_seconds)
                self.wake.clear()


class Heartbeat(threading.Thread):
    def __init__(
        self, runner: Runner, queue: Queue, stop: threading.Event, interval: float = 15.0
    ) -> None:
        super().__init__(name="heartbeat", daemon=True)
        self.runner = runner
        self.queue = queue
        self.stop = stop
        self.interval = interval

    def run(self) -> None:
        while True:
            try:
                self.runner.beat(self.queue)
            except Exception:  # keep beating; the next beat may succeed
                log.exception("heartbeat failed")
            if self.stop.wait(self.interval):
                return
