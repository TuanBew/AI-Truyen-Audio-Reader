import { describe, expect, it } from "vitest";
import type { GenState } from "@/lib/audio/generation";
import type { TimedSegment } from "@/lib/types";
import { estimateDurationMs, formatClock, segmentAt, startOfSegment, timelineRanges } from "./timeline";

// Index 1 is skipped (a no-text segment has no timing).
const timed: TimedSegment[] = [
  { i: 0, start_ms: 0, end_ms: 900 },
  { i: 2, start_ms: 1000, end_ms: 2000 },
  { i: 3, start_ms: 2100, end_ms: 3000 },
];

describe("segmentAt", () => {
  it("finds the segment whose span holds the time", () => {
    expect(segmentAt(timed, 950)).toBe(0); // the gap belongs to the previous segment
    expect(segmentAt(timed, 0)).toBe(0);
    expect(segmentAt(timed, 1000)).toBe(2);
    expect(segmentAt(timed, 2050)).toBe(2);
    expect(segmentAt(timed, 2999)).toBe(3);
    expect(segmentAt(timed, 3000)).toBe(3); // the last one holds until its end_ms
  });
  it("is null outside the timeline", () => {
    expect(segmentAt(timed, 3001)).toBeNull();
    expect(segmentAt(timed, -1)).toBeNull();
    expect(segmentAt([], 10)).toBeNull();
  });
  it("copes with a single segment", () => {
    expect(segmentAt([{ i: 5, start_ms: 100, end_ms: 200 }], 150)).toBe(5);
    expect(segmentAt([{ i: 5, start_ms: 100, end_ms: 200 }], 99)).toBeNull();
  });
});

describe("startOfSegment", () => {
  it("returns the exact start", () => {
    expect(startOfSegment(timed, 2)).toBe(1000);
  });
  it("uses the next timed segment for an untimed one (Review Focus 2)", () => {
    expect(startOfSegment(timed, 1)).toBe(1000);
  });
  it("is null past the last timed segment or with no timings", () => {
    expect(startOfSegment(timed, 9)).toBeNull();
    expect(startOfSegment([], 0)).toBeNull();
  });
});

const partial = (generatedMs: number): GenState => ({
  workerOnline: true,
  kind: "partial",
  generatedMs,
  jobError: null,
});

describe("timelineRanges", () => {
  it("ready: the total is durationMs", () => {
    expect(timelineRanges({ workerOnline: true, kind: "ready", durationMs: 500_000 }, 0, 999_999)).toEqual({
      totalMs: 500_000,
      generatedMs: 500_000,
    });
  });
  it("partial: the total is max(estimate, generated)", () => {
    expect(timelineRanges(partial(40_000), 0, 500_000).totalMs).toBe(500_000);
    expect(timelineRanges(partial(600_000), 0, 500_000).totalMs).toBe(600_000);
  });
  it("partial: generated is capped by the buffered end once playback started", () => {
    expect(timelineRanges(partial(40_000), 0, 500_000).generatedMs).toBe(40_000);
    expect(timelineRanges(partial(40_000), 25_000, 500_000).generatedMs).toBe(25_000);
    expect(timelineRanges(partial(40_000), 90_000, 500_000).generatedMs).toBe(40_000);
  });
  it("nothing generated yet: only the estimate", () => {
    expect(timelineRanges({ workerOnline: true, kind: "queued", position: 1 }, 0, 80_000)).toEqual({
      totalMs: 80_000,
      generatedMs: 0,
    });
  });
});

describe("estimateDurationMs", () => {
  it("is 80 ms per character", () => {
    expect(estimateDurationMs(6400)).toBe(512_000);
    expect(estimateDurationMs(0)).toBe(0);
    expect(estimateDurationMs(10.4)).toBe(832);
  });
});

describe("formatClock", () => {
  it("formats m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59_999)).toBe("0:59");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(5_400_000)).toBe("90:00");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});
