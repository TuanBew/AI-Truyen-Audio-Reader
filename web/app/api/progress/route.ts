import { NextResponse, type NextRequest } from "next/server";
import { progressBody } from "@/lib/progress/body";
import { createClient, getUserId } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "private, no-store" };

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
    if (p.error || l?.error) {
      console.error("progress route failed", p.error ?? l?.error);
      return fail(500, "Không lưu được tiến độ nghe. Thử lại sau ít phút.");
    }
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    console.error("progress route failed", err);
    return fail(500, "Không lưu được tiến độ nghe. Thử lại sau ít phút.");
  }
}
