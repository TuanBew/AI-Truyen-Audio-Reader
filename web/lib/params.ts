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

const CHAPTER_INDEX_RE = /^[1-9]\d{0,5}$/;
const SEGMENT_RE = /^(?:0|[1-9]\d{0,5})$/;

// A reader route chapter index: a plain decimal integer in 1..100000 (no sign, point or leading zeros), else null.
export function parseChapterIndex(s: string): number | null {
  if (!CHAPTER_INDEX_RE.test(s)) return null;
  const n = Number(s);
  return n <= 100000 ? n : null;
}

// The reader's ?seg= value: a non-negative integer, else null (the parameter is ignored).
export function parseSegment(s: string | undefined): number | null {
  return s !== undefined && SEGMENT_RE.test(s) ? Number(s) : null;
}
