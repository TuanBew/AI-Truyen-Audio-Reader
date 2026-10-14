"""S2: encode audio into standalone WebM/Opus chunks + manifest. THROWAWAY."""

from __future__ import annotations

import argparse
import json
import subprocess
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


if __name__ == "__main__":
    main()
