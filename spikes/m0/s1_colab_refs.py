"""S1-B (runs on Google Colab, T4 GPU): VoxCPM2 controllable cloning of VieNeu presets
into per-emotion reference clips. THROWAWAY.

Colab usage:
    !pip install -q voxcpm soundfile
    # upload narrator.wav, male.wav, female.wav and this file to /content
    !python s1_colab_refs.py
    # download /content/refs.zip
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import soundfile as sf
from voxcpm import VoxCPM

ROLES = ["narrator", "male", "female"]

EMOTIONS: dict[str, tuple[str, str]] = {
    "neutral": ("calm, neutral storytelling tone", "Sáng hôm sau, cả làng lại bắt đầu một ngày làm việc như thường lệ."),
    "happy": ("joyful, excited, bright tone", "Thật sao? Cuối cùng chúng ta cũng làm được rồi, ta vui quá!"),
    "sad": ("sad, sorrowful, slow, voice trembling", "Mẹ đi rồi, từ nay chẳng còn ai đợi con về nữa."),
    "angry": ("furious, shouting, intense and sharp", "Ngươi dám phản bội ta? Cút ngay ra khỏi đây!"),
    "fearful": ("frightened, anxious, shaky voice", "Có tiếng gì ngoài kia, huynh ơi, muội sợ lắm."),
    "whisper": ("whispering softly, secretive", "Nhỏ tiếng thôi, bọn chúng vẫn còn ở ngoài cửa."),
}


def main() -> None:
    root = Path("/content") if Path("/content").exists() else Path(".")
    out = root / "refs"
    out.mkdir(exist_ok=True)
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    rate = model.tts_model.sample_rate
    for role in ROLES:
        base = root / f"{role}.wav"
        if not base.exists():
            raise SystemExit(f"Missing {base}; upload the three base clips first")
        for emotion, (description, line) in EMOTIONS.items():
            wav = model.generate(
                text=f"({description}){line}",
                reference_wav_path=str(base),
                cfg_value=2.0,
                inference_timesteps=10,
                seed=42,
            )
            path = out / f"{role}_{emotion}.wav"
            sf.write(path, wav, rate)
            print(f"{path.name}: {len(wav) / rate:.1f}s")
    with zipfile.ZipFile(root / "refs.zip", "w") as zf:
        for path in sorted(out.glob("*.wav")):
            zf.write(path, path.name)
    print(f"wrote {root / 'refs.zip'}")


if __name__ == "__main__":
    main()
