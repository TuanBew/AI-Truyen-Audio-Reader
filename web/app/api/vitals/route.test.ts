import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "session-user" as string | null,
  rpc: { data: 3 as unknown, error: null as unknown },
  calls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  getUserId: async () => state.userId,
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      return state.rpc;
    },
  }),
}));

import { POST } from "./route";

const sample = { name: "LCP", value: 1234.5, rating: "good", route: "/" };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new NextRequest("http://localhost:3000/api/vitals", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.userId = "session-user";
  state.rpc = { data: 3, error: null };
  state.calls = [];
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/vitals", () => {
  it("answers 204 and passes the samples to record_web_vitals", async () => {
    const res = await post([sample]);
    expect(res.status).toBe(204);
    expect(state.calls).toEqual([{ fn: "record_web_vitals", args: { p_samples: [sample] } }]);
  });

  it("answers 204 when the rate limit stored nothing", async () => {
    state.rpc = { data: 0, error: null };
    expect((await post([sample])).status).toBe(204);
  });

  it("401 without a session", async () => {
    state.userId = null;
    expect((await post([sample])).status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it("403 on a foreign Origin", async () => {
    expect((await post([sample], { origin: "https://evil.example" })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("accepts the same Origin", async () => {
    expect((await post([sample], { origin: "http://localhost:3000" })).status).toBe(204);
  });

  it.each([
    ["not json", "{nope"],
    ["not an array", { name: "LCP" }],
    ["empty array", []],
    ["more than 10 items", Array.from({ length: 11 }, () => sample)],
    ["unknown metric", [{ ...sample, name: "FID" }]],
    ["negative value", [{ ...sample, value: -1 }]],
    ["bad rating", [{ ...sample, rating: "meh" }]],
    ["empty route", [{ ...sample, route: "" }]],
    ["long route", [{ ...sample, route: "/" + "a".repeat(200) }]],
  ])("400 for %s", async (_label, body) => {
    expect((await post(body)).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("accepts exactly 10 items and a missing rating", async () => {
    const batch = Array.from({ length: 10 }, () => ({ name: "CLS", value: 0.01, route: "/" }));
    expect((await post(batch)).status).toBe(204);
  });

  it("500 with Vietnamese copy and a server log on an RPC error", async () => {
    state.rpc = { data: null, error: { message: "boom" } };
    const res = await post([sample]);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/[ạảãàáâăêôơưđ]/i);
    expect(JSON.stringify(json)).not.toContain("boom");
    expect(errorLog).toHaveBeenCalled();
  });
});
