"""Re-measure VieNeu speed on this machine (spec 2.2, 5.6): load time, preset RTF, clone RTF.

Run from worker/ (GPU):  uv run --extra cuda python scripts/bench_tts.py
CPU / ONNX:              uv run --extra cuda python scripts/bench_tts.py --device cpu
RTF = synthesis seconds / audio seconds (< 1 is faster than real time).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from audiotruyen_worker.config import WORKER_ROOT, load_settings
from audiotruyen_worker.sources.truyenfull_parse import parse_chapter_page
from audiotruyen_worker.text.normalize import normalize_for_tts
from audiotruyen_worker.text.segment import segment_text
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.vieneu_provider import VieneuProvider

FIXTURE = WORKER_ROOT / "tests" / "fixtures" / "truyenfull" / "chapter_new_354.html"
REF = WORKER_ROOT.parent / "assets" / "voice-refs" / "m0" / "refs" / "narrator_angry.wav"


def bench(provider: VieneuProvider, texts: list[str], voice: VoiceRef, emotion: str) -> str:
    audio_s, first = 0.0, None
    start = time.perf_counter()
    for text in texts:
        t0 = time.perf_counter()
        audio_s += len(provider.synthesize(text, voice, emotion, 0.5)) / provider.sample_rate
        first = first if first is not None else time.perf_counter() - t0
    elapsed = time.perf_counter() - start
    rtf = elapsed / audio_s
    return f"{len(texts)} segments, {audio_s:.1f} s audio, RTF {rtf:.2f}, first {first:.2f} s"


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--segments", type=int, default=12)
    parser.add_argument("--ref", type=Path, default=REF)
    args = parser.parse_args()
    text = parse_chapter_page(FIXTURE.read_text(encoding="utf-8")).text
    texts = [t for t in (normalize_for_tts(s.text) for s in segment_text(text)) if t]
    texts = texts[: args.segments]
    provider = VieneuProvider(load_settings().models_dir, args.device)
    start = time.perf_counter()
    provider.load()
    print(f"device {provider.device}, load {time.perf_counter() - start:.1f} s")
    print("preset Đức Trí:", bench(provider, texts, VoiceRef("n", preset="Đức Trí"), "neutral"))
    clone = VoiceRef("n", preset="Đức Trí", ref_path=str(args.ref))
    print(f"clone {args.ref.name}:", bench(provider, texts, clone, "angry"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
