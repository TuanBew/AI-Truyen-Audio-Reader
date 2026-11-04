import type { NextResponse } from "next/server";

// getClaims() may refresh the session and write the new cookies to the pass-through response. A redirect or 401
// built afterwards is a different object, so the refreshed cookies are copied onto it or the browser keeps the old
// (now rotated) refresh token.
export function copyCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  return to;
}
