import { describe, expect, it } from "vitest";
import type { GenState } from "@/lib/audio/generation";
import { bannerMessage } from "./banner";
import { createPlayerStore, type PlayerState } from "./store";

function state(gen: GenState, over: Partial<PlayerState> = {}): PlayerState {
  return createPlayerStore({ gen, ...over }).getState();
}
const on = { workerOnline: true } as const;
const off = { workerOnline: false } as const;

describe("bannerMessage", () => {
  it("says nothing when idle or ready", () => {
    expect(bannerMessage(state({ ...on, kind: "idle" }))).toBeNull();
    expect(bannerMessage(state({ ...on, kind: "ready", durationMs: 1000 }))).toBeNull();
  });
  it("queued shows the position when known", () => {
    expect(bannerMessage(state({ ...on, kind: "queued", position: 3 }))?.text).toBe("Đang chờ tạo âm thanh (vị trí 3)");
    expect(bannerMessage(state({ ...on, kind: "queued", position: null }))?.text).toBe("Đang chờ tạo âm thanh");
  });
  it("starting and partial", () => {
    expect(bannerMessage(state({ ...on, kind: "starting" }))?.text).toBe("Đang tạo âm thanh…");
    expect(
      bannerMessage(state({ ...on, kind: "partial", generatedMs: 65_000, jobError: null }))?.text,
    ).toBe("Đang tạo âm thanh, đã có 1:05");
  });
  it("failed shows the error with a retry", () => {
    const m = bannerMessage(state({ ...on, kind: "failed", error: "Hết bộ nhớ GPU.", jobId: "j1" }));
    expect(m).toMatchObject({ text: "Hết bộ nhớ GPU.", retry: true, alert: true });
  });
  it("a failed job after some audio shows the error and retry while playback continues", () => {
    const m = bannerMessage(
      state({ ...on, kind: "partial", generatedMs: 9000, jobError: { error: "Lỗi giữa chừng.", jobId: "j2" } }),
    );
    expect(m).toMatchObject({ text: "Lỗi giữa chừng.", retry: true });
  });
  it("an offline worker with pending work", () => {
    const m = bannerMessage(state({ ...off, kind: "queued", position: 1 }, { workerAgoMin: 4 }));
    expect(m?.text).toBe("Worker đang tắt (lần cuối 4 phút trước). Chương sẽ được tạo khi worker bật lại.");
    expect(bannerMessage(state({ ...off, kind: "starting" }, { workerAgoMin: null }))?.text).toBe(
      "Worker đang tắt. Chương sẽ được tạo khi worker bật lại.",
    );
    expect(bannerMessage(state({ ...off, kind: "partial", generatedMs: 1, jobError: null }, { workerAgoMin: 2 }))?.text).toMatch(
      /^Worker đang tắt/,
    );
  });
  it("an offline worker does not matter when nothing is pending", () => {
    expect(bannerMessage(state({ ...off, kind: "ready", durationMs: 1 }))).toBeNull();
    expect(bannerMessage(state({ ...off, kind: "idle" }))).toBeNull();
  });
  it("an error wins and carries its retry flag", () => {
    const m = bannerMessage(
      state({ ...on, kind: "starting" }, { error: "Liên kết âm thanh đã hết hạn. Bấm Thử lại.", canRetry: true }),
    );
    expect(m).toMatchObject({ text: "Liên kết âm thanh đã hết hạn. Bấm Thử lại.", retry: true, alert: true });
    expect(bannerMessage(state({ ...on, kind: "idle" }, { error: "Chờ chút.", canRetry: false }))?.retry).toBe(false);
  });
  it("a click on a segment that is not generated yet adds a note", () => {
    const partial: GenState = { ...on, kind: "partial", generatedMs: 5000, jobError: null };
    expect(bannerMessage(state(partial, { pendingSeekSeg: 40 }))?.text).toBe(
      "Đang tạo âm thanh, đã có 0:05. Đang tạo tới đoạn này…",
    );
    expect(bannerMessage(state({ ...on, kind: "ready", durationMs: 9000 }, { pendingSeekSeg: 40 }))?.text).toBe(
      "Đang tải tới đoạn này…",
    );
    expect(bannerMessage(state({ ...on, kind: "queued", position: null }, { pendingSeekSeg: 3 }))?.text).toBe(
      "Đang chờ tạo âm thanh. Đang tạo tới đoạn này…",
    );
  });
});
