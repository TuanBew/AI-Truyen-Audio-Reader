// Mirrors worker/src/audiotruyen_worker/sources/truyenfull.py `novel_slug`; keep the two in step.
const HOSTS = new Set(["truyenfull.live", "www.truyenfull.live"]);
const SLUG = /^[a-z0-9-]+$/;
const NOT_NOVELS = new Set(["tim-kiem", "danh-sach"]);

// Returns the trimmed URL when it is a truyenfull novel or chapter URL, else null.
export function parseTruyenfullNovelUrl(input: string): string | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const first = url.pathname.split("/").find((s) => s !== "");
  if (first === undefined || !SLUG.test(first) || NOT_NOVELS.has(first)) return null;
  return trimmed;
}
