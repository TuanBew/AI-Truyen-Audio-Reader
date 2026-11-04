// Pure helpers for the add-novel and pending-jobs UI (kept out of the "use server" and client files so they are testable).

export const POLL_START_MS = 3000;
export const POLL_MAX_MS = 30000;
const ERROR_MAX_CHARS = 300;

type DbError = { code?: string | null; message?: string | null };

const QUEUE_FULL = "Hàng chờ đã đầy (500 job). Đợi worker chạy bớt rồi thử lại.";

// 54000 is also the payload-too-large code, so the queue cap is told apart by the trigger's message.
function isQueueFull(err: DbError): boolean {
  return err.code === "54000" && /queue limit/i.test(err.message ?? "");
}

export function addNovelError(err: DbError): string {
  if (err.code === "23505") return "Truyện này đã nằm trong hàng chờ.";
  if (isQueueFull(err)) return QUEUE_FULL;
  return "Không thêm được vào hàng chờ. Thử lại sau ít phút.";
}

export const RETRY_NOT_APPLIED = "Không thử lại được job này. Tải lại trang rồi thử lại.";

export function retryJobError(err: DbError): string {
  if (isQueueFull(err)) return QUEUE_FULL;
  return "Không thử lại được. Thử lại sau ít phút.";
}

// The worker writes owner-actionable Vietnamese messages; show them, bounded.
export function failedJobText(error: string | null): string {
  const text = (error ?? "").trim();
  if (!text) return "Tải mục lục thất bại.";
  const shown = text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS)}…` : text;
  return `Tải mục lục thất bại: ${shown}`;
}

export function nextPollDelay(current: number): number {
  return Math.min(current * 2, POLL_MAX_MS);
}
