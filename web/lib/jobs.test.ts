import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { JobRow } from "@/lib/types";
import { enqueueOnce, isDuplicateJob, isQueueFull } from "./jobs";

const existing: JobRow = {
  id: "live",
  type: "synthesize",
  status: "running",
  error: null,
  priority: 0,
  created_at: "2026-11-03T10:00:00Z",
};

type Result = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

// Only insert(...).select(...).single() is used by enqueueOnce.
function client(results: Result[]) {
  const rows: unknown[] = [];
  const queue = [...results];
  return {
    rows,
    supabase: {
      from: () => ({
        insert: (row: unknown) => {
          rows.push(row);
          return {
            select: () => ({ single: () => Promise.resolve(queue.shift()) }),
          };
        },
      }),
    } as unknown as SupabaseClient,
  };
}

describe("isDuplicateJob", () => {
  it("is true only for unique violations", () => {
    expect(isDuplicateJob({ code: "23505" })).toBe(true);
    expect(isDuplicateJob({ code: "42501" })).toBe(false);
    expect(isDuplicateJob({})).toBe(false);
    expect(isDuplicateJob(null)).toBe(false);
  });
});

describe("isQueueFull", () => {
  it("recognises the queue cap trigger, not other 54000 errors", () => {
    expect(
      isQueueFull({
        code: "54000",
        message: "jobs: queue limit reached (500 queued jobs)",
      }),
    ).toBe(true);
    expect(isQueueFull({ code: "54000", message: "jobs: payload larger than 8 KB" })).toBe(false);
  });
});

describe("enqueueOnce", () => {
  it("returns the inserted job", async () => {
    const { supabase, rows } = client([{ data: { ...existing, id: "new" }, error: null }]);
    const job = await enqueueOnce(supabase, { type: "synthesize" }, async () => null);
    expect(job.id).toBe("new");
    expect(rows).toEqual([{ type: "synthesize" }]);
  });

  it("on a duplicate returns the existing job and does not throw", async () => {
    const { supabase } = client([{ data: null, error: { code: "23505", message: "duplicate key" } }]);
    await expect(enqueueOnce(supabase, {}, async () => existing)).resolves.toBe(existing);
  });

  it("on a duplicate whose job finished meanwhile retries the insert once", async () => {
    const { supabase, rows } = client([
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: { ...existing, id: "second" }, error: null },
    ]);
    const job = await enqueueOnce(supabase, {}, async () => null);
    expect(job.id).toBe("second");
    expect(rows).toHaveLength(2);
  });

  it("throws when a duplicate cannot be resolved", async () => {
    const { supabase } = client([
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: null, error: { code: "23505", message: "duplicate key" } },
    ]);
    await expect(enqueueOnce(supabase, {}, async () => null)).rejects.toThrow();
  });

  it("throws other insert errors with their code", async () => {
    const { supabase } = client([{ data: null, error: { code: "42501", message: "denied" } }]);
    await expect(enqueueOnce(supabase, {}, async () => existing)).rejects.toMatchObject({ code: "42501" });
  });
});
