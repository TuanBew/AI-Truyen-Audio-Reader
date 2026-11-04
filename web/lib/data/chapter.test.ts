import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  CONNECT_ERROR,
  TEXT_POLL_START_MS,
  WORKER_OFFLINE_MS,
  enqueueFetchChapter,
  fetchFailedText,
  isWorkerOffline,
  loadFetchJob,
  loadReaderChapter,
  neighbours,
  requestChapterError,
  requestSafely,
} from "./chapter";
import { POLL_START_MS, nextPollDelay } from "./pending-jobs";

describe("neighbours", () => {
  it("has no previous chapter at the start and no next one at the end", () => {
    expect(neighbours(1, 19)).toEqual({ prevIndex: null, nextIndex: 2 });
    expect(neighbours(19, 19)).toEqual({ prevIndex: 18, nextIndex: null });
  });

  it("links both ways in the middle", () => {
    expect(neighbours(5, 19)).toEqual({ prevIndex: 4, nextIndex: 6 });
  });

  it("has no neighbours for a single-chapter novel", () => {
    expect(neighbours(1, 1)).toEqual({ prevIndex: null, nextIndex: null });
  });
});

describe("isWorkerOffline", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");

  it("is offline without a row", () => {
    expect(isWorkerOffline(null, now)).toBe(true);
  });

  it("is online for a heartbeat within 60 s and offline after", () => {
    expect(WORKER_OFFLINE_MS).toBe(60_000);
    expect(isWorkerOffline("2026-11-03T09:59:30Z", now)).toBe(false);
    expect(isWorkerOffline("2026-11-03T09:59:00Z", now)).toBe(false);
    expect(isWorkerOffline("2026-11-03T09:58:59Z", now)).toBe(true);
  });

  it("treats an unparsable timestamp as offline", () => {
    expect(isWorkerOffline("not a date", now)).toBe(true);
  });
});

describe("TEXT_POLL_START_MS", () => {
  it("starts faster than the library poll and doubles up to its cap", () => {
    expect(TEXT_POLL_START_MS).toBe(2000);
    expect(TEXT_POLL_START_MS).toBeLessThan(POLL_START_MS);
    expect(nextPollDelay(TEXT_POLL_START_MS)).toBe(4000);
  });
});

describe("fetchFailedText", () => {
  it("shows the worker's message, bounded, or a default", () => {
    expect(fetchFailedText("Nguồn trả về lỗi 404.")).toBe("Không tải được chương: Nguồn trả về lỗi 404.");
    expect(fetchFailedText(null)).toBe("Không tải được chương.");
    expect(fetchFailedText("  ")).toBe("Không tải được chương.");
    expect(fetchFailedText("x".repeat(400)).length).toBeLessThan(340);
  });
});

describe("requestChapterError", () => {
  it("maps the queue cap and falls back to the generic copy", () => {
    expect(requestChapterError({ code: "54000", message: "jobs: queue limit reached (500 queued jobs)" })).toContain(
      "Hàng chờ đã đầy",
    );
    expect(requestChapterError({ code: "XX000", message: "boom" })).toBe(
      "Không yêu cầu được tải chương. Thử lại sau ít phút.",
    );
  });
});

type Row = Record<string, unknown>;
type Call = { table: string; ops: string[] };
type FakeOpts = {
  rpc?: { data: unknown; error: { code?: string; message: string } | null };
  insertError?: { code: string; message: string };
  // Consumed one per insert (null = the insert succeeds); replaces insertError when given.
  insertErrors?: ({ code: string; message: string } | null)[];
};

