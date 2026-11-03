import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadLibrary, toNovelCard, type NovelRow } from "./library";

const row: NovelRow = { id: "n1", title: "Bảo Long", author: "A", cover_url: "https://x/c.jpg", chapter_count: 10 };

describe("toNovelCard", () => {
  it("maps a row with a missing cover to coverUrl null", () => {
    expect(toNovelCard({ ...row, cover_url: null }, { read: 0, new: 0 }).coverUrl).toBeNull();
    expect(toNovelCard({ ...row, cover_url: "" }, { read: 0, new: 0 }).coverUrl).toBeNull();
  });

  it("maps the basic fields", () => {
    expect(toNovelCard(row, { read: 3, new: 2 })).toEqual({
      id: "n1",
      title: "Bảo Long",
      author: "A",
      coverUrl: "https://x/c.jpg",
      chapterCount: 10,
      readChapters: 3,
      newChapters: 2,
    });
  });

  it("clamps readChapters to chapterCount and at 0", () => {
    expect(toNovelCard(row, { read: 25, new: 0 }).readChapters).toBe(10);
    expect(toNovelCard(row, { read: -1, new: 0 }).readChapters).toBe(0);
  });
});

// A minimal in-memory stand-in for the PostgREST query builder: equality filters, order, limit and head counts.
type Row = Record<string, unknown>;
function fakeSupabase(tables: Record<string, Row[]>, calls: string[] = []): SupabaseClient {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let orderBy: [string, boolean][] = [];
      let max = Infinity;
      let head = false;
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        for (const [col, asc] of [...orderBy].reverse()) {
          rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        const count = rows.length;
        return { data: head ? null : rows.slice(0, max), count: head ? count : null, error: null };
      };
      const builder: Record<string, unknown> = {
        select(_cols: string, opts?: { head?: boolean }) {
          head = opts?.head === true;
          calls.push(`${table}:select${head ? ":head" : ""}`);
          return builder;
        },
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          return builder;
        },
        in(col: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[col]));
          return builder;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orderBy = [...orderBy, [col, o?.ascending ?? true]];
          return builder;
        },
        limit(n: number) {
          max = n;
          return builder;
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const novels: Row[] = [
  { id: "a", title: "A", author: null, cover_url: null, chapter_count: 3, created_at: "2026-01-01" },
  { id: "b", title: "B", author: "x", cover_url: null, chapter_count: 5, created_at: "2026-01-02" },
  { id: "c", title: "C", author: "y", cover_url: null, chapter_count: 0, created_at: "2026-01-03" },
];

describe("loadLibrary", () => {
  it("returns an empty library for a new account", async () => {
    const lib = await loadLibrary(fakeSupabase({}));
    expect(lib).toEqual({ resume: null, novels: [], recent: [], pendingJobs: [] });
  });

  it("orders novels by last progress, then newest first, and recent by created_at", async () => {
    const lib = await loadLibrary(
      fakeSupabase({
        novels,
        progress: [
          { novel_id: "a", chapter_id: "ca", segment_index: 4, updated_at: "2026-02-02", chapter: { index: 2, title: "T2" } },
        ],
      }),
    );
    expect(lib.novels.map((n) => n.id)).toEqual(["a", "c", "b"]);
    expect(lib.recent.map((n) => n.id)).toEqual(["c", "b", "a"]);
  });

  it("builds the resume item from the newest progress row", async () => {
    const lib = await loadLibrary(
      fakeSupabase({
        novels,
        progress: [
          { novel_id: "a", chapter_id: "ca", segment_index: 4, updated_at: "2026-02-01", chapter: { index: 2, title: "Cũ" } },
          { novel_id: "b", chapter_id: "cb", segment_index: 7, updated_at: "2026-02-03", chapter: { index: 9, title: "Mới" } },
        ],
      }),
    );
    expect(lib.resume).toEqual({ novelId: "b", novelTitle: "B", chapterIndex: 9, chapterTitle: "Mới", segmentIndex: 7 });
  });

  it("counts only is_new chapters and only this novel's listened chapters", async () => {
    const lib = await loadLibrary(
      fakeSupabase({
        novels: [novels[1]],
        chapters: [
          { novel_id: "b", is_new: true },
          { novel_id: "b", is_new: true },
          { novel_id: "b", is_new: false },
          { novel_id: "z", is_new: true },
        ],
        listened_chapters: [
          { "chapters.novel_id": "b" },
          { "chapters.novel_id": "b" },
          { "chapters.novel_id": "z" },
        ],
      }),
    );
    expect(lib.novels[0]).toMatchObject({ id: "b", newChapters: 2, readChapters: 2 });
  });

  it("lists only unfinished fetch_novel jobs, newest first, at most 10", async () => {
    const jobs: Row[] = Array.from({ length: 12 }, (_, i) => ({
      id: `j${i}`,
      type: "fetch_novel",
      status: "queued",
      error: null,
      priority: 0,
      created_at: `2026-03-${String(i + 10).padStart(2, "0")}`,
      url: null,
    }));
    const lib = await loadLibrary(fakeSupabase({ jobs }));
    expect(lib.pendingJobs).toHaveLength(10);
    expect(lib.pendingJobs[0].id).toBe("j11");
  });

  it("does not fetch chapter rows", async () => {
    const calls: string[] = [];
    await loadLibrary(fakeSupabase({ novels }, calls));
    expect(calls.filter((c) => c.startsWith("chapters:") && !c.endsWith(":head"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("listened_chapters:") && !c.endsWith(":head"))).toEqual([]);
  });
});
