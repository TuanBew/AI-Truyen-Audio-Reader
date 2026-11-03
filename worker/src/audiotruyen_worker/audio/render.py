"""Chapter renderer (spec 4.3, 5.6, 7.3.2): synthesizes segments in order on the calling thread,
feeds one long-lived encoder, and uploads init + clusters from a second thread as soon as they
appear (pipelined: the next segment synthesizes while the previous cluster uploads). On
completion it remuxes the seekable full.webm and uploads it."""

from __future__ import annotations

import logging
import subprocess
import tempfile
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from audiotruyen_worker.audio.encoder import SAMPLE_RATE, EncoderError, StreamEncoder
from audiotruyen_worker.audio.post import finish_segment, trim
from audiotruyen_worker.audio.quality import hf_ratio, is_noisy
from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment
from audiotruyen_worker.tts.base import TTSProvider, TTSUnavailable, VoiceRef

log = logging.getLogger(__name__)

CONTENT_TYPE = "audio/webm"
GUARD_RETRIES = 2  # at most 2 re-syntheses per segment; the lowest-ratio take is kept
FAILED_SEGMENT_MS = 500  # silence for a segment that could not be synthesized at all
MAX_CONSECUTIVE_FAILURES = 3  # circuit breaker: this many dead segments in a row abort the render
MAX_FAILED_FRACTION = 0.25  # ... and so does a chapter with more than this share of dead ones
REMUX_TIMEOUT_S = 120


class AttemptSuperseded(Exception):
    """A newer attempt owns this chapter_audio row; this run must stop and upload nothing."""


class TTSFailing(RuntimeError):
    """Too many segments could not be synthesized at all; the chapter must not become ready."""


@dataclass(frozen=True)
class SegmentPlan:
    i: int
    text: str  # normalized TTS input
    voice: VoiceRef
    emotion: str
    intensity: float
    paragraph_end: bool


@dataclass
class RenderResult:
    init_key: str
    chunks: list[dict]
    full_key: str
    duration_ms: int
    timings: dict[int, tuple[int, int]]  # segment i -> (start_ms, end_ms) of its speech
    warnings: list[dict] = field(default_factory=list)


Uploader = Callable[[str, bytes, str], int]
Progress = Callable[[str, list[dict]], bool]  # (init_key, chunks) -> still own the attempt?


