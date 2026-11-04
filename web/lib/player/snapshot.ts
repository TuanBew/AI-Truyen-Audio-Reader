import { usableAudio } from "@/lib/audio/generation";
import type { AudioRow, AudioSnapshot } from "@/lib/types";

// The row the player may fetch signed URLs for: made from the chapter's current text (Review Focus 1), and either
// ready or partial with an init segment and at least one chunk.
export function playableAudio(snapshot: AudioSnapshot | null): AudioRow | null {
  const audio = snapshot ? usableAudio(snapshot.audio, snapshot.chapterTextHash) : null;
  if (!audio) return null;
  if (audio.status === "ready") return audio;
  return audio.status === "partial" && audio.init_key !== null && audio.chunks.length > 0 ? audio : null;
}

// /api/audio/.../urls is rate limited, so it is fetched only when a snapshot changes what the manifest would hold:
// first playable audio, more chunks, a status flip, or a new attempt. Timings and heartbeats alone never trigger it.
export function needsManifest(prev: AudioSnapshot | null, next: AudioSnapshot): boolean {
  const a = playableAudio(next);
  if (!a) return false;
  const p = playableAudio(prev);
  if (!p || p.id !== a.id) return true;
  return a.attempt !== p.attempt || a.status !== p.status || a.chunks.length > p.chunks.length;
}
