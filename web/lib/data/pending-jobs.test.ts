import { describe, expect, it } from "vitest";
import { addNovelError, failedJobText, nextPollDelay, POLL_MAX_MS, POLL_START_MS, retryJobError } from "./pending-jobs";

describe("addNovelError", () => {
  it("maps a duplicate", () => {
    expect(addNovelError({ code: "23505", message: "duplicate key" })).toBe("Truyện này đã nằm trong hàng chờ.");
  });
  it("maps the queue cap raised by jobs_guard_write", () => {
    expect(addNovelError({ code: "54000", message: "jobs: queue limit reached (500 queued jobs)" })).toBe(
      "Hàng chờ đã đầy (500 job). Đợi worker chạy bớt rồi thử lại.",
    );
  });
  it("does not call a too-large payload a full queue", () => {
    expect(addNovelError({ code: "54000", message: "jobs: payload larger than 8 KB" })).toBe(
      "Không thêm được vào hàng chờ. Thử lại sau ít phút.",
    );
  });
  it("falls back to the generic copy", () => {
    expect(addNovelError({ code: "42501", message: "x" })).toBe("Không thêm được vào hàng chờ. Thử lại sau ít phút.");
    expect(addNovelError({})).toBe("Không thêm được vào hàng chờ. Thử lại sau ít phút.");
  });
});

describe("retryJobError", () => {
  it("maps the queue cap and falls back otherwise", () => {
    expect(retryJobError({ code: "54000", message: "jobs: queue limit reached (500 queued jobs)" })).toContain("Hàng chờ đã đầy");
    expect(retryJobError({ code: "XX000", message: "boom" })).toBe("Không thử lại được. Thử lại sau ít phút.");
  });
});

describe("failedJobText", () => {
  it("prefixes the worker error", () => {
    expect(failedJobText("Trang truyện không tồn tại.")).toBe("Tải mục lục thất bại: Trang truyện không tồn tại.");
  });
  it("handles a missing error", () => {
    expect(failedJobText(null)).toBe("Tải mục lục thất bại.");
    expect(failedJobText("   ")).toBe("Tải mục lục thất bại.");
  });
  it("truncates to 300 characters with an ellipsis", () => {
    const text = failedJobText("x".repeat(500));
    expect(text).toBe(`Tải mục lục thất bại: ${"x".repeat(300)}…`);
    expect(failedJobText("y".repeat(300))).toBe(`Tải mục lục thất bại: ${"y".repeat(300)}`);
  });
});

describe("nextPollDelay", () => {
  it("doubles from 3 s and caps at 30 s", () => {
    const seq = [POLL_START_MS];
    for (let i = 0; i < 6; i++) seq.push(nextPollDelay(seq[seq.length - 1]));
    expect(seq).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000]);
    expect(POLL_MAX_MS).toBe(30000);
  });
});
