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


class EncoderError(RuntimeError):
    pass


class StreamEncoder:
    """Start with `start()`, `write(pcm)` segments in order, then `close()`. Finished segments
    are read from `segments()` (blocking iterator, ends after close). A reader thread drains
    stdout so writes can never deadlock on a full pipe."""

    def __init__(self, ffmpeg: str = "ffmpeg") -> None:
        self._cmd = [ffmpeg, *FFMPEG_ARGS]
        self._proc: subprocess.Popen[bytes] | None = None
        self._out: queue.Queue[object] = queue.Queue()
        self._reader: threading.Thread | None = None
        self._stderr = b""
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
        self._reader.start()

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

    def write(self, pcm: np.ndarray) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        data = np.ascontiguousarray(pcm, dtype="<f4").tobytes()
        try:
            self._proc.stdin.write(data)
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise EncoderError(f"ffmpeg stopped: {self._drain_stderr()}") from exc
        self.samples_written += len(pcm)

    def close(self) -> None:
        """Signal end of input. Segments keep arriving until the iterator ends."""
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.close()

    def kill(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.kill()

    def _drain_stderr(self) -> str:
        if self._proc and self._proc.stderr and not self._stderr:
            try:
                self._stderr = self._proc.stderr.read() or b""
            except (OSError, ValueError):
                pass
        return self._stderr.decode("utf-8", "replace").strip()[-500:]

    def segments(self, timeout: float | None = None) -> Iterator[InitSegment | ClusterSegment]:
        while True:
            item = self._out.get(timeout=timeout)
            if item is _DONE:
                break
            if isinstance(item, Exception):
                raise EncoderError(str(item)) from item
            yield item  # type: ignore[misc]
        assert self._proc is not None
        code = self._proc.wait()
        if code != 0:
            raise EncoderError(f"ffmpeg exited with {code}: {self._drain_stderr()}")
