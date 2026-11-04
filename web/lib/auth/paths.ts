const PUBLIC_PATHS = new Set(["/login"]);
const SAME_SITE_BASE = "http://n";

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export type AuthDecision = "next" | "login" | "home" | "unauthorized";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

// Next.js internals (static chunks, the dev HMR socket). They carry no app data and must never be redirected to
// /login: a redirected HMR websocket fails. Only the exact "/_next/" prefix; "/_nextfoo" and "/api/*" stay protected.
export function isNextInternalPath(pathname: string): boolean {
  return pathname.startsWith("/_next/");
}

export function authDecision(pathname: string, signedIn: boolean): AuthDecision {
  if (isNextInternalPath(pathname)) return "next";
  if (!signedIn) {
    if (isPublicPath(pathname)) return "next";
    return isApiPath(pathname) ? "unauthorized" : "login";
  }
  return isPublicPath(pathname) ? "home" : "next";
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
