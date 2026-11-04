import type { R2ReadEnv } from "@/lib/env.server";
import type { AudioChunk, AudioManifest, AudioStatus } from "@/lib/types";
import { isAudioKey } from "./keys";
import { presignGet } from "./presign";

export type ManifestRow = {
  id: string;
  attempt: number;
  status: AudioStatus;
  init_key: string | null;
  chunks: AudioChunk[] | null;
  full_key: string | null;
  duration_ms: number | null;
};

// Signs the keys of one chapter_audio row. Keys that fail isAudioKey are never signed. A bad chunk key ends the
// list there: the player appends strictly in order, so a hole would be worse than a shorter manifest.
export async function buildManifest(
  env: R2ReadEnv,
  row: ManifestRow,
  now: Date,
  warn: (message: string) => void = () => {},
): Promise<AudioManifest> {
  const sign = (key: string | null) => {
    if (key === null) return Promise.resolve(null);
    if (!isAudioKey(key, row.attempt)) {
      warn(`audio ${row.id}: skipped invalid key`);
      return Promise.resolve(null);
    }
    return presignGet(env, key, now);
  };

  const valid: AudioChunk[] = [];
  for (const chunk of row.chunks ?? []) {
    if (!isAudioKey(chunk.key, row.attempt)) {
      warn(`audio ${row.id}: chunk list stopped at an invalid key (${valid.length} kept)`);
      break;
    }
    valid.push(chunk);
  }

  const [init, full, ...urls] = await Promise.all([
    sign(row.init_key),
    sign(row.full_key),
    ...valid.map((chunk) => presignGet(env, chunk.key, now)),
  ]);
  return {
    audioId: row.id,
    attempt: row.attempt,
    status: row.status,
    durationMs: row.duration_ms,
    init,
    chunks: valid.map((chunk, i) => ({ url: urls[i]!, startMs: chunk.start_ms, endMs: chunk.end_ms })),
    full,
  };
}
