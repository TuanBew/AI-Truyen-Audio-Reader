const PUBLIC_PATHS = new Set(["/login"]);
const SAME_SITE_BASE = "http://n";

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

// URL parsers drop tab/CR/LF and treat "\" as "/", so "/\t/evil" or "/\\evil" would become "//evil".
function hasControlCharOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || value === "") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (hasControlCharOrBackslash(value)) return "/";

  let url: URL;
  try {
    url = new URL(value, SAME_SITE_BASE);
  } catch {
    return "/";
  }
  if (url.origin !== SAME_SITE_BASE) return "/";
  // Dot segments can normalize "/.//evil" into "//evil", which is protocol-relative again.
  if (url.pathname.startsWith("//") || isPublicPath(url.pathname)) return "/";
  return url.pathname + url.search + url.hash;
}
