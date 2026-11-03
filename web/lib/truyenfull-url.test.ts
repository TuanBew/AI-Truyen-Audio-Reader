import { describe, expect, it } from "vitest";
import { parseTruyenfullNovelUrl } from "./truyenfull-url";

describe("parseTruyenfullNovelUrl", () => {
  it.each([
    "https://truyenfull.live/bao-long-than-tham/",
    "https://www.truyenfull.live/x-y/chuong-2/",
    "http://truyenfull.live/abc",
  ])("accepts %s", (url) => {
    expect(parseTruyenfullNovelUrl(url)).toBe(url);
  });

  it("trims surrounding whitespace", () => {
    expect(parseTruyenfullNovelUrl("  https://truyenfull.live/abc/ \n")).toBe("https://truyenfull.live/abc/");
  });

  it.each([
    "https://truyenfull.vision/x/",
    "https://truyenfull.live/tim-kiem/?tukhoa=a",
    "https://truyenfull.live/danh-sach/x",
    "javascript:alert(1)",
    "",
    "https://truyenfull.live/",
    "https://truyenfull.live/Upper_Case/",
    "https://truyenfull.live.evil.com/abc/",
    "ftp://truyenfull.live/abc/",
    "not a url",
  ])("rejects %j", (url) => {
    expect(parseTruyenfullNovelUrl(url)).toBeNull();
  });
});
