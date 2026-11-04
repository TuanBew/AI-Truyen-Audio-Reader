// Pure helpers shared by the Web Vitals reporter (client) and the route; keep this file dependency-free.
export const VITAL_NAMES = ["CLS", "FCP", "INP", "LCP", "TTFB"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NOVEL = new RegExp(`^/novel/${ID}(/toi)?$`, "i");
const READ = new RegExp(`^/read/${ID}/[0-9]+$`, "i");
const ID_SEGMENT = new RegExp(`^(${ID}|[0-9]+)$`, "i");

// Collapses a pathname to its route pattern so samples group by page and never carry ids. null = do not report.
export function vitalsRoute(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/login") return null;
  const novel = NOVEL.exec(path);
  if (novel) return novel[1] ? "/novel/[id]/toi" : "/novel/[id]";
  if (READ.test(path)) return "/read/[novelId]/[chapterIndex]";
  return path
    .split("/")
    .map((s) => (ID_SEGMENT.test(s) ? "[…]" : s))
    .join("/");
}
