import type { AudioManifest, ManifestChunk } from "@/lib/types";

// Chunks still to append, in order, given how many were appended already.
export function nextAppends(appended: number, manifest: AudioManifest): ManifestChunk[] {
  return manifest.chunks.slice(Math.max(0, appended));
}

// The duration to put on the MediaSource: only for a row that was ready when opened and before any frame is buffered.
// Lowering it later would drop buffered audio (spec 6.5).
export function durationToSet(manifest: AudioManifest, openedReady: boolean, bufferedEndS: number): number | null {
  if (!openedReady || manifest.status !== "ready" || manifest.durationMs === null) return null;
  return bufferedEndS > 0 ? null : manifest.durationMs / 1000;
}

export function shouldEndStream(manifest: AudioManifest, appended: number): boolean {
  return manifest.status === "ready" && appended >= manifest.chunks.length;
}
