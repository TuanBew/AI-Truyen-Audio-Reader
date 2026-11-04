import { describe, expect, it } from "vitest";
import { keyAction } from "./keys";

const press = (key: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) =>
  keyAction({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    targetTag: "BODY",
    targetEditable: false,
    ...extra,
  });

describe("keyAction", () => {
  it("maps the M3 keys", () => {
    expect(press(" ")).toBe("toggle");
    expect(press("ArrowLeft")).toBe("prevSeg");
    expect(press("ArrowRight")).toBe("nextSeg");
    expect(press("ArrowLeft", { shiftKey: true })).toBe("prevChapter");
    expect(press("ArrowRight", { shiftKey: true })).toBe("nextChapter");
    expect(press("[")).toBe("slower");
    expect(press("]")).toBe("faster");
    expect(press("t")).toBe("toc");
    expect(press("T", { shiftKey: true })).toBe("toc");
    expect(press("?", { shiftKey: true })).toBe("help");
  });
  it("ignores unmapped keys", () => {
    expect(press("a")).toBeNull();
    expect(press("Enter")).toBeNull();
    expect(press("b")).toBeNull(); // bookmarks are M5
  });
  it("leaves typing targets alone", () => {
    for (const targetTag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(press(" ", { targetTag })).toBeNull();
      expect(press("ArrowRight", { targetTag })).toBeNull();
    }
    expect(press("t", { targetEditable: true })).toBeNull();
  });
  it("leaves Space on a button to the browser", () => {
    expect(press(" ", { targetTag: "BUTTON" })).toBeNull();
    expect(press("ArrowRight", { targetTag: "BUTTON" })).toBe("nextSeg");
  });
  it("ignores browser shortcuts", () => {
    expect(press("ArrowRight", { ctrlKey: true })).toBeNull();
    expect(press("t", { metaKey: true })).toBeNull();
    expect(press("[", { altKey: true })).toBeNull();
  });
});
