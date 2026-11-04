import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { TOC_PAGE_SIZE, loadNovel, loadNovelResume, loadTocPage, pageCountFor, tocItem, type TocChapter } from "./novel";

const chapter: TocChapter = { id: "c1", index: 1, title: "Chương 1", text_hash: "h1", fetched_at: "2026-01-01", is_new: false };

describe("tocItem", () => {
  it("is audioReady only when the status is ready and the text hashes match", () => {
    expect(tocItem(chapter, { status: "ready", text_hash: "h1" }, false).audioReady).toBe(true);
  });

  it("is not audioReady when the text hashes differ", () => {
    expect(tocItem(chapter, { status: "ready", text_hash: "old" }, false).audioReady).toBe(false);
  });

  it("is not audioReady when the audio text_hash is null", () => {
    expect(tocItem(chapter, { status: "ready", text_hash: null }, false).audioReady).toBe(false);
  });

  it("is not audioReady when the chapter text_hash is null", () => {
    expect(tocItem({ ...chapter, text_hash: null }, { status: "ready", text_hash: null }, false).audioReady).toBe(false);
  });

  it("is not audioReady when the status is partial, queued or failed, or there is no audio", () => {
    for (const status of ["partial", "queued", "failed"] as const) {
      expect(tocItem(chapter, { status, text_hash: "h1" }, false).audioReady).toBe(false);
    }
    expect(tocItem(chapter, null, false).audioReady).toBe(false);
  });

  it("maps hasText, listened and isNew", () => {
    expect(tocItem(chapter, null, true)).toEqual({
      id: "c1",
      index: 1,
      title: "Chương 1",
      hasText: true,
      audioReady: false,
      listened: true,
      isNew: false,
    });
    const bare = tocItem({ ...chapter, text_hash: null, fetched_at: null, is_new: true }, null, false);
    expect(bare.hasText).toBe(false);
    expect(bare.isNew).toBe(true);
  });
});

describe("pageCountFor", () => {
  it("is at least 1 and rounds up per 100 chapters", () => {
    expect(TOC_PAGE_SIZE).toBe(100);
    expect(pageCountFor(0)).toBe(1);
    expect(pageCountFor(19)).toBe(1);
    expect(pageCountFor(100)).toBe(1);
    expect(pageCountFor(101)).toBe(2);
    expect(pageCountFor(1250)).toBe(13);
  });
});

type Row = Record<string, unknown>;
type Call = { table: string; filters: string[]; selects: string[] };