// Minimal PostgREST stand-in: select, eq, in, order, limit, maybeSingle, insert(...).select().single(), rpc.
function fakeSupabase(tables: Record<string, Row[]>, opts: FakeOpts = {}, calls: Call[] = []) {
  const rpcResult = opts.rpc ?? { data: "voice-hash-1", error: null };
  const errors = opts.insertErrors ? [...opts.insertErrors] : null;
  const nextInsertError = () => (errors ? (errors.shift() ?? null) : (opts.insertError ?? null));
  const get = (r: Row, col: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? (r[m[1]] as Row | undefined)?.[m[2]] : r[col];
  };
  return {
    rpc: (name: string, args: unknown) => {
      calls.push({ table: `rpc:${name}`, ops: [JSON.stringify(args)] });
      return Promise.resolve(rpcResult);
    },
    from(table: string) {
      const ops: string[] = [];
      calls.push({ table, ops });
      const filters: ((r: Row) => boolean)[] = [];
      let order: [string, boolean] | null = null;
      let max = Infinity;
      let inserted: Row | null = null;
      let insertError: { code: string; message: string } | null = null;
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) {
          const [col, asc] = order;
          rows = [...rows].sort(
            (a, b) => ((get(a, col) as string) < (get(b, col) as string) ? -1 : 1) * (asc ? 1 : -1),
          );
        }
        return rows.slice(0, max);
      };
      const builder: Record<string, unknown> = {
        select: (cols?: string) => {
          ops.push(`select:${cols ?? ""}`);
          return builder;
        },
        eq: (col: string, v: unknown) => {
          ops.push(`eq:${col}=${String(v)}`);
          filters.push((r) => get(r, col) === v);
          return builder;
        },
        in: (col: string, vs: unknown[]) => {
          ops.push(`in:${col}=${vs.join("|")}`);
          filters.push((r) => vs.includes(get(r, col)));
          return builder;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          ops.push(`order:${col}`);
          order = [col, o?.ascending ?? true];
          return builder;
        },
        limit: (n: number) => {
          max = n;
          return builder;
        },
        insert: (row: Row) => {
          ops.push(`insert:${JSON.stringify(row)}`);
          insertError = nextInsertError();
          if (!insertError) {
            inserted = { id: "new-job", status: "queued", error: null, created_at: "2026-11-03T10:00:00Z", ...row };
            (tables[table] ??= []).push(inserted);
          }
          return builder;
        },
        single: () =>
          Promise.resolve(insertError ? { data: null, error: insertError } : { data: inserted, error: null }),
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const NOVEL_ID = "123e4567-e89b-12d3-a456-426614174000";
const CHAPTER_ID = "223e4567-e89b-12d3-a456-426614174000";
const USER_ID = "323e4567-e89b-12d3-a456-426614174000";
const segments = [
  { i: 0, kind: "narration", src: [0, 7], p: 0, pe: false },
  { i: 1, kind: "dialogue", src: [9, 16], p: 1, pe: false },
];

function baseTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    novels: [{ id: NOVEL_ID, title: "Bảo Long", chapter_count: 19 }],
    chapters: [{ id: CHAPTER_ID, novel_id: NOVEL_ID, index: 5, title: "Chương 5", text: "Mở đầu.", text_hash: "h5" }],
    worker_status: [
      { worker_id: "w1", last_seen: "2026-11-03T09:00:00Z" },
      { worker_id: "w2", last_seen: "2026-11-03T09:30:00Z" },
    ],
    progress: [],
    chapter_analysis: [
      { chapter_id: CHAPTER_ID, text_hash: "h5", created_at: "2026-11-01", segments: [] },
      { chapter_id: CHAPTER_ID, text_hash: "h5", created_at: "2026-11-02", segments },
      { chapter_id: CHAPTER_ID, text_hash: "old", created_at: "2026-11-03", segments: [segments[0]] },
    ],
    ...overrides,
  };
}

