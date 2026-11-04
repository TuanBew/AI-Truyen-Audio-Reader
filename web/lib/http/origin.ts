import type { NextRequest } from "next/server";

// A browser sends Origin on POST. A cross-site page must not write the owner's data, even though the cookie is
// SameSite=Lax already; a request without Origin (curl, tests) passes because it carries no browser cookie risk.
export function crossSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}
