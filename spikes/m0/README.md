# M0 spikes (THROWAWAY)

Feasibility probes for AudioTruyen v2. Nothing here is product code; it is deleted in M1.
Results and decisions live in `docs/superpowers/spikes/2026-10-14-m0-results.md`.

| Spike | Question | Entry point |
|---|---|---|
| S3 | Does VieNeu v3 Turbo run fast enough on this laptop (GPU and CPU)? | `s3_bench.py` |
| S1 | Does VieNeu carry emotion from a per-emotion reference clip? | `s1_base_clips.py` → `s1_colab_refs.py` (Colab) → `s1_matrix.py` |
| S2 | Can MediaSource play standalone WebM/Opus chunks gaplessly? | `s2_make_chunks.py` + `s2_player.html` |

Venvs: `.venv-gpu` (torch 2.8 cu128 + vieneu) and `.venv-cpu` (torch-free vieneu, ONNX).
Static server: `python -m http.server 8765 --directory spikes/m0` (launch config `m0-spikes`).
