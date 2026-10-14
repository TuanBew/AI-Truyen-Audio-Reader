"""S1-A: neutral base clips of three VieNeu presets (timbre source for VoxCPM2). THROWAWAY."""

from __future__ import annotations

import argparse
from pathlib import Path

from common import utf8_console

BASE_TEXT = "Con đường mòn dẫn lên núi phủ đầy lá vàng, gió chiều thổi qua từng rặng tre xào xạc."


def main() -> None:
    utf8_console()
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["auto", "onnx"], default="auto")
    parser.add_argument("--narrator", default="Hải Đăng")
    parser.add_argument("--male", default="Thiện Minh")
    parser.add_argument("--female", default="Ngọc Huyền")
    args = parser.parse_args()

    from vieneu import Vieneu

    tts = Vieneu() if args.backend == "auto" else Vieneu(backend="onnx")
    labels = {label for label, _ in tts.list_preset_voices()} | {vid for _, vid in tts.list_preset_voices()}
    roles = {"narrator": args.narrator, "male": args.male, "female": args.female}
    missing = [name for name in roles.values() if name not in labels]
    if missing:
        raise SystemExit(f"Unknown preset voice(s): {missing}. Available: {sorted(labels)}")

    out = Path("out/s1/base")
    out.mkdir(parents=True, exist_ok=True)
    for role, voice in roles.items():
        audio = tts.infer(BASE_TEXT, voice=voice)
        tts.save(audio, str(out / f"{role}.wav"))
        print(f"{role}: {voice} -> {out / f'{role}.wav'}")


if __name__ == "__main__":
    main()
