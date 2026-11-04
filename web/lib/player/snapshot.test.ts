import { describe, expect, it } from "vitest";
import type { AudioChunk, AudioRow, AudioSnapshot, JobRow } from "@/lib/types";
import { needsManifest, playableAudio } from "./snapshot";

const chunk = (n: number): AudioChunk => ({ key: `c${n}`, start_ms: n * 1000, end_ms: n * 1000 + 900 });

function snap(audio: Partial<AudioRow> | null, over: Partial<AudioSnapshot> = {}): AudioSnapshot {
  return {
    chapterId: "ch",
    voiceHash: "v",
    chapterTextHash: "t1",
    audio: audio && {
      id: "a1",
      attempt: 1,
      status: "partial",
      voice_hash: "v",
      text_hash: "t1",
      init_key: "init",
      chunks: [chunk(0)],
      full_key: null,
      duration_ms: null,
      segments: [],
      updated_at: "2026-01-01T00:00:00Z",
      ...audio,
    },
    job: null as JobRow | null,
    queuePosition: null,
    workerLastSeen: null,
    ...over,
  };
}

describe("playableAudio", () => {
  it("needs an init and a chunk, or a ready row", () => {
    expect(playableAudio(snap({}))?.id).toBe("a1");
    expect(playableAudio(snap(null))).toBeNull();
    expect(playableAudio(snap({ init_key: null }))).toBeNull();
    expect(playableAudio(snap({ chunks: [] }))).toBeNull();
    expect(playableAudio(snap({ chunks: [], status: "ready", duration_ms: 10 }))?.id).toBe("a1");
  });
  it("rejects audio made from other text (Review Focus 1)", () => {
    expect(playableAudio(snap({ text_hash: "old" }))).toBeNull();
    expect(playableAudio(snap({ text_hash: null }))).toBeNull();
  });
  it("ignores queued and failed rows", () => {
    expect(playableAudio(snap({ status: "queued" }))).toBeNull();
    expect(playableAudio(snap({ status: "failed" }))).toBeNull();
  });
});

describe("needsManifest", () => {
  const base = snap({});
  it("is true for the first playable snapshot", () => {
    expect(needsManifest(null, base)).toBe(true);
    expect(needsManifest(snap(null), base)).toBe(true);
  });
  it("is false when nothing changed (timings or heartbeats alone)", () => {
    expect(needsManifest(base, snap({}, { workerLastSeen: "2026-01-01T00:00:05Z" }))).toBe(false);
    expect(needsManifest(base, snap({ segments: [{ i: 0, start_ms: 0, end_ms: 5 }] }))).toBe(false);
  });
  it("is true when chunks are added, the status flips or the attempt changes", () => {
    expect(needsManifest(base, snap({ chunks: [chunk(0), chunk(1)] }))).toBe(true);
    expect(needsManifest(base, snap({ status: "ready", duration_ms: 9000 }))).toBe(true);
    expect(needsManifest(base, snap({ attempt: 2 }))).toBe(true);
  });
  it("is false when chunks shrink in the same attempt or the next snapshot is not playable", () => {
    expect(needsManifest(snap({ chunks: [chunk(0), chunk(1)] }), base)).toBe(false);
    expect(needsManifest(base, snap(null))).toBe(false);
  });
});
