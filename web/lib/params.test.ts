import { describe, expect, it } from "vitest";
import { parseChapterIndex, parseChapterNumber, parsePage, parseSegment, parseUuid } from "./params";

describe("parseUuid", () => {
  it("rejects anything that is not a uuid", () => {
    expect(parseUuid("x")).toBeNull();
    expect(parseUuid("")).toBeNull();
    expect(parseUuid("not-a-uuid")).toBeNull();
    expect(parseUuid("123e4567-e89b-12d3-a456-42661417400")).toBeNull();
    expect(parseUuid("123e4567-e89b-12d3-a456-4266141740000")).toBeNull();
    expect(parseUuid(" 123e4567-e89b-12d3-a456-426614174000")).toBeNull();
  });

  it("round-trips a valid uuid lowercased", () => {
    expect(parseUuid("123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(parseUuid("123E4567-E89B-12D3-A456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
  });
});

describe("parsePage", () => {
  it("clamps to 1..pageCount", () => {
    expect(parsePage("0", 5)).toBe(1);
    expect(parsePage("-3", 5)).toBe(1);
    expect(parsePage("9", 5)).toBe(5);
    expect(parsePage("3", 5)).toBe(3);
  });

  it("gives 1 for a missing or non-numeric value", () => {
    expect(parsePage(undefined, 5)).toBe(1);
    expect(parsePage("abc", 5)).toBe(1);
    expect(parsePage("", 5)).toBe(1);
    expect(parsePage("2.5", 5)).toBe(1);
  });

  it("treats a page count below 1 as one page", () => {
    expect(parsePage("4", 0)).toBe(1);
  });
});

describe("parseChapterNumber", () => {
  it("accepts whole numbers in 1..max only", () => {
    expect(parseChapterNumber("1", 19)).toBe(1);
    expect(parseChapterNumber("19", 19)).toBe(19);
    expect(parseChapterNumber("0", 19)).toBeNull();
    expect(parseChapterNumber("20", 19)).toBeNull();
    expect(parseChapterNumber("abc", 19)).toBeNull();
    expect(parseChapterNumber("1.5", 19)).toBeNull();
    expect(parseChapterNumber(null, 19)).toBeNull();
    expect(parseChapterNumber("5", 0)).toBeNull();
  });
});

describe("parseChapterIndex", () => {
  it("accepts a plain integer in 1..100000", () => {
    expect(parseChapterIndex("1")).toBe(1);
    expect(parseChapterIndex("19")).toBe(19);
    expect(parseChapterIndex("100000")).toBe(100000);
  });

  it("rejects zero, leading zeros, signs, decimals, text and out-of-range values", () => {
    for (const bad of ["0", "01", "abc", "1.5", "100001", "-1", "+1", "", " 1", "1 ", "1e3", "0x10", "٣"]) {
      expect(parseChapterIndex(bad), bad).toBeNull();
    }
  });
});

describe("parseSegment", () => {
  it("accepts a non-negative integer, including 0", () => {
    expect(parseSegment("0")).toBe(0);
    expect(parseSegment("42")).toBe(42);
  });

  it("ignores anything else", () => {
    for (const bad of [undefined, "", "-1", "1.5", "abc", "007", "1e3", " 3", "99999999999"]) {
      expect(parseSegment(bad), String(bad)).toBeNull();
    }
  });
});
