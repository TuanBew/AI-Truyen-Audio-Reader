import { describe, expect, it } from "vitest";
import { authDecision, isNextInternalPath, isPublicPath, safeNextPath } from "./paths";

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

describe("authDecision", () => {
  it("answers API calls without a session with unauthorized", () => {
    expect(authDecision("/api/progress", false)).toBe("unauthorized");
  });
  it("lets signed-in API calls through", () => {
    expect(authDecision("/api/audio/x/urls", true)).toBe("next");
  });
  it("sends signed-out visitors of private pages to the login page", () => {
    expect(authDecision("/", false)).toBe("login");
  });
  it("sends signed-in visitors of the login page home", () => {
    expect(authDecision("/login", true)).toBe("home");
  });
  it("lets signed-out visitors open the login page", () => {
    expect(authDecision("/login", false)).toBe("next");
  });
  it("lets signed-in visitors open private pages", () => {
    expect(authDecision("/read/a/1", true)).toBe("next");
  });
  it("does not treat lookalike paths as API paths", () => {
    expect(authDecision("/apiary", false)).toBe("login");
  });
});

describe("Next.js internals", () => {
  it("recognises only the /_next/ prefix", () => {
    expect(isNextInternalPath("/_next/hmr")).toBe(true);
    expect(isNextInternalPath("/_next/static/chunks/a.js")).toBe(true);
    expect(isNextInternalPath("/_next")).toBe(false);
    expect(isNextInternalPath("/_nextfoo")).toBe(false);
    expect(isNextInternalPath("/api/_next/x")).toBe(false);
  });
  it("lets signed-out requests reach /_next/* (HMR socket) but not app or api routes", () => {
    expect(authDecision("/_next/hmr", false)).toBe("next");
    expect(authDecision("/_next/hmr", true)).toBe("next");
    expect(authDecision("/", false)).toBe("login");
    expect(authDecision("/_nextfoo", false)).toBe("login");
    expect(authDecision("/api/audio-urls", false)).toBe("unauthorized");
  });
});
