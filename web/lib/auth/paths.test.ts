import { describe, expect, it } from "vitest";
import { isPublicPath, safeNextPath } from "./paths";

describe("isPublicPath", () => {
  it("allows the login page", () => {
    expect(isPublicPath("/login")).toBe(true);
  });
  it("protects everything else", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/read/abc/1")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/novel/123")).toBe("/novel/123");
  });
  it("rejects external and protocol-relative targets", () => {
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });
  it("falls back for empty or non-string values", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(42)).toBe("/");
  });
  it("never redirects back to the login page", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/login?next=/x")).toBe("/");
  });
  it("rejects control characters that URL parsing strips into a protocol-relative target", () => {
    expect(safeNextPath("/\t/evil.example")).toBe("/");
    expect(safeNextPath("/\n/evil.example")).toBe("/");
    expect(safeNextPath("/\r\\evil.example")).toBe("/");
    expect(safeNextPath("/x\u0000y")).toBe("/");
  });
  it("rejects dot segments that normalize into a protocol-relative target", () => {
    expect(safeNextPath("/.//evil.example")).toBe("/");
    expect(safeNextPath("/a/..//evil.example")).toBe("/");
  });
  it("keeps percent-encoded characters as a same-site path", () => {
    expect(safeNextPath("/%09/evil")).toBe("/%09/evil");
  });
  it("keeps the query string and hash", () => {
    expect(safeNextPath("/novel/1?a=b#c")).toBe("/novel/1?a=b#c");
  });
});
