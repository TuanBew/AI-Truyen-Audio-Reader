import { describe, expect, it } from "vitest";
import type { AudioManifest } from "@/lib/types";
import { durationToSet, nextAppends, shouldEndStream } from "./plan";

const chunk = (n: number) => ({ url: `https://r2.test/seg-${n}`, startMs: n * 10_000, endMs: (n + 1) * 10_000 });
const manifest = (over: Partial<AudioManifest> = {}): AudioManifest => ({
  audioId: "a",
  attempt: 1,
  status: "ready",
  durationMs: 30_000,
  init: "https://r2.test/init",
  chunks: [chunk(0), chunk(1), chunk(2), chunk(3)],
  full: null,
  ...over,
});

describe("nextAppends", () => {
  it("returns chunks from the appended count onward", () => {
    expect(nextAppends(2, manifest()).map((c) => c.startMs)).toEqual([20_000, 30_000]);
    expect(nextAppends(4, manifest())).toEqual([]);
    expect(nextAppends(0, manifest())).toHaveLength(4);
  });
});

describe("durationToSet", () => {
  it("sets the duration only for a ready row opened ready with nothing buffered", () => {
    const m = manifest();
    expect(durationToSet(m, true, 0)).toBe(30);
    expect(durationToSet(m, true, 0.5)).toBeNull();
    expect(durationToSet(manifest({ status: "partial", durationMs: null }), false, 0)).toBeNull();
    expect(durationToSet(m, false, 0)).toBeNull();
  });
});

describe("shouldEndStream", () => {
  it("is false for partial rows and while chunks remain", () => {
    expect(shouldEndStream(manifest({ status: "partial" }), 4)).toBe(false);
    expect(shouldEndStream(manifest(), 3)).toBe(false);
  });
  it("is true for a ready row with every chunk appended", () => {
    expect(shouldEndStream(manifest(), 4)).toBe(true);
  });
});
