import { describe, expect, it } from "vitest";
import { VITAL_NAMES, vitalsRoute } from "./route-pattern";

const ID = "11111111-1111-4111-8111-111111111111";

describe("vitalsRoute", () => {
  it("keeps the library path", () => {
    expect(vitalsRoute("/")).toBe("/");
  });
  it("collapses the novel id", () => {
    expect(vitalsRoute(`/novel/${ID}`)).toBe("/novel/[id]");
    expect(vitalsRoute(`/novel/${ID}/toi`)).toBe("/novel/[id]/toi");
  });
  it("collapses the reader params", () => {
    expect(vitalsRoute(`/read/${ID}/12`)).toBe("/read/[novelId]/[chapterIndex]");
  });
  it("never keeps an id for an unknown path", () => {
    expect(vitalsRoute(`/other/${ID}`)).toBe("/other/[…]");
    expect(vitalsRoute("/cai-dat")).toBe("/cai-dat");
  });
  it("drops a trailing slash", () => {
    expect(vitalsRoute(`/novel/${ID}/`)).toBe("/novel/[id]");
  });
  it("skips the login page", () => {
    expect(vitalsRoute("/login")).toBeNull();
  });
});

describe("VITAL_NAMES", () => {
  it("matches the table check", () => {
    expect([...VITAL_NAMES].sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
  });
});
