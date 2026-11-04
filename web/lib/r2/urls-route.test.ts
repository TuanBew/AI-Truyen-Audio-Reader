import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  rpc: { data: true as boolean | null, error: null as unknown },
  row: null as unknown,
  rpcCalls: 0,
  r2Configured: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  getUserId: async () => state.userId,
  createClient: async () => ({
    rpc: async () => {
      state.rpcCalls++;
      return state.rpc;
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }) }),
    }),
  }),
}));
vi.mock("@/lib/env.server", () => ({
  getR2ReadEnv: () => {
    if (!state.r2Configured) throw new Error("Missing or invalid R2 environment variable(s): R2_BUCKET");
    return {
      accountId: "local",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      bucket: "b",
      endpoint: "http://127.0.0.1:54321/storage/v1/s3",
      region: "local",
    };
  },
}));

import { GET } from "../../app/api/audio/[chapterAudioId]/urls/route";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const base = "audio/11111111-2222-3333-4444-555555555555/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/0123456789abcdef/1";
const call = (id = ID) =>
  GET(new Request("http://localhost/api/audio/x/urls") as never, { params: Promise.resolve({ chapterAudioId: id }) });

beforeEach(() => {
  state.userId = "user-1";
  state.rpc = { data: true, error: null };
  state.rpcCalls = 0;
  state.r2Configured = true;
  state.row = {
    id: ID,
    attempt: 1,
    status: "ready",
    init_key: `${base}/init.webm`,
    chunks: [{ key: `${base}/seg-0000.webm`, start_ms: 0, end_ms: 1000 }],
    full_key: null,
    duration_ms: 1000,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/audio/[id]/urls", () => {
  it("answers 401 without a session, before touching the rate limiter", async () => {
    state.userId = null;
    expect((await call()).status).toBe(401);
    expect(state.rpcCalls).toBe(0);
  });

  it("answers 400 for a bad uuid, before the rate limiter", async () => {
    expect((await call("nope")).status).toBe(400);
    expect(state.rpcCalls).toBe(0);
  });

  it("answers 429 when the limiter says no", async () => {
    state.rpc = { data: false, error: null };
    const res = await call();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Tải âm thanh quá nhanh. Đợi một phút rồi thử lại.");
  });

  it("fails closed with 503 when the limiter errors, signing nothing", async () => {
    state.rpc = { data: null, error: { message: "boom" } };
    const res = await call();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("X-Amz");
  });

  it("answers 503 with Vietnamese copy when R2 is not configured", async () => {
    state.r2Configured = false;
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Chưa cấu hình kho âm thanh.");
  });

  it("answers 404 when the row is not visible", async () => {
    state.row = null;
    expect((await call()).status).toBe(404);
  });

  it("returns a private, no-store manifest", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.chunks).toHaveLength(1);
    expect(body.init).toContain("X-Amz-Signature=");
  });
});