def _audible(audio: np.ndarray) -> bool:
    """False for an empty take or one that trims to nothing (all silence or sub-threshold)."""
    if not len(audio):
        return False
    clean = np.nan_to_num(np.asarray(audio, dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    return bool(len(trim(clean)))


class ChapterRenderer:
    def __init__(
        self,
        tts: TTSProvider,
        upload: Uploader,
        on_progress: Progress,
        key_prefix: str,
        baseline_for: Callable[[VoiceRef], float],
        fallback_voice: VoiceRef,
        check: Callable[[], None] = lambda: None,
        ffmpeg: str = "ffmpeg",
    ) -> None:
        self._tts = tts
        self._upload = upload
        self._on_progress = on_progress
        self._prefix = key_prefix.rstrip("/") + "/"
        self._baseline_for = baseline_for
        self._fallback = fallback_voice
        self._check = check
        self._ffmpeg = ffmpeg
        self._warnings: list[dict] = []

    # ---- synthesis -----------------------------------------------------------------------

    def _speak(self, plan: SegmentPlan) -> np.ndarray | None:
        """Retry once, then the voice's neutral form, then the default narrator. None when every
        attempt failed or came back empty or silent. TTSUnavailable is never swallowed."""
        attempts: list[tuple[str, VoiceRef]] = [("voice", plan.voice), ("retry", plan.voice)]
        if plan.voice.ref_path and plan.voice.preset:
            attempts.append(("neutral", VoiceRef(plan.voice.voice_id, preset=plan.voice.preset)))
        if plan.voice != self._fallback:
            attempts.append(("narrator", self._fallback))
        for step, voice in attempts:
            try:
                audio = self._tts.synthesize(plan.text, voice, plan.emotion, plan.intensity)
            except TTSUnavailable:
                raise  # the model is gone: no per-segment fallback can help
            except Exception as exc:  # a segment never blocks the chapter
                log.warning("segment %d: TTS failed (%s): %s", plan.i, step, type(exc).__name__)
                continue
            if not _audible(audio):
                log.warning("segment %d: TTS returned no audible audio (%s)", plan.i, step)
                continue
            if step != "voice":
                self._warnings.append({"segment": plan.i, "code": f"tts_fallback_{step}"})
            return audio
        return None

    def _synthesize(self, plan: SegmentPlan) -> np.ndarray | None:
        """Quality guard: re-synthesize noisy takes up to GUARD_RETRIES times, keep the best.
        A failed take never replaces an audible one; None (plus a tts_failed warning) only when
        no take produced audio at all."""
        baseline = self._baseline_for(plan.voice)
        best: tuple[float, np.ndarray] | None = None
        for take in range(1 + GUARD_RETRIES):
            audio = self._speak(plan)
            if audio is None:
                if best is None:
                    break  # nothing audible: retrying a dead voice only burns time
                continue
            ratio = hf_ratio(audio)  # raw output, like the baselines
            score = ratio if ratio is not None else 0.0
            if best is None or score < best[0]:
                best = (score, audio)
            if not is_noisy(ratio, baseline):
                break
            log.info("segment %d: noisy take %d (ratio %.2e)", plan.i, take, score)
        else:
            self._warnings.append({"segment": plan.i, "code": "quality_guard_exhausted"})
        if best is None:
            self._warnings.append({"segment": plan.i, "code": "tts_failed"})
            return None
        return best[1]

    # ---- render ----------------------------------------------------------------------------

    def render(self, plans: Sequence[SegmentPlan]) -> RenderResult:
        self._warnings = []
        encoder = StreamEncoder(self._ffmpeg)
        encoder.start()
        uploaded: list[bytes] = []
        state: dict = {"init_key": None, "chunks": [], "error": None}
        stop = threading.Event()

        def fail(exc: BaseException) -> None:
            if state["error"] is None:  # keep the first cause, not the kill's aftermath
                state["error"] = exc
            stop.set()
            encoder.kill()

        def upload(segment: InitSegment | ClusterSegment) -> None:
            if isinstance(segment, InitSegment):
                key = self._prefix + "init.webm"
                self._upload(key, segment.data, CONTENT_TYPE)
                state["init_key"] = key
                uploaded.append(segment.data)
                return
            assert isinstance(segment, ClusterSegment)
            key = f"{self._prefix}seg-{segment.index:04d}.webm"
            self._upload(key, segment.data, CONTENT_TYPE)
            uploaded.append(segment.data)
            chunks = state["chunks"]
            if chunks:
                chunks[-1]["end_ms"] = segment.timestamp_ms
            chunks.append({"key": key, "start_ms": segment.timestamp_ms, "end_ms": None})
            if not self._on_progress(state["init_key"], chunks):
                raise AttemptSuperseded()

        def upload_loop() -> None:
            try:
                for segment in encoder.segments():
                    if stop.is_set():
                        continue  # drain the encoder; upload nothing more
                    try:
                        upload(segment)
                    except BaseException as exc:
                        # Record the cause before leaving the loop: dropping the segments()
                        # generator kills the encoder, which would fail the writer first.
                        fail(exc)
                        return
            except BaseException as exc:  # the encoder itself failed; handed to the writer
                fail(exc)

        uploader = threading.Thread(target=upload_loop, name="audio-uploader", daemon=True)
        uploader.start()
        timings: dict[int, tuple[int, int]] = {}
        samples = 0
        failed = streak = 0
        try:
            for plan in plans:
                self._check()
                if stop.is_set():
                    break
                audio = self._synthesize(plan)
                streak = streak + 1 if audio is None else 0
                failed += audio is None
                if streak >= MAX_CONSECUTIVE_FAILURES:
                    raise TTSFailing(f"{streak} segments in a row could not be synthesized")
                if audio is None:  # exactly FAILED_SEGMENT_MS of silence, never trimmed away
                    gap = np.zeros(FAILED_SEGMENT_MS * SAMPLE_RATE // 1000, dtype=np.float32)
                    pause, _ = finish_segment(gap[:0], plan.emotion, plan.paragraph_end)
                    pcm, speech_len = np.concatenate([gap, pause]), len(gap)
                else:
                    pcm, speech_len = finish_segment(audio, plan.emotion, plan.paragraph_end)
                start_ms = round(samples * 1000 / SAMPLE_RATE)
                timings[plan.i] = (start_ms, round((samples + speech_len) * 1000 / SAMPLE_RATE))
                try:
                    encoder.write(pcm)
                except EncoderError:
                    if stop.is_set():  # the uploader stopped the encoder; its error wins below
                        break
                    raise
                samples += len(pcm)
            if not stop.is_set():
                if failed > MAX_FAILED_FRACTION * len(plans):
                    raise TTSFailing(f"{failed} of {len(plans)} segments could not be synthesized")
                encoder.close()
        except BaseException:
            stop.set()
            encoder.kill()
            uploader.join(timeout=30)
            raise
        uploader.join()
        if state["error"] is not None:
            raise state["error"]
        if state["init_key"] is None or not state["chunks"]:
            raise RuntimeError("encoder produced no audio")
        duration_ms = round(samples * 1000 / SAMPLE_RATE)
        state["chunks"][-1]["end_ms"] = duration_ms
        full_key = self._prefix + "full.webm"
        self._upload(full_key, self._remux(b"".join(uploaded)), CONTENT_TYPE)
        return RenderResult(
            init_key=state["init_key"],
            chunks=state["chunks"],
            full_key=full_key,
            duration_ms=duration_ms,
            timings=timings,
            warnings=self._warnings,
        )

    def _remux(self, live_webm: bytes) -> bytes:
        """Live WebM has no Duration or Cues; remuxing to a file writes both (spec 4.3)."""
        with tempfile.TemporaryDirectory(prefix="audiotruyen-") as tmp:
            src, dst = Path(tmp) / "concat.webm", Path(tmp) / "full.webm"
            src.write_bytes(live_webm)
            try:
                subprocess.run(
                    [self._ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                     "-i", str(src), "-c", "copy", str(dst)],
                    check=True,
                    capture_output=True,
                    timeout=REMUX_TIMEOUT_S,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )  # fmt: skip
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError(f"ffmpeg remux timed out after {REMUX_TIMEOUT_S} s") from exc
            return dst.read_bytes()