describe("loadReaderChapter", () => {
  it("returns null for an unknown or foreign novel even when the voice hash lookup raises", async () => {
    const res = await loadReaderChapter(
      fakeSupabase(baseTables({ novels: [], chapters: [] }), {
        rpc: { data: null, error: { code: "P0002", message: "novel not found" } },
      }),
      NOVEL_ID,
      5,
    );
    expect(res).toBeNull();
  });

  it("returns null for a chapter that does not exist", async () => {
    expect(await loadReaderChapter(fakeSupabase(baseTables()), NOVEL_ID, 99999)).toBeNull();
  });

  it("throws on a voice hash failure for a novel that exists", async () => {
    await expect(
      loadReaderChapter(
        fakeSupabase(baseTables(), { rpc: { data: null, error: { code: "XX000", message: "boom" } } }),
        NOVEL_ID,
        5,
      ),
    ).rejects.toThrow();
  });

  it("returns the chapter with the newest analysis for its current text hash and the neighbours", async () => {
    const res = await loadReaderChapter(fakeSupabase(baseTables()), NOVEL_ID, 5);
    expect(res).not.toBeNull();
    expect(res!.novel).toEqual({ id: NOVEL_ID, title: "Bảo Long", chapterCount: 19 });
    expect(res!.chapter).toEqual({ id: CHAPTER_ID, index: 5, title: "Chương 5", textHash: "h5", text: "Mở đầu." });
    expect(res!.segments).toEqual(segments);
    expect(res!.prevIndex).toBe(4);
    expect(res!.nextIndex).toBe(6);
    expect(res!.resumeSegment).toBeNull();
    expect(res!.snapshot).toEqual({
      chapterId: CHAPTER_ID,
      voiceHash: "voice-hash-1",
      chapterTextHash: "h5",
      audio: null,
      job: null,
      queuePosition: null,
      workerLastSeen: "2026-11-03T09:30:00Z",
    });
  });

  it("has a null heartbeat without a worker_status row", async () => {
    const none = await loadReaderChapter(fakeSupabase(baseTables({ worker_status: [] })), NOVEL_ID, 5);
    expect(none!.snapshot.workerLastSeen).toBeNull();
  });

  it("gives no segments and skips the analysis query while the text is not fetched", async () => {
    const calls: Call[] = [];
    const tables = baseTables({
      chapters: [{ id: CHAPTER_ID, novel_id: NOVEL_ID, index: 5, title: "Chương 5", text: null, text_hash: null }],
    });
    const res = await loadReaderChapter(fakeSupabase(tables, {}, calls), NOVEL_ID, 5);
    expect(res!.chapter.text).toBeNull();
    expect(res!.chapter.textHash).toBeNull();
    expect(res!.segments).toEqual([]);
    expect(calls.some((c) => c.table === "chapter_analysis")).toBe(false);
  });

  it("asks for analysis by chapter id and text hash only", async () => {
    const calls: Call[] = [];
    await loadReaderChapter(fakeSupabase(baseTables(), {}, calls), NOVEL_ID, 5);
    const analysis = calls.find((c) => c.table === "chapter_analysis")!;
    expect(analysis.ops).toContain(`eq:chapter_id=${CHAPTER_ID}`);
    expect(analysis.ops).toContain("eq:text_hash=h5");
  });

  it("drops malformed stored segments", async () => {
    const tables = baseTables({
      chapter_analysis: [
        {
          chapter_id: CHAPTER_ID,
          text_hash: "h5",
          created_at: "2026-11-02",
          segments: [segments[0], { i: "x" }, null, 7],
        },
      ],
    });
    const res = await loadReaderChapter(fakeSupabase(tables), NOVEL_ID, 5);
    expect(res!.segments).toEqual([segments[0]]);
  });

  it("sets resumeSegment only when the progress row is for this chapter", async () => {
    const mine = baseTables({ progress: [{ novel_id: NOVEL_ID, chapter_id: CHAPTER_ID, segment_index: 12 }] });
    expect((await loadReaderChapter(fakeSupabase(mine), NOVEL_ID, 5))!.resumeSegment).toBe(12);
    const other = baseTables({ progress: [{ novel_id: NOVEL_ID, chapter_id: "other", segment_index: 12 }] });
    expect((await loadReaderChapter(fakeSupabase(other), NOVEL_ID, 5))!.resumeSegment).toBeNull();
  });
});

const job = (id: string, status: string, created_at: string): Row => ({
  id,
  user_id: USER_ID,
  type: "fetch_chapter",
  payload: { chapter_id: CHAPTER_ID },
  status,
  error: null,
  priority: 0,
  created_at,
});

describe("loadFetchJob", () => {
  it("returns the newest fetch_chapter job for the chapter", async () => {
    const tables = {
      jobs: [
        job("a", "failed", "2026-11-01"),
        job("b", "running", "2026-11-02"),
        { ...job("c", "queued", "2026-11-03"), payload: { chapter_id: "other" } },
        { ...job("d", "queued", "2026-11-04"), type: "synthesize" },
      ],
    };
    const res = await loadFetchJob(fakeSupabase(tables), USER_ID, CHAPTER_ID);
    expect(res?.id).toBe("b");
  });

  it("returns null without a job", async () => {
    expect(await loadFetchJob(fakeSupabase({ jobs: [] }), USER_ID, CHAPTER_ID)).toBeNull();
  });
});

