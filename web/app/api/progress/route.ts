import { NextResponse, type NextRequest } from "next/server";
import { progressBody } from "@/lib/progress/body";
import { createClient, getUserId } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "private, no-store" };
const SAVE_FAILED = "Không lưu được tiến độ nghe. Thử lại sau ít phút.";
const NOT_FOUND = "Không tìm thấy chương này.";

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// A browser sends Origin on POST. A cross-site page must not write the owner's progress, even though the cookie is
// SameSite=Lax already; a request without Origin (curl, tests) passes because it carries no browser cookie risk.
function crossSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}

// Saves the listening position; with finished it also marks the chapter as listened. user_id always comes from the
// session. Accepts application/json and the text/plain body that navigator.sendBeacon sends.
export async function POST(request: NextRequest) {
  if (crossSite(request)) return fail(403, "Yêu cầu không hợp lệ.");
  const userId = await getUserId();
  if (!userId) return fail(401, "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập.");

  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return fail(400, "Dữ liệu tiến độ không hợp lệ.");
  }
  const parsed = progressBody.safeParse(raw);
  if (!parsed.success) return fail(400, "Dữ liệu tiến độ không hợp lệ.");
  const body = parsed.data;

  try {
    const supabase = await createClient();
    // Foreign-key checks bypass RLS, so the pair is verified through the RLS-scoped client: an unknown or foreign
    // chapter, or a chapter of another novel, must never become a progress row.
    const found = await supabase
      .from("chapters")
      .select("id")
      .eq("id", body.chapterId)
      .eq("novel_id", body.novelId)
      .maybeSingle();
    if (found.error) {
      console.error("progress route failed", found.error);
      return fail(500, SAVE_FAILED);
    }
    if (!found.data) return fail(404, NOT_FOUND);
    const now = new Date().toISOString();
    const progress = supabase.from("progress").upsert(
      {
        user_id: userId,
        novel_id: body.novelId,
        chapter_id: body.chapterId,
        segment_index: body.segmentIndex,
        position_ms: body.positionMs,
        updated_at: now,
      },
      { onConflict: "user_id,novel_id" },
    );
    const listened = body.finished
      ? supabase
          .from("listened_chapters")
          .upsert({ user_id: userId, chapter_id: body.chapterId, finished_at: now }, { onConflict: "user_id,chapter_id" })
      : null;
    const [p, l] = await Promise.all([progress, listened]);
    const error = p.error ?? l?.error;
    if (error) {
      // 23503: the chapter was deleted between the read and the write.
      if (error.code === "23503") return fail(404, NOT_FOUND);
      console.error("progress route failed", error);
      return fail(500, SAVE_FAILED);
    }
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    console.error("progress route failed", err);
    return fail(500, SAVE_FAILED);
  }
}
