import type { GenState } from "@/lib/audio/generation";
import type { TimedSegment } from "@/lib/types";

// Calibration: chapter 1 of Bảo Long Thần Thám has about 6,400 characters and 513 s of audio.
const MS_PER_CHAR = 80;

export function estimateDurationMs(chars: number): number {
  return Math.round(chars * MS_PER_CHAR);
}

// The segment whose [start_ms, next.start_ms) holds `ms`; the last one holds until its end_ms. `timed` is sorted by
// start_ms. Gaps between segments belong to the previous one, so the highlight never blinks off between sentences.
export function segmentAt(timed: TimedSegment[], ms: number): number | null {
  if (timed.length === 0 || !(ms >= timed[0]!.start_ms)) return null;
  let lo = 0;
  let hi = timed.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timed[mid]!.start_ms <= ms) lo = mid;
    else hi = mid - 1;
  }
  const hit = timed[lo]!;
  if (lo === timed.length - 1 && ms > hit.end_ms) return null;
  return hit.i;
}

// Where playback of segment `i` starts. An untimed segment (no text, or timings not written yet) starts at the next
// timed one after it; null when no later segment is timed (Review Focus 2).
export function startOfSegment(timed: TimedSegment[], i: number): number | null {
  let best: TimedSegment | null = null;
  for (const t of timed) {
    if (t.i >= i && (best === null || t.i < best.i)) best = t;
  }
  return best ? best.start_ms : null;
}

// What the timeline draws: the whole length, and how much of it is playable. While generating, the total is only an
// estimate (never below what exists) and the solid range follows what the engine has actually buffered.
export function timelineRanges(
  state: GenState,
  bufferedEndMs: number,
  estimatedTotalMs: number,
): { totalMs: number; generatedMs: number } {
  if (state.kind === "ready") return { totalMs: state.durationMs, generatedMs: state.durationMs };
  const generated = state.kind === "partial" ? state.generatedMs : 0;
  const shown = state.kind === "partial" && bufferedEndMs > 0 ? Math.min(generated, bufferedEndMs) : generated;
  return { totalMs: Math.max(estimatedTotalMs, generated), generatedMs: shown };
}

// m:ss; chapters of an hour or more read as 90:00 rather than switching format.
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
