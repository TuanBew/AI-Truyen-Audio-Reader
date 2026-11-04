import { describe, expect, it } from "vitest";
import { BUDGETS_KB, checkBudgets, chunkSegments } from "./check-route-js.mjs";

const KB = 1024;
// Each fake chunk "<name>" weighs the number of KB in its name suffix: "a-100" = 100 KB.
const size = (p) => Number(p.split("-").pop()) * KB;
const stat = (route, ...chunks) => ({ route, firstLoadChunkPaths: chunks });

describe("checkBudgets", () => {
  it("fails a route 1 KB over its budget", () => {
    const [row] = checkBudgets([stat("/", "a-151")], size, { "/": 150 });
    expect(row).toEqual({ route: "/", kb: 151, budgetKb: 150, ok: false });
  });

  it("passes a route under its budget", () => {
    const [row] = checkBudgets([stat("/", "a-149")], size, { "/": 150 });
    expect(row.ok).toBe(true);
    expect(row.kb).toBe(149);
  });

  it("passes a route exactly at its budget", () => {
    const [row] = checkBudgets([stat("/", "a-150")], size, { "/": 150 });
    expect(row.ok).toBe(true);
  });

  it("fails a budgeted route that is missing from the stats", () => {
    const [row] = checkBudgets([], size, { "/login": 150 });
    expect(row.route).toBe("/login");
    expect(row.ok).toBe(false);
    expect(row.kb).toBeNaN();
  });

  it("counts a shared chunk for every route that lists it", () => {
    const rows = checkBudgets(
      [stat("/", "shared-100", "home-40"), stat("/login", "shared-100", "login-20")],
      size,
      { "/": 150, "/login": 150 },
    );
    expect(rows.map((r) => r.kb)).toEqual([140, 120]);
  });

  it("ignores routes without a budget", () => {
    const rows = checkBudgets([stat("/api/progress", "a-999")], size, { "/": 150 });
    expect(rows.map((r) => r.route)).toEqual(["/"]);
  });

  it("uses the budgets from the brief by default", () => {
    expect(BUDGETS_KB).toEqual({
      "/": 150,
      "/novel/[id]": 150,
      "/read/[novelId]/[chapterIndex]": 220,
      "/login": 150,
    });
  });
});

describe("empty or malformed chunk lists", () => {
  it.each([["empty", []], ["missing", undefined], ["not an array", "a-10"]])("fails a route with an %s chunk list", (_l, chunks) => {
    const [row] = checkBudgets([{ route: "/", firstLoadChunkPaths: chunks }], size, { "/": 150 });
    expect(row.ok).toBe(false);
    expect(row.kb).toBeNaN();
  });
});

describe("chunkSegments", () => {
  it("splits Windows and POSIX chunk paths the same way", () => {
    const win = ".next" + String.fromCharCode(92) + "static" + String.fromCharCode(92) + "chunks" + String.fromCharCode(92) + "a.js";
    expect(chunkSegments(win)).toEqual([".next", "static", "chunks", "a.js"]);
    expect(chunkSegments(".next/static/chunks/a.js")).toEqual([".next", "static", "chunks", "a.js"]);
  });
});
