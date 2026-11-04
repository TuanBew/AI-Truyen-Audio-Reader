import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { copyCookies } from "./cookies";

describe("copyCookies", () => {
  it("carries refreshed session cookies, with their options, onto a redirect and a 401", () => {
    const pass = NextResponse.next();
    pass.cookies.set("sb-access", "new-token", { path: "/", httpOnly: true, maxAge: 3600 });
    pass.cookies.set("sb-refresh", "new-refresh", { path: "/" });

    const redirect = copyCookies(pass, NextResponse.redirect("http://localhost/login"));
    expect(redirect.cookies.get("sb-access")?.value).toBe("new-token");
    expect(redirect.cookies.get("sb-access")?.httpOnly).toBe(true);
    expect(redirect.cookies.get("sb-access")?.maxAge).toBe(3600);
    expect(redirect.cookies.get("sb-refresh")?.value).toBe("new-refresh");

    const denied = copyCookies(pass, NextResponse.json({}, { status: 401 }));
    expect(denied.status).toBe(401);
    expect(denied.cookies.get("sb-access")?.value).toBe("new-token");
  });

  it("does nothing when no cookie was written", () => {
    expect(copyCookies(NextResponse.next(), NextResponse.redirect("http://localhost/")).cookies.getAll()).toEqual([]);
  });
});
