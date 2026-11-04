import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  CHAPTER_NOT_FOUND,
  ENQUEUE_FAILED,
  NO_TEXT_TO_SPEAK,
  QUEUE_FULL,
  ensureAudio,
  loadAudioSnapshot,
  loadAudioState,
  prefetchNext,
  retryJob,
} from "./audio";

type Row = Record<string, unknown>;
type Call = { table: string; ops: string[] };
type DbErr = { code: string; message: string };

const NOVEL = "123e4567-e89b-12d3-a456-426614174000";
const USER = "323e4567-e89b-12d3-a456-426614174000";
const cid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

// PostgREST stand-in: select/eq/in/gte/lte/or/order/limit/maybeSingle/head count, insert/update, rpc.
function fakeSupabase(
  tables: Record<string, Row[]>,
  opts: { insertErrors?: (DbErr | null)[]; updateError?: DbErr } = {},
  calls: Call[] = [],
) {
  const insertErrors = [...(opts.insertErrors ?? [])];
  const get = (r: Row, col: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? (r[m[1]] as Row | undefined)?.[m[2]] : r[col];
  };
  // Understands the one or() shape queuePosition uses: priority.lt.P,and(priority.eq.P,created_at.lt.T)
  const orFilter = (expr: string) => {
    const m = /^priority\.lt\.(\d+),and\(priority\.eq\.(\d+),created_at\.lt\.(.+)\)$/.exec(expr);
    if (!m) throw new Error(`fake: unsupported or(): ${expr}`);
    return (r: Row) =>
      (r.priority as number) < Number(m[1]) || (r.priority === Number(m[2]) && (r.created_at as string) < m[3]);
  };
  return {
    rpc: (name: string, args: unknown) => {
      calls.push({ table: `rpc:${name}`, ops: [JSON.stringify(args)] });
      return Promise.resolve({ data: "voice-1", error: null });
    },
    from(table: string) {
      const ops: string[] = [];
      calls.push({ table, ops });
      const filters: ((r: Row) => boolean)[] = [];
      let order: [string, boolean] | null = null;
      let max = Infinity;
      let head = false;
      let mode: "select" | "insert" | "update" = "select";
      let patch: Row = {};
      let inserted: Row | null = null;
      let writeError: DbErr | null = null;
      const matching = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const run = () => {
        let rows = matching();
        if (order) {
          const [col, asc] = order;
          rows = [...rows].sort(
            (a, b) => ((get(a, col) as string) < (get(b, col) as string) ? -1 : 1) * (asc ? 1 : -1),
          );
        }
        return rows.slice(0, max);
      };
      const result = () => {
        if (mode === "update") {
          writeError = opts.updateError ?? null;
          if (!writeError) matching().forEach((r) => Object.assign(r, patch));
          return { data: null, error: writeError };
        }
        if (mode === "insert") return { data: inserted, error: writeError };
        const rows = run();
        return head ? { data: null, count: rows.length, error: null } : { data: rows, error: null };
      };
      const builder: Record<string, unknown> = {
        select: (cols?: string, o?: { head?: boolean }) => {
          ops.push(`select:${cols ?? ""}`);
          head = o?.head ?? false;
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
        gte: (col: string, v: number) => {
          ops.push(`gte:${col}=${v}`);
          filters.push((r) => (r[col] as number) >= v);
          return builder;
        },
        lte: (col: string, v: number) => {
          ops.push(`lte:${col}=${v}`);
          filters.push((r) => (r[col] as number) <= v);
          return builder;
        },
        or: (expr: string) => {
          ops.push(`or:${expr}`);
          filters.push(orFilter(expr));
          return builder;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          order = [col, o?.ascending ?? true];
          return builder;
        },
        limit: (n: number) => {
          ops.push(`limit:${n}`);
          max = n;
          return builder;
        },
        insert: (row: Row) => {
          mode = "insert";
          ops.push(`insert:${JSON.stringify(row)}`);
          writeError = insertErrors.length ? (insertErrors.shift() ?? null) : null;
          if (!writeError) {
            inserted = {
              id: `new-${(tables[table] ??= []).length}`,
              status: "queued",
              error: null,
              created_at: "2026-11-03T10:00:00Z",
              ...row,
            };
            tables[table].push(inserted);
          }
          return builder;
        },
        update: (row: Row) => {
          mode = "update";
          patch = row;
          ops.push(`update:${JSON.stringify(row)}`);
          return builder;
        },
        single: () => Promise.resolve(result()),
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const inserts = (calls: Call[]) =>
  calls
    .flatMap((c) => c.ops)
    .filter((o) => o.startsWith("insert:"))
    .map((o) => JSON.parse(o.slice(7)) as Row);

const synthJob = (id: string, status: string, over: Row = {}): Row => ({
  id,
  type: "synthesize",
  status,
  error: null,
  priority: 0,
  created_at: "2026-11-03T09:00:00Z",
  payload: { chapter_id: cid(1), voice_hash: "voice-1" },
  ...over,
});

const audioRow = (over: Row = {}): Row => ({
  id: "a1",
  chapter_id: cid(1),
  attempt: 1,
  status: "ready",
  voice_hash: "voice-1",
  text_hash: "h1",
  init_key: "i",
  chunks: [],
  full_key: "f",
  duration_ms: 5000,
  segments: [],
  updated_at: "2026-11-03T09:00:00Z",
  ...over,
});

function base(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    chapters: [{ id: cid(1), novel_id: NOVEL, index: 5, title: "C5", text_hash: "h1" }],
    chapter_audio: [],
    jobs: [],
    worker_status: [{ last_seen: "2026-11-03T09:59:00Z" }],
    ...over,
  };
}

describe("loadAudioSnapshot / loadAudioState", () => {
  it("returns null for a chapter the caller cannot see, before asking for the voice hash", async () => {
    const calls: Call[] = [];
    expect(await loadAudioSnapshot(fakeSupabase(base({ chapters: [] }), {}, calls), cid(1))).toBeNull();
    expect(calls.some((c) => c.table.startsWith("rpc:"))).toBe(false);
  });

  it("keeps only {i, start_ms, end_ms} of timed segments and drops malformed ones", async () => {
    const segments = [
      { i: 0, start_ms: 0, end_ms: 900, text: "x", extra: true },
      { i: 1, start_ms: "bad", end_ms: 1 },
      { i: 2, end_ms: 5 },
      null,
      { i: 3, start_ms: 900, end_ms: null },
      { i: 4, start_ms: 900, end_ms: 1800 },
    ];
    const snap = await loadAudioSnapshot(fakeSupabase(base({ chapter_audio: [audioRow({ segments })] })), cid(1));
    expect(snap!.audio!.segments).toEqual([
      { i: 0, start_ms: 0, end_ms: 900 },
      { i: 4, start_ms: 900, end_ms: 1800 },
    ]);
    expect(snap).toMatchObject({
      voiceHash: "voice-1",
      chapterTextHash: "h1",
      workerLastSeen: "2026-11-03T09:59:00Z",
    });
  });

  it("filters the newest job on chapter and voice hash, so an old voice's job does not hide a current one", async () => {
    const jobs = [
      synthJob("old-voice", "failed", {
        created_at: "2026-11-03T09:30:00Z",
        payload: { chapter_id: cid(1), voice_hash: "voice-0" },
      }),
      synthJob("current", "done"),
    ];
    const calls: Call[] = [];
    const snap = await loadAudioSnapshot(fakeSupabase(base({ jobs }), {}, calls), cid(1));
    expect(snap!.job?.id).toBe("current");
    const jobCall = calls.find((c) => c.table === "jobs")!;
    expect(jobCall.ops).toContain("eq:payload->>voice_hash=voice-1");
    expect(jobCall.ops).toContain(`eq:payload->>chapter_id=${cid(1)}`);
  });

  it("counts queued jobs ahead by (priority, created_at) for a queued job only", async () => {
    const jobs = [
      synthJob("mine", "queued", {
        priority: 10,
        created_at: "2026-11-03T09:10:00Z",
      }),
      synthJob("p0", "queued", {
        priority: 0,
        created_at: "2026-11-03T09:20:00Z",
        payload: { chapter_id: "x", voice_hash: "voice-1" },
      }),
      synthJob("same-prio-earlier", "queued", {
        priority: 10,
        created_at: "2026-11-03T09:05:00Z",
        payload: { chapter_id: "y", voice_hash: "voice-1" },
      }),
      synthJob("same-prio-later", "queued", {
        priority: 10,
        created_at: "2026-11-03T09:15:00Z",
        payload: { chapter_id: "z", voice_hash: "voice-1" },
      }),
      synthJob("running", "running", {
        priority: 0,
        payload: { chapter_id: "r", voice_hash: "voice-1" },
      }),
    ];
    const calls: Call[] = [];
    const snap = await loadAudioSnapshot(fakeSupabase(base({ jobs }), {}, calls), cid(1));
    expect(snap!.queuePosition).toBe(3);
    const count = calls.filter((c) => c.table === "jobs").find((c) => c.ops.some((o) => o.startsWith("or:")))!;
    expect(count.ops).toContain("or:priority.lt.10,and(priority.eq.10,created_at.lt.2026-11-03T09:10:00Z)");
  });

  it("does no position query when the job is not queued", async () => {
    const calls: Call[] = [];
    const snap = await loadAudioState(fakeSupabase(base({ jobs: [synthJob("r", "running")] }), {}, calls), {
      chapterId: cid(1),
      voiceHash: "voice-1",
      chapterTextHash: "h1",
      workerLastSeen: null,
    });
    expect(snap.queuePosition).toBeNull();
    expect(calls.filter((c) => c.table === "jobs")).toHaveLength(1);
  });
});

describe("ensureAudio", () => {
  it("enqueues a priority 0 synthesize job with the current voice hash when idle, then returns the queued state", async () => {
    const calls: Call[] = [];
    const res = await ensureAudio(fakeSupabase(base(), {}, calls), USER, cid(1));
    expect(inserts(calls)).toEqual([
      {
        type: "synthesize",
        payload: { chapter_id: cid(1), voice_hash: "voice-1" },
        priority: 0,
        user_id: USER,
      },
    ]);
    expect(res.error).toBeNull();
    expect(res.snapshot?.job?.status).toBe("queued");
    expect(res.snapshot?.queuePosition).toBe(1);
  });

  it("returns the existing job on a second call instead of inserting again", async () => {
    const calls: Call[] = [];
    const supabase = fakeSupabase(base(), {}, calls);
    await ensureAudio(supabase, USER, cid(1));
    const second = await ensureAudio(supabase, USER, cid(1));
    expect(inserts(calls)).toHaveLength(1);
    expect(second.snapshot?.job?.status).toBe("queued");
  });

  it("does not enqueue when ready audio matches the text, or while a job is live", async () => {
    const ready = await ensureAudio(fakeSupabase(base({ chapter_audio: [audioRow()] })), USER, cid(1));
    expect(ready.snapshot?.audio?.status).toBe("ready");
    const calls: Call[] = [];
    await ensureAudio(fakeSupabase(base({ jobs: [synthJob("r", "running")] }), {}, calls), USER, cid(1));
    expect(inserts(calls)).toHaveLength(0);
  });

  it("enqueues again for audio made from older text when no job is live (Review Focus 1)", async () => {
    const calls: Call[] = [];
    await ensureAudio(fakeSupabase(base({ chapter_audio: [audioRow({ text_hash: "old" })] }), {}, calls), USER, cid(1));
    expect(inserts(calls)).toHaveLength(1);
    const nullHash: Call[] = [];
    await ensureAudio(
      fakeSupabase(base({ chapter_audio: [audioRow({ text_hash: null })] }), {}, nullHash),
      USER,
      cid(1),
    );
    expect(inserts(nullHash)).toHaveLength(1);
  });

  it("does not auto-enqueue after a failed job: the UI shows the error and Thử lại (spec 7.3.1)", async () => {
    const calls: Call[] = [];
    const res = await ensureAudio(
      fakeSupabase(base({ jobs: [synthJob("f", "failed", { error: "hỏng" })] }), {}, calls),
      USER,
      cid(1),
    );
    expect(inserts(calls)).toHaveLength(0);
    expect(res.snapshot?.job?.status).toBe("failed");
  });

  it("enqueues after a done or cancelled job with no usable audio", async () => {
    for (const status of ["done", "cancelled"]) {
      const calls: Call[] = [];
      await ensureAudio(fakeSupabase(base({ jobs: [synthJob("j", status)] }), {}, calls), USER, cid(1));
      expect(inserts(calls)).toHaveLength(1);
    }
  });

  it("returns Vietnamese errors instead of throwing for an unknown chapter, a chapter without text and a full queue", async () => {
    expect(await ensureAudio(fakeSupabase(base({ chapters: [] })), USER, cid(1))).toEqual({
      snapshot: null,
      error: CHAPTER_NOT_FOUND,
    });
    const noText = base({
      chapters: [{ id: cid(1), novel_id: NOVEL, index: 5, title: "C5", text_hash: null }],
    });
    expect(await ensureAudio(fakeSupabase(noText), USER, cid(1))).toEqual({
      snapshot: null,
      error: NO_TEXT_TO_SPEAK,
    });
    const full = await ensureAudio(
      fakeSupabase(base(), {
        insertErrors: [
          {
            code: "54000",
            message: "jobs: queue limit reached (500 queued jobs)",
          },
        ],
      }),
      USER,
      cid(1),
    );
    expect(full).toEqual({ snapshot: null, error: QUEUE_FULL });
    const other = await ensureAudio(
      fakeSupabase(base(), {
        insertErrors: [{ code: "XX000", message: "boom" }],
      }),
      USER,
      cid(1),
    );
    expect(other).toEqual({ snapshot: null, error: ENQUEUE_FAILED });
  });

  it("on a racing duplicate returns the live job as a normal snapshot", async () => {
    const tables = base();
    const supabase = fakeSupabase(tables, {
      insertErrors: [{ code: "23505", message: "duplicate key" }],
    });
    // The racing request's job appears between our insert and the lookup.
    tables.jobs.push(synthJob("raced", "queued"));
    const res = await ensureAudio(supabase, USER, cid(1));
    expect(res.error).toBeNull();
  });
});

describe("retryJob", () => {
  it("moves a failed job back to queued", async () => {
    const tables = base({ jobs: [synthJob("f", "failed", { error: "hỏng" })] });
    const calls: Call[] = [];
    const res = await retryJob(fakeSupabase(tables, {}, calls), USER, "f");
    expect(calls.flatMap((c) => c.ops)).toContain('update:{"status":"queued"}');
    expect(tables.jobs[0].status).toBe("queued");
    expect(res.snapshot?.job?.status).toBe("queued");
  });

  it("does not update a job that is not failed", async () => {
    const calls: Call[] = [];
    await retryJob(fakeSupabase(base({ jobs: [synthJob("r", "running")] }), {}, calls), USER, "r");
    expect(calls.flatMap((c) => c.ops).some((o) => o.startsWith("update:"))).toBe(false);
  });

  it("enqueues afresh instead of retrying a job of an older voice", async () => {
    const old = synthJob("f", "failed", {
      payload: { chapter_id: cid(1), voice_hash: "voice-0" },
    });
    const calls: Call[] = [];
    await retryJob(fakeSupabase(base({ jobs: [old] }), {}, calls), USER, "f");
    expect(inserts(calls)).toHaveLength(1);
    expect(calls.flatMap((c) => c.ops).some((o) => o.startsWith("update:"))).toBe(false);
  });

  it("returns an error for an unknown job, and a retry error in Vietnamese", async () => {
    expect(await retryJob(fakeSupabase(base()), USER, "nope")).toMatchObject({
      snapshot: null,
    });
    const res = await retryJob(
      fakeSupabase(base({ jobs: [synthJob("f", "failed")] }), {
        updateError: { code: "XX000", message: "boom" },
      }),
      USER,
      "f",
    );
    expect(res).toEqual({ snapshot: null, error: ENQUEUE_FAILED });
  });

  it("treats a duplicate on retry as success: another job is already live", async () => {
    const res = await retryJob(
      fakeSupabase(base({ jobs: [synthJob("f", "failed")] }), {
        updateError: { code: "23505", message: "dup" },
      }),
      USER,
      "f",
    );
    expect(res.error).toBeNull();
  });
});

describe("prefetchNext", () => {
  const chapters = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: cid(n),
    novel_id: NOVEL,
    index: n,
    title: `C${n}`,
    text_hash: `h${n}`,
  }));
  const settings = (k: number): Row[] => [{ user_id: USER, data: { worker: { prefetchCount: k } } }];
  const tables = (k: number, over: Record<string, Row[]> = {}) => ({
    settings: settings(k),
    chapters,
    chapter_audio: [] as Row[],
    jobs: [] as Row[],
    ...over,
  });

  it("does nothing and queries no jobs, chapters or audio when prefetchCount is 0", async () => {
    const calls: Call[] = [];
    expect(await prefetchNext(fakeSupabase(tables(0), {}, calls), USER, NOVEL, 2)).toEqual({
      enqueued: 0,
      error: null,
    });
    expect(calls.map((c) => c.table)).toEqual(["settings"]);
  });

  it("queues priority 10 jobs for the next k chapters only, bounded to those chapters", async () => {
    const calls: Call[] = [];
    const res = await prefetchNext(fakeSupabase(tables(2), {}, calls), USER, NOVEL, 2);
    expect(res).toEqual({ enqueued: 2, error: null });
    expect(inserts(calls)).toEqual([
      {
        type: "synthesize",
        payload: { chapter_id: cid(3), voice_hash: "voice-1" },
        priority: 10,
        user_id: USER,
      },
      {
        type: "synthesize",
        payload: { chapter_id: cid(4), voice_hash: "voice-1" },
        priority: 10,
        user_id: USER,
      },
    ]);
    const ops = calls.flatMap((c) => c.ops);
    expect(ops).toContain("gte:index=3");
    expect(ops).toContain("lte:index=4");
    expect(ops).toContain(`in:chapter_id=${cid(3)}|${cid(4)}`);
    expect(ops).toContain(`in:payload->>chapter_id=${cid(3)}|${cid(4)}`);
  });

  it("falls back to 3 for an invalid setting and never exceeds the configured count", async () => {
    const bad: Row[] = [{ user_id: USER, data: { worker: { prefetchCount: "lots" } } }];
    expect((await prefetchNext(fakeSupabase(tables(3, { settings: bad })), USER, NOVEL, 1)).enqueued).toBe(3);
    expect((await prefetchNext(fakeSupabase(tables(1)), USER, NOVEL, 1)).enqueued).toBe(1);
  });

  it("skips ready, live and failed chapters", async () => {
    const t = tables(3, {
      chapter_audio: [
        {
          chapter_id: cid(2),
          status: "ready",
          text_hash: "h2",
          voice_hash: "voice-1",
        },
      ],
      jobs: [
        synthJob("q", "queued", {
          payload: { chapter_id: cid(3), voice_hash: "voice-1" },
        }),
        synthJob("f", "failed", {
          payload: { chapter_id: cid(4), voice_hash: "voice-1" },
        }),
      ],
    });
    const calls: Call[] = [];
    expect(await prefetchNext(fakeSupabase(t, {}, calls), USER, NOVEL, 1)).toEqual({ enqueued: 0, error: null });
    expect(inserts(calls)).toHaveLength(0);
  });

  it("ignores a duplicate on one target and continues with the rest", async () => {
    const calls: Call[] = [];
    const res = await prefetchNext(
      fakeSupabase(tables(3), { insertErrors: [null, { code: "23505", message: "dup" }, null] }, calls),
      USER,
      NOVEL,
      1,
    );
    expect(res).toEqual({ enqueued: 2, error: null });
    expect(inserts(calls)).toHaveLength(3);
  });

  it("stops on another insert error and returns it as Vietnamese copy", async () => {
    const calls: Call[] = [];
    const res = await prefetchNext(
      fakeSupabase(
        tables(3),
        {
          insertErrors: [
            null,
            {
              code: "54000",
              message: "jobs: queue limit reached (500 queued jobs)",
            },
          ],
        },
        calls,
      ),
      USER,
      NOVEL,
      1,
    );
    expect(res).toEqual({ enqueued: 1, error: QUEUE_FULL });
    expect(inserts(calls)).toHaveLength(2);
  });
});
