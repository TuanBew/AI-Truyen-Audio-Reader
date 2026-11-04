import { describe, expect, it } from "vitest";
import { TOC_LOAD_ERROR, parseTocResponse } from "./toc-response";

const item = { id: "c1", index: 1, title: "Chương 1", hasText: true, audioReady: false, listened: false, isNew: false };

describe("parseTocResponse", () => {
  it("accepts a well-formed page", () => {
    const body = { page: 1, pageCount: 2, items: [item] };
    expect(parseTocResponse(200, body)).toEqual({ ok: true, toc: body });
  });

  it("accepts an empty items array", () => {
    expect(parseTocResponse(200, { page: 1, pageCount: 1, items: [] }).ok).toBe(true);
  });

  it("treats a 2xx with a non-JSON body (null) as an error", () => {
    expect(parseTocResponse(200, null)).toEqual({ ok: false, error: TOC_LOAD_ERROR });
  });

  it("treats a 2xx without items, with non-array items or with malformed items as an error", () => {
    expect(parseTocResponse(200, { page: 1, pageCount: 1 }).ok).toBe(false);
    expect(parseTocResponse(200, { page: 1, pageCount: 1, items: "x" }).ok).toBe(false);
    expect(parseTocResponse(200, { page: 1, pageCount: 1, items: [null] }).ok).toBe(false);
    expect(parseTocResponse(200, { page: 1, pageCount: 1, items: [{ id: 1 }] }).ok).toBe(false);
    expect(parseTocResponse(200, { items: [item] }).ok).toBe(false);
    expect(parseTocResponse(200, [item]).ok).toBe(false);
  });

  it("uses the message from the response for an error status, else the generic copy", () => {
    expect(parseTocResponse(404, { error: "Không tìm thấy truyện này." })).toEqual({
      ok: false,
      error: "Không tìm thấy truyện này.",
    });
    expect(parseTocResponse(500, null)).toEqual({ ok: false, error: TOC_LOAD_ERROR });
    expect(parseTocResponse(500, { error: 5 })).toEqual({ ok: false, error: TOC_LOAD_ERROR });
  });
});
