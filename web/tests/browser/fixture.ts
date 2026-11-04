import type { AudioManifest } from "@/lib/types";
import manifestJson from "../fixtures/sine-25s/manifest.json";
import initUrl from "../fixtures/sine-25s/init.webm?url";
import seg0Url from "../fixtures/sine-25s/seg-0000.webm?url";
import seg1Url from "../fixtures/sine-25s/seg-0001.webm?url";
import seg2Url from "../fixtures/sine-25s/seg-0002.webm?url";

// The 25 s 440 Hz sine, encoded by the production live encoder (worker/scripts/make_player_fixture.py).
export const SEG_URLS = [seg0Url, seg1Url, seg2Url];
export const INIT_URL = initUrl;
export const FIXTURE_DURATION_MS: number = manifestJson.duration_ms;
export const FIXTURE_CHUNKS: { file: string; start_ms: number; end_ms: number }[] = manifestJson.chunks;

export function fixtureManifest(over: Partial<AudioManifest> = {}, chunkCount = 3, suffix = ""): AudioManifest {
  return {
    audioId: "00000000-0000-4000-8000-000000000001",
    attempt: 1,
    status: "ready",
    durationMs: FIXTURE_DURATION_MS,
    init: INIT_URL + suffix,
    chunks: FIXTURE_CHUNKS.slice(0, chunkCount).map((c, i) => ({
      url: SEG_URLS[i]! + suffix,
      startMs: c.start_ms,
      endMs: c.end_ms,
    })),
    full: null,
    ...over,
  };
}

export async function fetchFixture(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A playable single file (init + every cluster), standing in for full.webm.
export async function fullFileUrl(): Promise<string> {
  const parts = await Promise.all([INIT_URL, ...SEG_URLS].map(fetchFixture));
  return URL.createObjectURL(new Blob(parts, { type: "audio/webm" }));
}
