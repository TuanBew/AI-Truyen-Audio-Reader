"""S3: VieNeu v3 Turbo performance on this laptop. THROWAWAY."""

from __future__ import annotations

import argparse
import inspect
import json
import platform
import time
from pathlib import Path

import numpy as np

from common import (
    DEFAULT_CHAPTER_URL,
    SAMPLE_RATE,
    deobfuscate,
    fetch_chapter_text,
    split_sentences,
    utf8_console,
)


def cuda_info() -> dict:
    try:
        import torch
    except ImportError:
        return {"torch": None, "cuda": False}
    info = {"torch": torch.__version__, "cuda": torch.cuda.is_available()}
    if info["cuda"]:
        info["device"] = torch.cuda.get_device_name(0)
        info["capability"] = list(torch.cuda.get_device_capability(0))
        torch.cuda.reset_peak_memory_stats()
    return info


def peak_vram_mb() -> float | None:
    try:
        import torch
    except ImportError:
        return None
    if not torch.cuda.is_available():
        return None
    return round(torch.cuda.max_memory_allocated() / 2**20, 1)


def main() -> None:
    utf8_console()
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["auto", "onnx"], default="auto")
    parser.add_argument("--voice", default="Hải Đăng")
    parser.add_argument("--url", default=DEFAULT_CHAPTER_URL)
    parser.add_argument("--max-sentences", type=int, default=40)
    parser.add_argument("--tag", required=True, help="gpu or cpu, used in output file names")
    args = parser.parse_args()

    out_dir = Path("out")
    out_dir.mkdir(exist_ok=True)
    result: dict = {"platform": platform.platform(), "backend_arg": args.backend, **cuda_info()}

    from vieneu import Vieneu

    t0 = time.perf_counter()
    tts = Vieneu() if args.backend == "auto" else Vieneu(backend="onnx")
    result["load_s"] = round(time.perf_counter() - t0, 2)
    result["infer_signature"] = str(inspect.signature(tts.infer))
    result["infer_batch_signature"] = str(inspect.signature(tts.infer_batch))
    result["preset_voices"] = [list(v) for v in tts.list_preset_voices()]

    sentences = split_sentences(deobfuscate(fetch_chapter_text(args.url)))[: args.max_sentences]
    result["sentences"] = len(sentences)
    result["chars"] = sum(len(s) for s in sentences)

    t0 = time.perf_counter()
    tts.infer("Xin chào.", voice=args.voice)
    result["warmup_s"] = round(time.perf_counter() - t0, 2)

    audios: list[np.ndarray] = []
    t0 = time.perf_counter()
    for i, sentence in enumerate(sentences):
        audios.append(np.asarray(tts.infer(sentence, voice=args.voice), dtype=np.float32))
        if i == 0:
            result["first_sentence_s"] = round(time.perf_counter() - t0, 2)
    sequential_s = time.perf_counter() - t0
    audio_s = sum(len(a) for a in audios) / SAMPLE_RATE
    result["audio_s"] = round(audio_s, 1)
    result["sequential_s"] = round(sequential_s, 1)
    result["sequential_rtf"] = round(sequential_s / audio_s, 3)

    t0 = time.perf_counter()
    batch = tts.infer_batch(sentences, voice=args.voice)
    batch_s = time.perf_counter() - t0
    batch_audio_s = sum(len(a) for a in batch) / SAMPLE_RATE
    result["batch_s"] = round(batch_s, 1)
    result["batch_rtf"] = round(batch_s / batch_audio_s, 3)
    result["peak_vram_mb"] = peak_vram_mb()

    wav_path = out_dir / f"s3_{args.tag}.wav"
    tts.save(np.concatenate(audios), str(wav_path))
    (out_dir / f"s3_{args.tag}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "preset_voices"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