// Minimal PostgREST stand-in: eq, in, gte, lte, order, maybeSingle, rpc.
function fakeSupabase(tables: Record<string, Row[]>, rpcResult: { data: unknown; error: unknown }, calls: Call[] = []) {
  return {
    rpc: (name: string, args: unknown) => {
      calls.push({ table: `rpc:${name}`, filters: [JSON.stringify(args)], selects: [] });
      return Promise.resolve(rpcResult);
    },
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const log: string[] = [];
      let orderBy: [string, boolean][] = [];
      const selects: string[] = [];
      calls.push({ table, filters: log, selects });
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        for (const [col, asc] of [...orderBy].reverse()) {
          rows = [...rows].sort((a, b) => ((a[col] as number) < (b[col] as number) ? -1 : 1) * (asc ? 1 : -1));
        }
        return { data: rows, error: null };
      };
      const builder: Record<string, unknown> = {
        select(cols?: string) {
          selects.push(cols ?? "");
          return builder;
        },
        eq(col: string, v: unknown) {
          log.push(`eq:${col}=${String(v)}`);
          filters.push((r) => r[col] === v);
          return builder;
        },
        in(col: string, vs: unknown[]) {
          log.push(`in:${col}`);
          filters.push((r) => vs.includes(r[col]));
          return builder;
        },
        gte(col: string, v: number) {
          log.push(`gte:${col}=${v}`);
          filters.push((r) => (r[col] as number) >= v);
          return builder;
        },
        lte(col: string, v: number) {
          log.push(`lte:${col}=${v}`);
          filters.push((r) => (r[col] as number) <= v);
          return builder;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orderBy = [...orderBy, [col, o?.ascending ?? true]];
          return builder;
        },
        maybeSingle: () => {
          const res = run();
          return Promise.resolve({ data: res.data[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const NOVEL_ID = "123e4567-e89b-12d3-a456-426614174000";
const novelRow = {
  id: NOVEL_ID,
  title: "Bảo Long",
  author: "A",
  cover_url: null,
  description: "Mô tả",
  status: "ongoing",
  chapter_count: 250,
};

describe("loadNovel", () => {
  it("returns null for an unknown or foreign novel without asking for the voice hash", async () => {
    const calls: Call[] = [];
    const res = await loadNovel(fakeSupabase({ novels: [] }, { data: "abc", error: null }, calls), NOVEL_ID);
    expect(res).toBeNull();
    expect(calls.some((c) => c.table.startsWith("rpc:"))).toBe(false);
  });

  it("returns the novel and its current voice hash", async () => {
    const calls: Call[] = [];
    const res = await loadNovel(
      fakeSupabase({ novels: [novelRow] }, { data: "0123456789abcdef", error: null }, calls),
      NOVEL_ID,
    );
    expect(res).toEqual({ novel: novelRow, voiceHash: "0123456789abcdef" });
    expect(calls.find((c) => c.table === "rpc:current_voice_hash")?.filters[0]).toBe(
      JSON.stringify({ p_novel_id: NOVEL_ID }),
    );
  });

  it("throws when the voice hash lookup fails", async () => {
    await expect(
      loadNovel(fakeSupabase({ novels: [novelRow] }, { data: null, error: { message: "boom" } }), NOVEL_ID),
    ).rejects.toThrow();
  });
});

describe("loadTocPage", () => {
  const chapters: Row[] = Array.from({ length: 250 }, (_, i) => ({
    id: `c${i + 1}`,
    novel_id: NOVEL_ID,
    index: i + 1,
    title: `Chương ${i + 1}`,
    text_hash: i < 200 ? `h${i + 1}` : null,
    fetched_at: i < 200 ? "2026-01-01" : null,
    is_new: i === 249,
  }));
  // Embedded-resource filters ("chapters.index") are stored as flat keys, as in library.test.ts.
  const join = (n: number) => ({ "chapters.novel_id": NOVEL_ID, "chapters.index": n });
  const tables = {
    chapters,
    chapter_audio: [
      { chapter_id: "c101", voice_hash: "v1", status: "ready", text_hash: "h101", ...join(101) },
      { chapter_id: "c102", voice_hash: "v1", status: "ready", text_hash: "stale", ...join(102) },
      { chapter_id: "c103", voice_hash: "other", status: "ready", text_hash: "h103", ...join(103) },
      { chapter_id: "c104", voice_hash: "v1", status: "partial", text_hash: "h104", ...join(104) },
    ],
    listened_chapters: [
      { chapter_id: "c102", ...join(102) },
      { chapter_id: "c5", ...join(5) },
    ],
  };

  it("returns the 100 chapters of the page in index order with their status", async () => {
    const page = await loadTocPage(fakeSupabase(tables, { data: null, error: null }), NOVEL_ID, "v1", 2, 250);
    expect(page.page).toBe(2);
    expect(page.pageCount).toBe(3);
    expect(page.items).toHaveLength(100);
    expect(page.items[0].index).toBe(101);
    expect(page.items[99].index).toBe(200);
    const byIndex = (n: number) => page.items.find((i) => i.index === n)!;
    expect(byIndex(101).audioReady).toBe(true);
    expect(byIndex(102)).toMatchObject({ audioReady: false, listened: true });
    expect(byIndex(103).audioReady).toBe(false);
    expect(byIndex(104).audioReady).toBe(false);
    expect(byIndex(105)).toMatchObject({ audioReady: false, listened: false, hasText: true });
  });

  it("runs three range-filtered queries (chapters, audio by voice hash, listened) in parallel", async () => {
    const calls: Call[] = [];
    await loadTocPage(fakeSupabase(tables, { data: null, error: null }, calls), NOVEL_ID, "v1", 3, 250);
    expect(calls.map((c) => c.table).sort()).toEqual(["chapter_audio", "chapters", "listened_chapters"]);
    expect(calls.find((c) => c.table === "chapters")?.filters).toEqual(
      expect.arrayContaining([`eq:novel_id=${NOVEL_ID}`, "gte:index=201", "lte:index=300"]),
    );
    expect(calls.find((c) => c.table === "chapter_audio")?.filters).toEqual(
      expect.arrayContaining(["eq:voice_hash=v1", `eq:chapters.novel_id=${NOVEL_ID}`, "gte:chapters.index=201", "lte:chapters.index=300"]),
    );
    expect(calls.find((c) => c.table === "listened_chapters")?.filters).toEqual(
      expect.arrayContaining([`eq:chapters.novel_id=${NOVEL_ID}`, "gte:chapters.index=201", "lte:chapters.index=300"]),
    );
  });

  // Without !inner PostgREST only filters the embedded rows and returns every chapter's audio/listened row.
  it("selects audio and listened rows through chapters!inner so the parent rows are scoped too", async () => {
    const calls: Call[] = [];
    await loadTocPage(fakeSupabase(tables, { data: null, error: null }, calls), NOVEL_ID, "v1", 2, 250);
    for (const table of ["chapter_audio", "listened_chapters"]) {
      const call = calls.find((c) => c.table === table)!;
      expect(call.selects.join(" ")).toMatch(/chapters!inner\(/);
      expect(call.filters).toEqual(
        expect.arrayContaining([
          `eq:chapters.novel_id=${NOVEL_ID}`,
          "gte:chapters.index=101",
          "lte:chapters.index=200",
        ]),
      );
    }
    expect(calls.find((c) => c.table === "chapter_audio")!.filters).toContain("eq:voice_hash=v1");
  });

  it("returns the last page short and clamps a page past the end", async () => {
    const page = await loadTocPage(fakeSupabase(tables, { data: null, error: null }), NOVEL_ID, "v1", 9, 250);
    expect(page.page).toBe(3);
    expect(page.items).toHaveLength(50);
    expect(page.items.at(-1)).toMatchObject({ index: 250, isNew: true, hasText: false });
  });
});

describe("loadNovelResume", () => {
  it("is null without a progress row", async () => {
    expect(await loadNovelResume(fakeSupabase({}, { data: null, error: null }), NOVEL_ID)).toBeNull();
  });

  it("gives the chapter index and segment of this novel's progress", async () => {
    const progress = [
      { novel_id: "other", segment_index: 1, chapter: { index: 2 } },
      { novel_id: NOVEL_ID, segment_index: 7, chapter: { index: 12 } },
    ];
    expect(await loadNovelResume(fakeSupabase({ progress }, { data: null, error: null }), NOVEL_ID)).toEqual({
      chapterIndex: 12,
      segmentIndex: 7,
    });
  });

  it("is null when the progress chapter no longer exists", async () => {
    const progress = [{ novel_id: NOVEL_ID, segment_index: 7, chapter: null }];
    expect(await loadNovelResume(fakeSupabase({ progress }, { data: null, error: null }), NOVEL_ID)).toBeNull();
  });
});
