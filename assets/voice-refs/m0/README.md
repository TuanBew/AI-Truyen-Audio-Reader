# M0 voice references (S1 validation basis)

These are the exact audio files the owner rated in spike S1 (2026-10-14). They are archived so the
enabled (voice, emotion) pairs stay tied to the clips that were validated. Results, ratings and
sha256 digests: `docs/superpowers/spikes/2026-10-14-m0-results.md` (S1). Rules: spec section 5.10.

All files: WAV, 48 kHz, mono. Copied byte-for-byte from `spikes/m0/out/s1/` (which is gitignored).

## base/

Neutral clips of the three VieNeu v3 Turbo presets (`spikes/m0/s1_base_clips.py`, one line of
Vietnamese text, `infer()` defaults). They were the timbre source for VoxCPM2.

| File | Preset | Duration |
|---|---|---|
| narrator.wav | Đức Trí | 5.84 s |
| male.wav | Thái Sơn | 5.04 s |
| female.wav | Mỹ Duyên | 6.08 s |

## refs/

`{role}_{emotion}.wav`, 18 clips, generated with VoxCPM2 controllable cloning from the base clips
above, on a Colab T4: cfg 2.0, 10 inference steps, seed 42 (`spikes/m0/s1_colab_refs.py`).

| Role | neutral | happy | sad | angry | fearful | whisper |
|---|---|---|---|---|---|---|
| narrator | 5.12 s | 5.12 s | 5.12 s | 2.24 s **enabled** | 3.52 s | 3.04 s |
| male | 4.32 s | 4.00 s | 3.52 s | 2.72 s **enabled** | 3.20 s | 3.20 s **enabled** |
| female | 3.84 s | 4.16 s **provisional** | 3.84 s **provisional** | 3.04 s | 2.56 s | 3.36 s |

- **enabled**: rated 2 (clear emotion in the VieNeu clone); the ref is used for that pair.
- **provisional**: rated 2, but the female_neutral clone was also rated 2 against the preset, so
  the rating is confounded by the VoxCPM2 timbre shift. Used for now; re-tested in M4 against a
  clone-from-`female_neutral.wav` baseline.
- Every other pair is disabled: those segments use the preset voice itself plus prosody.
- The `*_neutral.wav` refs are not used for playback ("neutral" = the preset voice, `voice=`
  preset id). `female_neutral.wav` is kept as the M4 re-test baseline.
- narrator_angry (2.24 s) and male_angry (2.72 s) are under the usual 3-8 s ref range; they were
  validated as-is.

Regenerating any clip voids its validation. A regenerated or new ref stays disabled until it is
re-tested with the S1 listening-page method (VoxCPM2 ref, VieNeu preset and VieNeu clone side by
side, rated 0/1/2; enable only at 2).
