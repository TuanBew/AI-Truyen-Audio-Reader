"""Generate the player test fixture: a 25 s 440 Hz sine run through the production live encoder
and WebM splitter (spec 5.6), written as init.webm, seg-NNNN.webm and manifest.json.

Run from worker/:  uv run python scripts/make_player_fixture.py --out ../web/tests/fixtures/sine-25s
The cluster cut points in manifest.json come from the splitter, never from assumptions.
"""

from __future__ import annotations

import argparse
import json
import shutil
import threading
from pathlib import Path

import numpy as np

from audiotruyen_worker.audio.encoder import SAMPLE_RATE, StreamEncoder
from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment

FREQ_HZ = 440.0
AMPLITUDE = 0.3
DURATION_S = 25
BLOCK = SAMPLE_RATE // 2  # write half a second at a time


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    args = parser.parse_args()

    total = SAMPLE_RATE * DURATION_S
    t = np.arange(total, dtype=np.float64) / SAMPLE_RATE
    pcm = (AMPLITUDE * np.sin(2 * np.pi * FREQ_HZ * t)).astype(np.float32)

    enc = StreamEncoder(args.ffmpeg)
    enc.start()

    def feed() -> None:
        for i in range(0, total, BLOCK):
            enc.write(pcm[i : i + BLOCK])
        enc.close()

    writer = threading.Thread(target=feed, daemon=True)
    writer.start()

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.webm"):
        old.unlink()
    clusters: list[tuple[str, int]] = []
    for seg in enc.segments(timeout=60):
        if isinstance(seg, InitSegment):
            (out / "init.webm").write_bytes(seg.data)
        elif isinstance(seg, ClusterSegment):
            name = f"seg-{seg.index:04d}.webm"
            (out / name).write_bytes(seg.data)
            clusters.append((name, seg.timestamp_ms))
    writer.join()

    duration_ms = round(DURATION_S * 1000)
    chunks = []
    for n, (name, start) in enumerate(clusters):
        end = clusters[n + 1][1] if n + 1 < len(clusters) else duration_ms
        chunks.append({"file": name, "start_ms": start, "end_ms": end})
    (out / "manifest.json").write_text(
        json.dumps({"duration_ms": duration_ms, "chunks": chunks}, indent=2) + "\n"
    )
    print(f"wrote init.webm + {len(chunks)} clusters to {out}: {chunks}")


if __name__ == "__main__":
    main()
