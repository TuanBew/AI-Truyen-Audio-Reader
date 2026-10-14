"""S2: encode audio into standalone WebM/Opus chunks + manifest. THROWAWAY."""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from common import SAMPLE_RATE, utf8_console


def sine(seconds: float, freq: float = 440.0) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def encode(audio: np.ndarray, dst: Path) -> None:
    tmp = dst.with_suffix(".wav")
    sf.write(tmp, audio, SAMPLE_RATE, subtype="FLOAT")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp),
         "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", "-f", "webm", str(dst)],
        check=True,
    )
    tmp.unlink()


def make_set(name: str, audio: np.ndarray, chunk_seconds: float, root: Path) -> None:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    size = int(chunk_seconds * SAMPLE_RATE)
    chunks = []
    for index, start in enumerate(range(0, len(audio), size)):
        part = audio[start : start + size]
        filename = f"chunk-{index:04d}.webm"
        encode(part, folder / filename)
        chunks.append({"url": filename, "samples": len(part), "duration": len(part) / SAMPLE_RATE})
    manifest = {"chunks": chunks, "total": len(audio) / SAMPLE_RATE}
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"{name}: {len(chunks)} chunks, {manifest['total']:.2f}s")


CLUSTER_ID = 0x1F43B675
SEGMENT_ID = 0x18538067
EBML_HEADER_ID = 0x1A45DFA3
TIMESTAMP_ID = 0xE7
# Level-1 (Segment children) IDs: any of these ends an unknown-size Cluster.
LEVEL1_IDS = {
    CLUSTER_ID, 0x1C53BB6B, 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1254C367, 0x1043A770, 0x1941A469,
}


@dataclass
class WebmSegment:
    data: bytes
    timestamp_ms: int


def _vint_len(first: int) -> int:
    for length in range(1, 9):
        if first & (0x80 >> (length - 1)):
            return length
    raise ValueError("invalid EBML vint")


def _read_id(data: bytes, pos: int) -> tuple[int, int]:
    length = _vint_len(data[pos])
    return int.from_bytes(data[pos : pos + length], "big"), pos + length


def _read_size(data: bytes, pos: int) -> tuple[int | None, int]:
    length = _vint_len(data[pos])
    value = int.from_bytes(data[pos : pos + length], "big") & ((1 << (7 * length)) - 1)
    unknown = value == (1 << (7 * length)) - 1
    return (None if unknown else value), pos + length


def _walk_cluster(data: bytes, pos: int, end: int) -> tuple[int, int]:
    """Walk Cluster children from pos; return (cluster_end, timestamp_ms)."""
    timestamp = 0
    while pos < end:
        child_id, after_id = _read_id(data, pos)
        if child_id in LEVEL1_IDS:
            return pos, timestamp
        size, data_start = _read_size(data, after_id)
        if size is None:
            raise ValueError(f"unknown-size child 0x{child_id:X} inside Cluster")
        if child_id == TIMESTAMP_ID:
            timestamp = int.from_bytes(data[data_start : data_start + size], "big")
        pos = data_start + size
    return end, timestamp


def split_webm(data: bytes) -> tuple[bytes, list[WebmSegment]]:
    """Split a WebM stream into init (before first Cluster) + one segment per Cluster."""
    elem_id, pos = _read_id(data, 0)
    if elem_id != EBML_HEADER_ID:
        raise ValueError("not an EBML stream")
    size, pos = _read_size(data, pos)
    pos += size
    elem_id, pos = _read_id(data, pos)
    if elem_id != SEGMENT_ID:
        raise ValueError(f"expected Segment, got 0x{elem_id:X}")
    size, pos = _read_size(data, pos)
    seg_end = len(data) if size is None else min(len(data), pos + size)
    starts: list[tuple[int, int]] = []
    while pos < seg_end:
        child_start = pos
        child_id, after_id = _read_id(data, pos)
        size, data_start = _read_size(data, after_id)
        if child_id == CLUSTER_ID:
            limit = seg_end if size is None else data_start + size
            cluster_end, timestamp = _walk_cluster(data, data_start, limit)
            starts.append((child_start, timestamp))
            pos = cluster_end if size is None else data_start + size
        else:
            if size is None:
                raise ValueError(f"unknown-size Segment child 0x{child_id:X}")
            pos = data_start + size
    if not starts:
        raise ValueError("no Cluster found")
    init = data[: starts[0][0]]
    bounds = [s for s, _ in starts[1:]] + [len(data)]
    segments = [WebmSegment(data[s:e], ts) for (s, ts), e in zip(starts, bounds)]
    assert init + b"".join(seg.data for seg in segments) == data
    return init, segments


def encode_continuous(audio: np.ndarray, chunk_seconds: float) -> bytes:
    """One libopus encode of the whole signal, clusters cut every chunk_seconds."""
    result = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0",
         "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
         "-cluster_time_limit", str(int(chunk_seconds * 1000)), "-cluster_size_limit", "50000000", "pipe:1"],
        input=np.ascontiguousarray(audio, dtype="<f4").tobytes(),
        capture_output=True,
        check=True,
    )
    return result.stdout


def make_continuous_set(name: str, audio: np.ndarray, chunk_seconds: float, root: Path) -> None:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    data = encode_continuous(audio, chunk_seconds)
    init, segments = split_webm(data)
    (folder / "init.webm").write_bytes(init)
    total_samples = len(audio)
    starts = [seg.timestamp_ms * SAMPLE_RATE // 1000 for seg in segments]
    ends = starts[1:] + [total_samples]
    chunks = []
    for index, (seg, start, end) in enumerate(zip(segments, starts, ends)):
        filename = f"seg-{index:04d}.webm"
        (folder / filename).write_bytes(seg.data)
        chunks.append({"url": filename, "samples": end - start, "duration": (end - start) / SAMPLE_RATE})
    manifest = {"init": "init.webm", "chunks": chunks, "total": total_samples / SAMPLE_RATE}
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"{name}: init {len(init)} B + {len(chunks)} segments, {manifest['total']:.2f}s "
          f"(starts ms: {[seg.timestamp_ms for seg in segments]})")


def main() -> None:
    utf8_console()
    parser = argparse.ArgumentParser()
    parser.add_argument("--speech", default="out/s3_gpu.wav")
    args = parser.parse_args()
    root = Path("out/s2")
    make_set("sine", sine(30.0), 10.0, root)
    speech, rate = sf.read(args.speech, dtype="float32")
    if rate != SAMPLE_RATE:
        raise SystemExit(f"{args.speech} is {rate} Hz, expected {SAMPLE_RATE}")
    if speech.ndim > 1:
        speech = speech.mean(axis=1)
    make_set("speech", speech[: 90 * SAMPLE_RATE], 30.0, root)
    make_continuous_set("sine-c", sine(30.0), 10.0, root)
    make_continuous_set("speech-c", speech[: 90 * SAMPLE_RATE], 30.0, root)


if __name__ == "__main__":
    main()
