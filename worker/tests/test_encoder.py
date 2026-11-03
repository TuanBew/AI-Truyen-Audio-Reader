import json
import subprocess
import sys
import threading
import time

import numpy as np
import pytest

from audiotruyen_worker.audio.encoder import EncoderError, StreamEncoder
from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment


def sine(seconds: float) -> np.ndarray:
    n = int(seconds * 48_000)
    return (0.3 * np.sin(2 * np.pi * 440 * np.arange(n) / 48_000)).astype(np.float32)


def test_segments_arrive_while_writing_and_decode_to_every_sample(tmp_path):
    encoder = StreamEncoder()
    encoder.start()
    seen: list = []
    fed_at_emit: list[int] = []

    def consume() -> None:
        for segment in encoder.segments(timeout=30):
            seen.append(segment)
            fed_at_emit.append(encoder.samples_written)

    reader = threading.Thread(target=consume)
    reader.start()
    for _ in range(13):  # 26 s in 2 s pieces
        encoder.write(sine(2.0))
    encoder.close()
    reader.join(30)

    assert isinstance(seen[0], InitSegment)
    clusters = [s for s in seen if isinstance(s, ClusterSegment)]
    stamps = [c.timestamp_ms for c in clusters]
    assert len(stamps) == 3 and stamps[0] == 0
    assert all(0 <= 10_000 * k - ts < 50 for k, ts in enumerate(stamps))  # cut ~19 ms early
    assert fed_at_emit[1] < encoder.samples_written  # cluster 0 left before input ended
    data = b"".join(s.data for s in seen)
    (tmp_path / "concat.webm").write_bytes(data)
    decoded = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(tmp_path / "concat.webm"),
         "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    assert len(decoded) // 4 == encoder.samples_written == 26 * 48_000
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
         str(tmp_path / "concat.webm")],
        capture_output=True, text=True, check=True,
    ).stdout  # fmt: skip
    assert "duration" not in json.loads(probe)["format"]  # live output: no Duration


def test_broken_ffmpeg_raises_instead_of_hanging():
    encoder = StreamEncoder(ffmpeg="ffmpeg")
    encoder._cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "nope", "-i", "pipe:0"]
    encoder.start()
    with pytest.raises(EncoderError):
        for _ in range(50):
            encoder.write(sine(1.0))
        encoder.close()
        list(encoder.segments(timeout=30))


def _stub(code: str) -> list[str]:
    return [sys.executable, "-c", code]


def _write_in_thread(encoder: StreamEncoder, seconds: float) -> tuple[threading.Thread, list]:
    errors: list = []

    def run() -> None:
        try:
            encoder.write(sine(seconds))
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, errors


def test_stderr_flood_does_not_block_writes(tmp_path):
    webm = tmp_path / "ref.webm"
    encoder_ref = StreamEncoder()
    encoder_ref.start()
    encoder_ref.write(sine(12.0))
    encoder_ref.close()
    ref = list(encoder_ref.segments(timeout=30))
    webm.write_bytes(b"".join(s.data for s in ref))
    # Floods stderr (far beyond a pipe buffer) before reading any stdin, like a chatty ffmpeg.
    encoder = StreamEncoder()
    encoder._cmd = _stub(
        "import sys; sys.stderr.write('x' * 200_000); sys.stderr.flush();"
        "sys.stdin.buffer.read(); sys.stdout.buffer.write(open(sys.argv[1], 'rb').read());"
        "sys.stderr.write('TAIL-MARKER'); sys.exit(3)"
    ) + [str(webm)]
    encoder.start()
    writer, errors = _write_in_thread(encoder, 10.0)  # 1.9 MB, far more than a pipe buffer
    writer.join(20)
    assert not writer.is_alive() and errors == []
    encoder.close()
    got: list = []
    with pytest.raises(EncoderError, match="exited with 3: x*TAIL-MARKER$") as info:
        for segment in encoder.segments(timeout=30):
            got.append(segment)
    assert [s.data for s in got] == [s.data for s in ref]
    assert len(str(info.value)) < 600  # bounded stderr tail


def test_segments_timeout_raises_encoder_error_and_reaps():
    encoder = StreamEncoder()
    encoder._cmd = _stub("import time; time.sleep(60)")
    encoder.start()
    with pytest.raises(EncoderError, match="no output for 0.5 s"):
        list(encoder.segments(timeout=0.5))
    assert encoder._proc.returncode is not None
    assert encoder._proc.stdin.closed and encoder._proc.stdout.closed
    assert encoder._proc.stderr.closed


def test_abandoned_segments_iterator_kills_ffmpeg():
    encoder = StreamEncoder()
    encoder.start()
    encoder.write(sine(12.0))
    segments = encoder.segments(timeout=30)
    assert isinstance(next(segments), InitSegment)
    assert encoder._proc.poll() is None
    segments.close()  # consumer stopped iterating
    assert encoder._proc.returncode is not None
    with pytest.raises(EncoderError):
        encoder.write(sine(1.0))


def test_kill_unblocks_a_write_stuck_on_a_full_pipe():
    encoder = StreamEncoder()
    encoder._cmd = _stub("import time; time.sleep(60)")  # never reads stdin
    encoder.start()
    writer, errors = _write_in_thread(encoder, 10.0)
    time.sleep(0.5)
    assert writer.is_alive()  # blocked inside write()
    encoder.kill()
    encoder.kill()  # idempotent
    writer.join(10)
    assert not writer.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], EncoderError)
    assert encoder._proc.returncode is not None
