// Object keys the web may sign (spec 4.3). Anything else in a database row is ignored, so a bad row can never
// make the route sign an arbitrary path.
const KEY_RE =
  /^audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{16}\/(\d+)\/(?:init|seg-\d{4}|full)\.webm$/;

export function isAudioKey(key: string, attempt: number): boolean {
  const m = KEY_RE.exec(key);
  return m !== null && m[1] === String(attempt);
}
