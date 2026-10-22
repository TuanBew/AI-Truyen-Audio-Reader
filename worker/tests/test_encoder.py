import json
import subprocess
import threading

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
