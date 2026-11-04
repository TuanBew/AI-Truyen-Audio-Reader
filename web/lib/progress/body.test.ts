import { describe, expect, it } from "vitest";
import { progressBody } from "./body";

const ok = {
  novelId: "11111111-1111-4111-8111-111111111111",
  chapterId: "22222222-2222-4222-8222-222222222222",
  segmentIndex: 3,
  positionMs: 1500,
};

describe("progressBody", () => {
  it("defaults finished to false", () => {
    expect(progressBody.parse(ok)).toEqual({ ...ok, finished: false });
    expect(progressBody.parse({ ...ok, finished: true }).finished).toBe(true);
  });

  it("rejects a negative positionMs or segmentIndex", () => {
    expect(progressBody.safeParse({ ...ok, positionMs: -1 }).success).toBe(false);
    expect(progressBody.safeParse({ ...ok, segmentIndex: -1 }).success).toBe(false);
  });

  it("rejects non-integers and values beyond the integer column", () => {
    expect(progressBody.safeParse({ ...ok, positionMs: 1.5 }).success).toBe(false);
    expect(progressBody.safeParse({ ...ok, segmentIndex: 2 ** 31 }).success).toBe(false);
  });

  it("rejects a non-uuid chapterId or novelId", () => {
    expect(progressBody.safeParse({ ...ok, chapterId: "abc" }).success).toBe(false);
    expect(progressBody.safeParse({ ...ok, novelId: "n" }).success).toBe(false);
  });

  it("rejects missing fields", () => {
    for (const key of Object.keys(ok)) {
      const rest = Object.fromEntries(Object.entries(ok).filter(([k]) => k !== key));
      expect(progressBody.safeParse(rest).success).toBe(false);
    }
    expect(progressBody.safeParse(null).success).toBe(false);
  });

  it("ignores a user_id in the body", () => {
    const parsed = progressBody.parse({ ...ok, user_id: "x", userId: "y" });
    expect(parsed).not.toHaveProperty("user_id");
    expect(parsed).not.toHaveProperty("userId");
  });
});
