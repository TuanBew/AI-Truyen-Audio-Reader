"""S1-C: compare VieNeu preset (baseline) vs VieNeu cloned from per-emotion refs. THROWAWAY."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

from common import utf8_console

EMOTIONS = ["neutral", "happy", "sad", "angry", "fearful", "whisper"]
LABELS = {
    "neutral": "trung tính",
    "happy": "vui",
    "sad": "buồn",
    "angry": "giận",
    "fearful": "sợ",
    "whisper": "thì thầm",
}
TEST_LINES = {
    "neutral": "Con đường mòn dẫn lên núi phủ đầy lá vàng.",
    "happy": "Ha ha, hôm nay đúng là ngày may mắn nhất đời ta!",
    "sad": "Ta đã đợi nàng suốt mười năm, vậy mà nàng không quay lại.",
    "angry": "Ta nói lần cuối, buông tay cô ấy ra ngay!",
    "fearful": "Đừng lại gần đây, xin ngươi tha cho ta.",
    "whisper": "Nghe này, tối nay giờ Tý, gặp ta ở sau núi.",
}
TAG_TESTS = [
    ("male", "[cười] Ngươi tưởng ta sợ sao?"),
    ("female", "[thở dài] Thôi, chuyện đã qua rồi."),
]


def page(rows: list[dict]) -> str:
    body = []
    for r in rows:
        audios = "".join(
            f'<td>{html.escape(name)}<br><audio controls preload="none" src="{html.escape(src)}"></audio></td>'
            for name, src in r["audios"]
        )
        radios = "".join(
            f'<label><input type="radio" name="{r["id"]}" value="{v}"> {t}</label> '
            for v, t in [(0, "không khác"), (1, "hơi có"), (2, "rõ ràng")]
        )
        body.append(
            f'<tr data-id="{r["id"]}"><td><b>{html.escape(r["title"])}</b><br>'
            f'<small>{html.escape(r["text"])}</small></td>{audios}'
            f'<td>{radios}<br><label><input type="checkbox" name="{r["id"]}-broken"> méo / hỏng / sai giọng</label></td></tr>'
        )
    return f"""<!doctype html><html lang="vi"><meta charset="utf-8"><title>S1 nghe thử</title>
<style>body{{font-family:system-ui;margin:24px}}td{{border-top:1px solid #ccc;padding:8px;vertical-align:top}}audio{{width:220px}}</style>
<h1>S1: Cảm xúc từ giọng mẫu</h1>
<p>Mỗi dòng: so sánh cột "VieNeu clone từ mẫu" với cột "VieNeu preset". Chấm mức cảm xúc nghe được ở cột clone.</p>
<table>{''.join(body)}</table>
<p><button id="copy">Sao chép kết quả</button></p><textarea id="out" rows="8" cols="100"></textarea>
<script>
document.getElementById('copy').onclick = async () => {{
  const result = {{}};
  for (const tr of document.querySelectorAll('tr[data-id]')) {{
    const id = tr.dataset.id;
    const picked = tr.querySelector(`input[name="${{id}}"]:checked`);
    result[id] = {{ rating: picked ? Number(picked.value) : null, broken: tr.querySelector(`input[name="${{id}}-broken"]`).checked }};
  }}
  const text = JSON.stringify(result);
  document.getElementById('out').value = text;
  try {{ await navigator.clipboard.writeText(text); }} catch (e) {{}}
}};
</script></html>"""


def main() -> None:
    utf8_console()
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["auto", "onnx"], default="auto")
    parser.add_argument("--narrator", default="Hải Đăng")
    parser.add_argument("--male", default="Thiện Minh")
    parser.add_argument("--female", default="Ngọc Huyền")
    args = parser.parse_args()
    presets = {"narrator": args.narrator, "male": args.male, "female": args.female}

    from vieneu import Vieneu

    tts = Vieneu() if args.backend == "auto" else Vieneu(backend="onnx")
    root = Path("out/s1")
    refs = root / "refs"
    matrix = root / "matrix"
    matrix.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    for role, preset in presets.items():
        for emotion in EMOTIONS:
            ref = refs / f"{role}_{emotion}.wav"
            if not ref.exists():
                raise SystemExit(f"Missing reference clip {ref}")
            text = TEST_LINES[emotion]
            baseline = matrix / f"{role}_{emotion}_preset.wav"
            cloned = matrix / f"{role}_{emotion}_clone.wav"
            tts.save(tts.infer(text, voice=preset), str(baseline))
            tts.save(tts.infer(text, ref_audio=str(ref)), str(cloned))
            rows.append(
                {
                    "id": f"{role}_{emotion}",
                    "title": f"{role} ({preset}), {LABELS[emotion]}",
                    "text": text,
                    "audios": [
                        ("Mẫu VoxCPM2", f"refs/{ref.name}"),
                        ("VieNeu preset", f"matrix/{baseline.name}"),
                        ("VieNeu clone từ mẫu", f"matrix/{cloned.name}"),
                    ],
                }
            )
            print(f"done {role}/{emotion}")

    for role, text in TAG_TESTS:
        path = matrix / f"{role}_tag.wav"
        tts.save(tts.infer(text, voice=presets[role]), str(path))
        rows.append(
            {
                "id": f"{role}_tag",
                "title": f"{role} ({presets[role]}), tag phi ngôn ngữ",
                "text": text,
                "audios": [("VieNeu preset + tag", f"matrix/{path.name}")],
            }
        )

    (root / "listen.html").write_text(page(rows), encoding="utf-8")
    (root / "rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"open http://localhost:8765/out/s1/listen.html ({len(rows)} rows)")


if __name__ == "__main__":
    main()
