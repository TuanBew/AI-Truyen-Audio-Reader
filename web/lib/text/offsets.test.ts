import { describe, expect, it } from "vitest";
import { codePointIndex, toUtf16Range } from "./offsets";

describe("toUtf16Range", () => {
  it("maps code-point ranges across an astral character", () => {
    const t = "a😀b";
    expect(toUtf16Range(t, [1, 2])).toEqual([1, 3]);
    expect(toUtf16Range(t, [2, 3])).toEqual([3, 4]);
  });

  it("is the identity for text without astral characters", () => {
    const t = "Lâm Phong nói".normalize("NFC");
    expect(toUtf16Range(t, [0, 3])).toEqual([0, 3]);
    expect(toUtf16Range(t, [4, t.length])).toEqual([4, t.length]);
  });

  it("clamps ranges that run past the end of the text", () => {
    expect(toUtf16Range("a😀b", [2, 99])).toEqual([3, 4]);
  });
});

describe("codePointIndex", () => {
  it("has one entry per code point plus the end", () => {
    const idx = codePointIndex("a😀b");
    expect(Array.from(idx)).toEqual([0, 1, 3, 4]);
  });
});
