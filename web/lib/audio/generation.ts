import type { AudioRow, AudioSnapshot } from "@/lib/types";

// A worker whose newest heartbeat is older than this counts as off (same bound as lib/data/chapter).
const WORKER_ONLINE_MS = 60_000;
export const DEFAULT_FAILED_TEXT = "Không tạo được âm thanh cho chương này.";

export type GenState = { workerOnline: boolean } & (
  | { kind: "idle" } // nothing requested yet
  | { kind: "queued"; position: number | null }
  | { kind: "starting" } // job running, no playable audio yet
  | { kind: "partial"; generatedMs: number; jobError: { error: string; jobId: string | null } | null } // generatedMs: last chunk end_ms ?? its start_ms; jobError: the newest job failed after some chunks were written
  | { kind: "ready"; durationMs: number }
  | { kind: "failed"; error: string; jobId: string | null }
);

// Audio made from an older chapter text must never be played against the new one (Review Focus 1): it counts only
// when both hashes are known and equal, and is otherwise treated as absent. The one rule shared by the generation
// state, prefetch, the enqueue decision and the TOC.
export function usableAudio<A extends { text_hash: string | null }>(
  audio: A | null,
  chapterTextHash: string | null,
): A | null {
  return audio !== null && audio.text_hash !== null && audio.text_hash === chapterTextHash ? audio : null;
}

function lastChunkMs(audio: AudioRow): number {
  const last = audio.chunks[audio.chunks.length - 1];
  return last ? (last.end_ms ?? last.start_ms) : 0;
}

export function generationState(s: AudioSnapshot, nowMs: number): GenState {
  const seen = s.workerLastSeen === null ? Number.NaN : Date.parse(s.workerLastSeen);
  const workerOnline = !Number.isNaN(seen) && nowMs - seen <= WORKER_ONLINE_MS;

  const audio = usableAudio(s.audio, s.chapterTextHash);
  if (audio?.status === "ready") {
    return {
      workerOnline,
      kind: "ready",
      durationMs: audio.duration_ms ?? lastChunkMs(audio),
    };
  }
  if (audio?.status === "partial" && audio.chunks.length > 0) {
    // The audio stays playable; a failed newest job is exposed so the UI can offer Thử lại.
    const jobError =
      s.job?.status === "failed" ? { error: s.job.error?.trim() || DEFAULT_FAILED_TEXT, jobId: s.job.id } : null;
    return { workerOnline, kind: "partial", generatedMs: lastChunkMs(audio), jobError };
  }

  switch (s.job?.status) {
    case "queued":
      return { workerOnline, kind: "queued", position: s.queuePosition };
    case "running":
      return { workerOnline, kind: "starting" };
    case "failed":
      return {
        workerOnline,
        kind: "failed",
        error: s.job.error?.trim() || DEFAULT_FAILED_TEXT,
        jobId: s.job.id,
      };
    default:
      return { workerOnline, kind: "idle" };
  }
}
