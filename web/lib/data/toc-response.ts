import type { TocPage } from "./novel";

export const TOC_LOAD_ERROR = "Không tải được mục lục. Thử lại sau ít phút.";

export type TocResult = { ok: true; toc: TocPage } | { ok: false; error: string };

function isTocItem(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const item = v as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.index === "number" && typeof item.title === "string";
}

// Turns an HTTP status and the parsed JSON body (null when it was not JSON) from /api/novels/[id]/toc into a result.
// A 2xx whose body is not a TOC page is an error, not a ready drawer with nothing in it.
export function parseTocResponse(status: number, body: unknown): TocResult {
  const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (status < 200 || status >= 300) {
    return { ok: false, error: typeof obj?.error === "string" && obj.error ? obj.error : TOC_LOAD_ERROR };
  }
  if (
    obj === null ||
    typeof obj.page !== "number" ||
    typeof obj.pageCount !== "number" ||
    !Array.isArray(obj.items) ||
    !obj.items.every(isTocItem)
  ) {
    return { ok: false, error: TOC_LOAD_ERROR };
  }
  return { ok: true, toc: obj as unknown as TocPage };
}
