import { NextResponse, type NextRequest } from "next/server";
import { loadNovel, loadTocPage, pageCountFor } from "@/lib/data/novel";
import { parsePage, parseUuid } from "@/lib/params";
import { createClient, getUserId } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// TOC page as JSON for the reader's drawer. The proxy already answers 401 without a session; this checks again.
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getUserId())) return fail(401, "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập.");

  const novelId = parseUuid((await ctx.params).id);
  if (!novelId) return fail(400, "Mã truyện không hợp lệ.");

  try {
    const supabase = await createClient();
    const found = await loadNovel(supabase, novelId);
    if (!found) return fail(404, "Không tìm thấy truyện này.");
    const { novel, voiceHash } = found;
    const raw = request.nextUrl.searchParams.get("page") ?? undefined;
    const page = parsePage(raw, pageCountFor(novel.chapter_count));
    const toc = await loadTocPage(supabase, novelId, voiceHash, page, novel.chapter_count);
    return NextResponse.json(toc, { headers: NO_STORE });
  } catch (err) {
    console.error("toc route failed", err);
    return fail(500, "Không tải được mục lục. Thử lại sau ít phút.");
  }
}
