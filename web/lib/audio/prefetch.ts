import { usableAudio } from "@/lib/audio/generation";
import type { AudioStatus, JobStatus } from "@/lib/types";

export type PrefetchInput = {
  index: number; // the chapter being played
  k: number; // settings.worker.prefetchCount
  chapters: { id: string; index: number; text_hash: string | null }[];
  audio: {
    chapter_id: string;
    status: AudioStatus;
    text_hash: string | null;
  }[]; // rows for the current voice hash
  jobs: { chapter_id: string; status: JobStatus; created_at: string }[]; // synthesize jobs for the current voice hash
};

// Chapter ids for indexes index+1 .. index+k that need audio. Skipped: chapters that do not exist or have no text
// yet (nothing to synthesize), chapters with ready audio for their current text, chapters with a queued or running
// job, and chapters whose newest job failed (spec 5.8, 7.3.1: a failing chapter is not retried on its own).
export function prefetchTargets({ index, k, chapters, audio, jobs }: PrefetchInput): string[] {
  const out: string[] = [];
  const byIndex = new Map(chapters.map((c) => [c.index, c]));
  for (let i = index + 1; i <= index + k; i++) {
    const chapter = byIndex.get(i);
    if (!chapter || chapter.text_hash === null) continue;

    const row = audio.find((a) => a.chapter_id === chapter.id) ?? null;
    if (usableAudio(row, chapter.text_hash)?.status === "ready") continue;

    const mine = jobs.filter((j) => j.chapter_id === chapter.id);
    if (mine.some((j) => j.status === "queued" || j.status === "running")) continue;
    const newest = mine.reduce<(typeof mine)[number] | null>(
      (best, j) => (best === null || j.created_at > best.created_at ? j : best),
      null,
    );
    if (newest?.status === "failed") continue;

    out.push(chapter.id);
  }
  return out;
}
