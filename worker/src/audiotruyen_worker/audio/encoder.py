"""Long-lived ffmpeg/libopus encoder (spec 5.6): float32 mono 48 kHz PCM in on stdin, live WebM
out on stdout, split into init + cluster segments as they appear."""

from __future__ import annotations

import queue
import subprocess
import threading
from collections.abc import Iterator

import numpy as np

from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment, WebmSplitter

SAMPLE_RATE = 48_000
CLUSTER_MS = 10_000

FFMPEG_ARGS = [
    "-hide_banner", "-loglevel", "error",
    "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
    "-c:a", "libopus", "-b:a", "48k", "-ar", str(SAMPLE_RATE), "-ac", "1",
    "-f", "webm", "-live", "1",
    "-cluster_time_limit", str(CLUSTER_MS), "-cluster_size_limit", "50000000",
    "-flush_packets", "1", "pipe:1",
]  # fmt: skip

_DONE = object()
_STDERR_TAIL = 8192  # bytes of ffmpeg stderr kept for error messages
_REAP_S = 10.0  # bound on waiting for ffmpeg or its pipe threads to finish


class EncoderError(RuntimeError):
    pass


class StreamEncoder:
    """Start with `start()`, `write(pcm)` segments in order, then `close()`. Finished segments
    are read from `segments()` (blocking iterator, ends after close). Reader threads drain
    stdout and stderr so writes can never deadlock on a full pipe. `kill()` is idempotent and
    safe from any thread; it unblocks a pending `write()`, which then raises EncoderError."""

    def __init__(self, ffmpeg: str = "ffmpeg") -> None:
        self._cmd = [ffmpeg, *FFMPEG_ARGS]
        self._proc: subprocess.Popen[bytes] | None = None
        self._out: queue.Queue[object] = queue.Queue()
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._stderr = bytearray()
        self.samples_written = 0

    def start(self) -> None:
        self._proc = subprocess.Popen(
            self._cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self._reader = threading.Thread(target=self._read, name="encoder-reader", daemon=True)
        self._stderr_reader = threading.Thread(
            target=self._read_stderr, name="encoder-stderr", daemon=True
        )
        self._reader.start()
        self._stderr_reader.start()

    def _read(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        splitter = WebmSplitter()
        try:
            while chunk := self._proc.stdout.read1(65536):
                for segment in splitter.feed(chunk):
                    self._out.put(segment)
            for segment in splitter.finish():
                self._out.put(segment)
        except Exception as exc:  # surfaced to the consumer of segments()
            self._out.put(exc)
            self.kill()  # nobody drains stdout any more; never leave the writer blocked
        finally:
            self._out.put(_DONE)

    def _read_stderr(self) -> None:
        """Keep only a bounded tail of stderr; reading it stops ffmpeg blocking on the pipe."""
        assert self._proc is not None and self._proc.stderr is not None
        try:
            while chunk := self._proc.stderr.read1(65536):
                self._stderr += chunk
                del self._stderr[:-_STDERR_TAIL]
        except (OSError, ValueError):  # pipe closed by kill()
            pass

    def write(self, pcm: np.ndarray) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        data = np.ascontiguousarray(pcm, dtype="<f4").tobytes()
        try:
            self._proc.stdin.write(data)
            self._proc.stdin.flush()
        except (OSError, ValueError) as exc:  # BrokenPipeError, or stdin closed by kill()
            self.kill()
            raise EncoderError(f"ffmpeg stopped: {self._drain_stderr()}") from exc
        self.samples_written += len(pcm)

    def close(self) -> None:
        """Signal end of input. Segments keep arriving until the iterator ends."""
        assert self._proc is not None and self._proc.stdin is not None
        try:
            self._proc.stdin.close()
        except (OSError, ValueError):  # ffmpeg already gone; segments() reports why
            pass

    def kill(self) -> None:
        """Stop ffmpeg, reap it and release its pipes. Idempotent, callable from any thread."""
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:  # exited in the meantime
                pass
        try:
            proc.wait(timeout=_REAP_S)
        except subprocess.TimeoutExpired:
            pass
        self._release()

    def _release(self) -> None:
        """Join the pipe threads (bounded) and close every pipe. ffmpeg must have exited."""
        assert self._proc is not None
        current = threading.current_thread()
        for thread in (self._reader, self._stderr_reader):
            if thread is not None and thread is not current:
                thread.join(_REAP_S)
        for pipe in (self._proc.stdout, self._proc.stderr, self._proc.stdin):
            if pipe is not None:
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass

    def _drain_stderr(self) -> str:
        """Stderr tail, once ffmpeg has exited and the stderr thread has read everything."""
        thread = self._stderr_reader
        if thread is not None and thread is not threading.current_thread():
            thread.join(_REAP_S)
        return bytes(self._stderr).decode("utf-8", "replace").strip()[-500:]

    def segments(self, timeout: float | None = None) -> Iterator[InitSegment | ClusterSegment]:
        """Yields segments until ffmpeg's output ends. Any abnormal exit (error, timeout, or the
        consumer abandoning the iterator) kills ffmpeg; normal completion reaps it."""
        assert self._proc is not None
        completed = False
        try:
            while True:
                try:
                    item = self._out.get(timeout=timeout)
                except queue.Empty:
                    raise EncoderError(f"ffmpeg produced no output for {timeout} s") from None
                if item is _DONE:
                    break
                if isinstance(item, Exception):
                    raise EncoderError(str(item)) from item
                yield item  # type: ignore[misc]
            try:
                code = self._proc.wait(timeout=_REAP_S)
            except subprocess.TimeoutExpired:
                raise EncoderError("ffmpeg did not exit after its output ended") from None
            if code != 0:
                raise EncoderError(f"ffmpeg exited with {code}: {self._drain_stderr()}")
            completed = True
            self._release()
        finally:
            if not completed:
                self.kill()
