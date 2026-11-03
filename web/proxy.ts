import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authDecision } from "@/lib/auth/paths";
import { publicEnv } from "@/lib/env";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = typeof data?.claims?.sub === "string";
  const { pathname, search } = request.nextUrl;

  switch (authDecision(pathname, signedIn)) {
    case "unauthorized":
      return NextResponse.json({ error: "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập." }, { status: 401 });
    case "login": {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      url.searchParams.set("next", pathname + search);
      return NextResponse.redirect(url);
    }
    case "home":
      return NextResponse.redirect(new URL("/", request.url));
    case "next":
      break;
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|ambient/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3|webm)$).*)"],
};
