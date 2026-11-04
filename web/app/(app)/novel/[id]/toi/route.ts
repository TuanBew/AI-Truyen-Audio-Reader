import { NextResponse, type NextRequest } from "next/server";
import { parseChapterNumber, parseUuid } from "@/lib/params";
import { createClient } from "@/lib/supabase/server";

// Target of the "Tới chương" GET form (no client JS): validates the number on the server, then redirects.
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const novelId = parseUuid((await ctx.params).id);
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);
  if (!novelId) return to("/");

  const supabase = await createClient();
  const { data } = await supabase.from("novels").select("chapter_count").eq("id", novelId).maybeSingle();
  if (!data) return to("/");

  const n = parseChapterNumber(request.nextUrl.searchParams.get("n"), data.chapter_count);
  return to(n === null ? `/novel/${novelId}` : `/read/${novelId}/${n}`);
}
