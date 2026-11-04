import { describe, expect, it } from "vitest";
import type { AudioRow, AudioSnapshot, JobRow } from "@/lib/types";
import { DEFAULT_FAILED_TEXT, generationState, usableAudio } from "./generation";

const NOW = Date.parse("2026-11-03T10:00:00Z");

const audio = (over: Partial<AudioRow> = {}): AudioRow => ({
  id: "a1",
  attempt: 1,
  status: "ready",
  voice_hash: "v1",
  text_hash: "h1",
  init_key: "init",
  chunks: [{ key: "c0", start_ms: 0, end_ms: 9981 }],
  full_key: "full",
  duration_ms: 60000,
  segments: [],
  updated_at: "2026-11-03T09:00:00Z",
  ...over,
});

const job = (status: JobRow["status"], error: string | null = null): JobRow => ({
  id: "j1",
  type: "synthesize",
  status,
  error,
  priority: 0,
  created_at: "2026-11-03T09:59:00Z",
});

const snap = (over: Partial<AudioSnapshot> = {}): AudioSnapshot => ({
  chapterId: "c1",
  voiceHash: "v1",
  chapterTextHash: "h1",
  audio: null,
  job: null,
  queuePosition: null,
  workerLastSeen: "2026-11-03T09:59:50Z",
  ...over,
});

describe("usableAudio", () => {
  it("accepts only audio whose text hash equals the chapter's", () => {
    expect(usableAudio(audio(), "h1")).not.toBeNull();
    expect(usableAudio(audio(), "h2")).toBeNull();
    expect(usableAudio(audio({ text_hash: null }), "h1")).toBeNull();
    expect(usableAudio(audio(), null)).toBeNull();
    expect(usableAudio(null, "h1")).toBeNull();
    expect(usableAudio(audio({ text_hash: null }), null)).toBeNull();
  });
});

describe("generationState", () => {
  it("is ready for ready audio made from the current text", () => {
    expect(generationState(snap({ audio: audio() }), NOW)).toEqual({
      workerOnline: true,
      kind: "ready",
      durationMs: 60000,
    });
  });

  it("ready beats a live job", () => {
    expect(generationState(snap({ audio: audio(), job: job("running") }), NOW).kind).toBe("ready");
  });

  it("treats ready audio of a different text as absent: idle without a job", () => {
    expect(generationState(snap({ audio: audio({ text_hash: "old" }) }), NOW).kind).toBe("idle");
  });

  it("treats ready audio of a different text as absent: queued with the job's position", () => {
    expect(
      generationState(
        snap({
          audio: audio({ text_hash: "old" }),
          job: job("queued"),
          queuePosition: 3,
        }),
        NOW,
      ),
    ).toEqual({ workerOnline: true, kind: "queued", position: 3 });
  });

  it("treats a null audio text hash as stale", () => {
    expect(generationState(snap({ audio: audio({ text_hash: null }) }), NOW).kind).toBe("idle");
  });

  it("treats audio as stale when the chapter has no text hash", () => {
    expect(generationState(snap({ audio: audio(), chapterTextHash: null }), NOW).kind).toBe("idle");
  });

  it("is partial with generatedMs at the start of the open last chunk", () => {
    const partial = audio({
      status: "partial",
      duration_ms: null,
      chunks: [
        { key: "c0", start_ms: 0, end_ms: 9981 },
        { key: "c1", start_ms: 9981, end_ms: null },
      ],
    });
    expect(generationState(snap({ audio: partial, job: job("running") }), NOW)).toEqual({
      workerOnline: true,
      kind: "partial",
      generatedMs: 9981,
    });
  });

  it("uses the last chunk's end_ms when it has one", () => {
    const partial = audio({
      status: "partial",
      chunks: [
        { key: "c0", start_ms: 0, end_ms: 9981 },
        { key: "c1", start_ms: 9981, end_ms: 20000 },
      ],
    });
    expect(generationState(snap({ audio: partial }), NOW)).toMatchObject({
      kind: "partial",
      generatedMs: 20000,
    });
  });

  it("ignores partial audio of a different text", () => {
    const partial = audio({ status: "partial", text_hash: "old" });
    expect(generationState(snap({ audio: partial, job: job("running") }), NOW).kind).toBe("starting");
  });

  it("is starting for a running job without playable audio", () => {
    expect(generationState(snap({ job: job("running") }), NOW).kind).toBe("starting");
    expect(
      generationState(
        snap({
          audio: audio({ status: "queued", chunks: [] }),
          job: job("running"),
        }),
        NOW,
      ).kind,
    ).toBe("starting");
  });

  it("is queued with a null position when it is unknown", () => {
    expect(generationState(snap({ job: job("queued") }), NOW)).toEqual({
      workerOnline: true,
      kind: "queued",
      position: null,
    });
  });

  it("is failed with the job's error, or the default Vietnamese message", () => {
    expect(generationState(snap({ job: job("failed", "GPU hết bộ nhớ.") }), NOW)).toEqual({
      workerOnline: true,
      kind: "failed",
      error: "GPU hết bộ nhớ.",
      jobId: "j1",
    });
    expect(generationState(snap({ job: job("failed") }), NOW)).toMatchObject({
      kind: "failed",
      error: "Không tạo được âm thanh cho chương này.",
    });
    expect(DEFAULT_FAILED_TEXT).toBe("Không tạo được âm thanh cho chương này.");
  });

  it("is idle for done or cancelled jobs without usable audio, and with nothing at all", () => {
    expect(generationState(snap({ job: job("done") }), NOW).kind).toBe("idle");
    expect(generationState(snap({ job: job("cancelled") }), NOW).kind).toBe("idle");
    expect(generationState(snap(), NOW).kind).toBe("idle");
  });

  it("reports the worker offline after 60 s and online before", () => {
    expect(generationState(snap({ workerLastSeen: "2026-11-03T09:58:59Z" }), NOW).workerOnline).toBe(false);
    expect(generationState(snap({ workerLastSeen: "2026-11-03T09:59:01Z" }), NOW).workerOnline).toBe(true);
    expect(generationState(snap({ workerLastSeen: null }), NOW).workerOnline).toBe(false);
  });
});