describe("enqueueFetchChapter", () => {
  it("returns the active job instead of inserting another", async () => {
    const calls: Call[] = [];
    const res = await enqueueFetchChapter(
      fakeSupabase({ jobs: [job("live-job", "running", "2026-11-02")] }, {}, calls),
      USER_ID,
      CHAPTER_ID,
    );
    expect(res).toMatchObject({ error: null, job: { id: "live-job" } });
    expect(calls.some((c) => c.ops.some((o) => o.startsWith("insert:")))).toBe(false);
  });

  it("inserts a priority 0 fetch_chapter job when none is active (a failed one does not count)", async () => {
    const calls: Call[] = [];
    const res = await enqueueFetchChapter(
      fakeSupabase({ jobs: [job("old", "failed", "2026-11-02")] }, {}, calls),
      USER_ID,
      CHAPTER_ID,
    );
    expect(res.error).toBeNull();
    const insert = calls.flatMap((c) => c.ops).find((o) => o.startsWith("insert:"))!;
    expect(JSON.parse(insert.slice("insert:".length))).toEqual({
      type: "fetch_chapter",
      payload: { chapter_id: CHAPTER_ID },
      priority: 0,
      user_id: USER_ID,
    });
  });

  it("on 23505 returns the job another request just created", async () => {
    // The first lookup (before the insert) sees nothing; by the second lookup the racing job exists.
    const tables: Record<string, Row[]> = { jobs: [] };
    const client = fakeSupabase(tables, { insertError: { code: "23505", message: "duplicate key" } });
    const realFrom = (client as unknown as { from: (t: string) => unknown }).from.bind(client);
    let lookups = 0;
    (client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "jobs" && lookups++ === 2) tables.jobs.push(job("live-job", "queued", "2026-11-02"));
      return realFrom(t);
    };
    const res = await enqueueFetchChapter(client, USER_ID, CHAPTER_ID);
    expect(res).toMatchObject({ error: null, job: { id: "live-job" } });
  });

  it("on 23505 with nothing found (the job finished meanwhile) retries the insert once", async () => {
    const calls: Call[] = [];
    const res = await enqueueFetchChapter(
      fakeSupabase({ jobs: [] }, { insertErrors: [{ code: "23505", message: "duplicate key" }, null] }, calls),
      USER_ID,
      CHAPTER_ID,
    );
    expect(res).toMatchObject({ error: null, job: { id: "new-job" } });
    expect(calls.flatMap((c) => c.ops).filter((o) => o.startsWith("insert:"))).toHaveLength(2);
  });

  it("gives the generic error when the retried insert also hits 23505 with nothing found", async () => {
    const calls: Call[] = [];
    const res = await enqueueFetchChapter(
      fakeSupabase({ jobs: [] }, { insertError: { code: "23505", message: "duplicate key" } }, calls),
      USER_ID,
      CHAPTER_ID,
    );
    expect(res).toEqual({ job: null, error: "Không yêu cầu được tải chương. Thử lại sau ít phút." });
    expect(calls.flatMap((c) => c.ops).filter((o) => o.startsWith("insert:"))).toHaveLength(2);
  });

  it("maps other insert errors to Vietnamese copy", async () => {
    const res = await enqueueFetchChapter(
      fakeSupabase({ jobs: [] }, { insertError: { code: "42501", message: "permission denied" } }),
      USER_ID,
      CHAPTER_ID,
    );
    expect(res).toEqual({ job: null, error: "Không yêu cầu được tải chương. Thử lại sau ít phút." });
  });
});

describe("requestSafely", () => {
  it("passes a result through", async () => {
    const ok = { job: null, error: "x" } as const;
    expect(await requestSafely(async () => ok, CHAPTER_ID)).toBe(ok);
  });

  it("turns a rejected server action into the connection error instead of throwing", async () => {
    const res = await requestSafely(() => Promise.reject(new Error("Failed to fetch")), CHAPTER_ID);
    expect(res).toEqual({ job: null, error: CONNECT_ERROR });
    expect(CONNECT_ERROR).toBe("Không kết nối được máy chủ. Kiểm tra mạng rồi bấm Thử lại.");
  });
});
