import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/lib/types";

export const JOB_COLUMNS = "id,type,status,error,priority,created_at";

type DbError = { code?: string | null; message?: string | null };

// Postgres unique_violation: the jobs_*_dedupe partial indexes say a live job already exists.
export function isDuplicateJob(error: { code?: string | null } | null): boolean {
  return error?.code === "23505";
}

// 54000 is also the payload-too-large code, so the queue cap is told apart by the trigger's message.
export function isQueueFull(err: DbError): boolean {
  return err.code === "54000" && /queue limit/i.test(err.message ?? "");
}

export class JobInsertError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

// Inserts a job. When the dedupe index rejects it (23505: two plays racing the same enqueue, Review Focus 4) the
// live job is returned instead. If that job finished between the insert and the lookup the insert runs once more.
// Any other failure throws a JobInsertError carrying the Postgres code.
export async function enqueueOnce(
  supabase: SupabaseClient,
  insert: Record<string, unknown>,
  findExisting: () => Promise<JobRow | null>,
): Promise<JobRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await supabase.from("jobs").insert(insert).select(JOB_COLUMNS).single();
    if (!res.error) return res.data as JobRow;
    if (!isDuplicateJob(res.error)) throw new JobInsertError(res.error.message, res.error.code ?? null);
    const existing = await findExisting();
    if (existing) return existing;
  }
  throw new JobInsertError("duplicate synthesize job could not be resolved", "23505");
}
