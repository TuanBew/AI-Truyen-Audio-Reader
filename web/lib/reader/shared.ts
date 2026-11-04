import type { JobRow } from "@/lib/types";

// Constants and helpers that client islands of the reader import. Keep this file free of server data code
// (lib/data/*, Supabase, zod): anything a client component imports ends up in the first-load JS of the route.

// A worker whose newest heartbeat is older than this counts as off (the worker beats every few seconds).
export const WORKER_OFFLINE_MS = 60_000;
// The text waiter refreshes the page at this interval first, then backs off with nextPollDelay (lib/data/pending-jobs).
export const TEXT_POLL_START_MS = 2000;
const ERROR_MAX_CHARS = 300;

export function isWorkerOffline(lastSeen: string | null, now: number = Date.now()): boolean {
  if (lastSeen === null) return true;
  const seen = Date.parse(lastSeen);
  return Number.isNaN(seen) || now - seen > WORKER_OFFLINE_MS;
}

// The worker writes owner-actionable Vietnamese messages; show them, bounded.
export function fetchFailedText(error: string | null): string {
  const text = (error ?? "").trim();
  if (!text) return "Không tải được chương.";
  const shown = text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS)}…` : text;
  return `Không tải được chương: ${shown}`;
}

export type EnqueueResult = { job: JobRow; error: null } | { job: null; error: string };

export const CONNECT_ERROR = "Không kết nối được máy chủ. Kiểm tra mạng rồi bấm Thử lại.";

// Runs a server action call so a rejected promise (network drop, deploy mismatch) becomes an error result instead of
// reaching the error boundary through an async transition.
export async function requestSafely(
  call: (chapterId: string) => Promise<EnqueueResult>,
  chapterId: string,
): Promise<EnqueueResult> {
  try {
    return await call(chapterId);
  } catch {
    return { job: null, error: CONNECT_ERROR };
  }
}
