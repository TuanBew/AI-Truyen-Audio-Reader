import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "session-user" as string | null,
  chapter: { data: { id: "x" } as unknown, error: null as unknown },
  upsertError: {} as Record<string, unknown>, // per table
  upserts: [] as { table: string; row: Record<string, unknown>; opts: unknown }[],
  chapterQuery: [] as [string, unknown][],
}));

vi.mock("@/lib/supabase/server", () => ({
  getUserId: async () => state.userId,
  createClient: async () => ({
    from: (table: string) => ({
      select: () => {
        const q = {
          eq: (col: string, val: unknown) => {
            state.chapterQuery.push([col, val]);
            return q;
          },
          maybeSingle: async () => state.chapter,
        };
        return q;
      },
      upsert: async (row: Record<string, unknown>, opts: unknown) => {
        state.upserts.push({ table, row, opts });
        return { error: state.upsertError[table] ?? null };
      },
    }),
  }),
}));

import { POST } from "./route";

const N = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const good = { novelId: N, chapterId: C, segmentIndex: 4, positionMs: 1234 };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new NextRequest("http://localhost:3000/api/progress", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.userId = "session-user";
  state.chapter = { data: { id: C }, error: null };
  state.upsertError = {};
  state.upserts = [];
  state.chapterQuery = [];
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/progress", () => {
  it("401 without a session, and nothing is written", async () => {
    state.userId = null;
    const res = await post(good);
    expect(res.status).toBe(401);
    expect(state.upserts).toHaveLength(0);
  });

  it("rejects a cross-site Origin and Origin: null (403), allows the same origin", async () => {
    expect((await post(good, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(good, { origin: "null" })).status).toBe(403);
    expect((await post(good, { origin: "not a url" })).status).toBe(403);
    expect(state.upserts).toHaveLength(0);
    expect((await post(good, { origin: "http://localhost:3000" })).status).toBe(204);
  });

  it("400 for non-JSON text and for a bad body", async () => {
    expect((await post("hello")).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect((await post({ ...good, positionMs: -1 })).status).toBe(400);
    expect((await post({ ...good, chapterId: "nope" })).status).toBe(400);
    expect((await post({ novelId: N })).status).toBe(400);
    expect(state.upserts).toHaveLength(0);
  });

  it("accepts application/json as well as the beacon text/plain", async () => {
    expect((await post(good, { "content-type": "application/json" })).status).toBe(204);
  });

  it("404 when the chapter is not found for that novel (unknown id, or a chapter of another novel), no upsert", async () => {
    state.chapter = { data: null, error: null };
    const res = await post(good);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Không tìm thấy chương này.");
    expect(state.upserts).toHaveLength(0);
    // The lookup is scoped by both ids.
    expect(state.chapterQuery).toEqual([
      ["id", C],
      ["novel_id", N],
    ]);
  });

  it("404 when the foreign key fails after the read (23503)", async () => {
    state.upsertError = { progress: { code: "23503", message: "violates foreign key" } };
    const res = await post(good);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Không tìm thấy chương này.");
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("204 and exactly one progress upsert without finished", async () => {
    const res = await post(good);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      table: "progress",
      row: { user_id: "session-user", novel_id: N, chapter_id: C, segment_index: 4, position_ms: 1234 },
      opts: { onConflict: "user_id,novel_id" },
    });
  });

  it("finished upserts progress and listened_chapters, with user_id from the session even if the body has one", async () => {
    const res = await post({ ...good, finished: true, user_id: "attacker", userId: "attacker" });
    expect(res.status).toBe(204);
    expect(state.upserts.map((u) => u.table).sort()).toEqual(["listened_chapters", "progress"]);
    for (const u of state.upserts) expect(u.row.user_id).toBe("session-user");
    expect(state.upserts.find((u) => u.table === "listened_chapters")).toMatchObject({
      row: { chapter_id: C },
      opts: { onConflict: "user_id,chapter_id" },
    });
  });

  it.each(["progress", "listened_chapters"])("500 without a raw error when the %s upsert fails", async (table) => {
    state.upsertError = { [table]: { code: "XX000", message: "secret internal detail" } };
    const res = await post({ ...good, finished: true });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
    expect(JSON.parse(text).error).toBe("Không lưu được tiến độ nghe. Thử lại sau ít phút.");
    expect(errorLog).toHaveBeenCalled(); // logged server side
  });

  it("500 when the chapter lookup itself fails", async () => {
    state.chapter = { data: null, error: { code: "XX000", message: "boom" } };
    const res = await post(good);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("boom");
    expect(state.upserts).toHaveLength(0);
  });
});
