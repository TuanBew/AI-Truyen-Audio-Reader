// Parsers for untrusted route and query parameters. They never throw: bad input gives null or a safe default.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d{1,9}$/;

export function parseUuid(s: string): string | null {
  return UUID_RE.test(s) ? s.toLowerCase() : null;
}

// A page number clamped to 1..pageCount; anything that is not a whole number gives 1.
export function parsePage(s: string | undefined, pageCount: number): number {
  const last = Math.max(1, Math.floor(pageCount));
  if (s === undefined || !DIGITS_RE.test(s)) return 1;
  return Math.min(Math.max(1, Number(s)), last);
}

// A whole chapter number in 1..max, or null.
export function parseChapterNumber(s: string | null | undefined, max: number): number | null {
  if (s === null || s === undefined || !DIGITS_RE.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}
