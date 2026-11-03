import { describe, expect, it } from "vitest";
import { defaultSettings, parseSettings } from "./settings";

describe("parseSettings", () => {
  it("returns the full defaults for an empty object", () => {
    expect(parseSettings({})).toEqual(defaultSettings);
  });

  it("returns the defaults for null and non-objects", () => {
    expect(parseSettings(null)).toEqual(defaultSettings);
    expect(parseSettings("x")).toEqual(defaultSettings);
    expect(parseSettings(undefined)).toEqual(defaultSettings);
  });

  it("has the documented defaults", () => {
    const s = parseSettings({});
    expect(s.worker.prefetchCount).toBe(3);
    expect(s.player.speed).toBe(1);
    expect(s.player.wordHighlight).toBe(false);
  });

  it("falls back to the default for an out-of-range field", () => {
    expect(parseSettings({ worker: { prefetchCount: 99 } }).worker.prefetchCount).toBe(3);
    expect(parseSettings({ player: { speed: 5 } }).player.speed).toBe(1);
  });

  it("keeps valid fields and defaults the rest of the sub-object", () => {
    const s = parseSettings({ player: { speed: 1.5 }, worker: { prefetchCount: 5 } });
    expect(s.player.speed).toBe(1.5);
    expect(s.player.wordHighlight).toBe(false);
    expect(s.worker.prefetchCount).toBe(5);
  });

  it("falls back to defaults for an invalid sub-object", () => {
    expect(parseSettings({ player: "bad", worker: 7 })).toEqual(defaultSettings);
  });

  it("accepts prefetchCount 0 and 10 and rejects non-integers", () => {
    expect(parseSettings({ worker: { prefetchCount: 0 } }).worker.prefetchCount).toBe(0);
    expect(parseSettings({ worker: { prefetchCount: 10 } }).worker.prefetchCount).toBe(10);
    expect(parseSettings({ worker: { prefetchCount: 2.5 } }).worker.prefetchCount).toBe(3);
  });

  it("defaults analysis.order to the spec 5.4 chain", () => {
    expect(parseSettings({}).analysis.order).toEqual(["openrouter", "local_llm", "heuristic"]);
  });

  it("keeps a valid analysis.order, including a subset in a new order", () => {
    expect(parseSettings({ analysis: { order: ["heuristic", "openrouter"] } }).analysis.order).toEqual([
      "heuristic",
      "openrouter",
    ]);
  });

  it.each([[[]], [["x"]], [["openrouter", "openrouter"]], [["openrouter", "nope"]], ["openrouter"]])(
    "falls back to the default order for invalid analysis.order %j",
    (order) => {
      expect(parseSettings({ analysis: { order } }).analysis.order).toEqual(["openrouter", "local_llm", "heuristic"]);
    },
  );

  it("returns the defaults when the whole document is an array", () => {
    expect(parseSettings([])).toEqual(defaultSettings);
    expect(parseSettings([1, 2])).toEqual(defaultSettings);
  });

  it("falls back to defaults when a section is an array", () => {
    expect(parseSettings({ player: [] })).toEqual(defaultSettings);
    expect(parseSettings({ worker: [{ prefetchCount: 5 }], analysis: [] })).toEqual(defaultSettings);
  });
});
