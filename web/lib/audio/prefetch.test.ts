import { describe, expect, it } from "vitest";
import { prefetchTargets, type PrefetchInput } from "./prefetch";

const chapters = (n: number, over: Record<number, string | null> = {}) =>
  Array.from({ length: n }, (_, k) => ({
    id: `c${k + 1}`,
    index: k + 1,
    text_hash: k + 1 in over ? over[k + 1] : `h${k + 1}`,
  }));

const input = (over: Partial<PrefetchInput> = {}): PrefetchInput => ({
  index: 5,
  k: 3,
  chapters: chapters(7),
  audio: [],
  jobs: [],
  ...over,
});

describe("prefetchTargets", () => {
  it("returns the next k existing chapters in order", () => {
    expect(prefetchTargets(input({ index: 1 }))).toEqual(["c2", "c3", "c4"]);
  });

  it("stops at the last chapter: index 5, k 3, 7 chapters gives only 6 and 7", () => {
    expect(prefetchTargets(input())).toEqual(["c6", "c7"]);
  });

  it("does nothing for k 0 or the last chapter", () => {
    expect(prefetchTargets(input({ k: 0 }))).toEqual([]);
    expect(prefetchTargets(input({ index: 7 }))).toEqual([]);
  });

  it("skips chapters with ready audio made from the current text", () => {
    const audio = [{ chapter_id: "c6", status: "ready" as const, text_hash: "h6" }];
    expect(prefetchTargets(input({ audio }))).toEqual(["c7"]);
  });

  it("does not skip ready audio of an older text, or partial audio", () => {
    const audio = [
      { chapter_id: "c6", status: "ready" as const, text_hash: "old" },
      { chapter_id: "c7", status: "partial" as const, text_hash: "h7" },
    ];
    expect(prefetchTargets(input({ audio }))).toEqual(["c6", "c7"]);
  });

  it("skips chapters with a queued or running synthesize job", () => {
    const jobs = [
      {
        chapter_id: "c6",
        status: "queued" as const,
        created_at: "2026-11-03T10:00:00Z",
      },
      {
        chapter_id: "c7",
        status: "running" as const,
        created_at: "2026-11-03T10:00:00Z",
      },
    ];
    expect(prefetchTargets(input({ jobs }))).toEqual([]);
  });

  it("skips a chapter whose newest job failed (spec 7.3.1)", () => {
    const jobs = [
      {
        chapter_id: "c6",
        status: "done" as const,
        created_at: "2026-11-01T10:00:00Z",
      },
      {
        chapter_id: "c6",
        status: "failed" as const,
        created_at: "2026-11-02T10:00:00Z",
      },
    ];
    expect(prefetchTargets(input({ jobs }))).toEqual(["c7"]);
  });

  it("does not skip a chapter whose older job failed but whose newest is done", () => {
    const jobs = [
      {
        chapter_id: "c6",
        status: "failed" as const,
        created_at: "2026-11-01T10:00:00Z",
      },
      {
        chapter_id: "c6",
        status: "done" as const,
        created_at: "2026-11-02T10:00:00Z",
      },
    ];
    expect(prefetchTargets(input({ jobs }))).toEqual(["c6", "c7"]);
  });

  it("queues chapters without fetched text: the worker fetches text on synthesize", () => {
    expect(prefetchTargets(input({ chapters: chapters(7, { 6: null }) }))).toEqual(["c6", "c7"]);
  });

  it("is not thrown off by unsorted chapters or chapters outside the window", () => {
    expect(prefetchTargets(input({ chapters: [...chapters(7)].reverse() }))).toEqual(["c6", "c7"]);
  });
});
