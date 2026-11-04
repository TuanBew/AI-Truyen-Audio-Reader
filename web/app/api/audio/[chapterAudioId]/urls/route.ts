import { NextResponse, type NextRequest } from "next/server";
import { getR2ReadEnv, type R2ReadEnv } from "@/lib/env.server";
import { parseUuid } from "@/lib/params";
import { buildManifest, type ManifestRow } from "@/lib/r2/manifest";
import { createClient, getUserId } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// Signed R2 URLs for one chapter_audio row. Authenticated, rate limited per user (60/min, counted in Postgres) and
// the row must be visible through RLS. Order: session, uuid, rate limit, row.
export async function GET(_request: NextRequest, ctx: { params: Promise<{ chapterAudioId: string }> }) {
  if (!(await getUserId())) return fail(401, "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập.");

  const audioId = parseUuid((await ctx.params).chapterAudioId);
  if (!audioId) return fail(400, "Mã âm thanh không hợp lệ.");

  let env: R2ReadEnv;
  try {
    env = getR2ReadEnv();
  } catch (err) {
    console.error("audio urls: R2 not configured", err);
    return fail(503, "Chưa cấu hình kho âm thanh.");
  }

  try {
    const supabase = await createClient();
    const { data: allowed, error: limitError } = await supabase.rpc("api_rate_limit_hit", { p_bucket: "audio_urls" });
    if (limitError) {
      // Fail closed: without the counter there is no cost cap, so no URLs are signed.
      console.error("audio urls: rate limit check failed", limitError);
      return fail(503, "Chưa tải được âm thanh. Thử lại sau ít phút.");
    }
    if (allowed !== true) return fail(429, "Tải âm thanh quá nhanh. Đợi một phút rồi thử lại.");

    const { data: row, error } = await supabase
      .from("chapter_audio")
      .select("id, attempt, status, init_key, chunks, full_key, duration_ms")
      .eq("id", audioId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return fail(404, "Không tìm thấy âm thanh này.");

    const manifest = await buildManifest(env, row as ManifestRow, new Date(), (message) =>
      console.warn("audio urls:", message),
    );
    return NextResponse.json(manifest, { headers: NO_STORE });
  } catch (err) {
    console.error("audio urls route failed", err);
    return fail(500, "Không tải được âm thanh. Thử lại sau ít phút.");
  }
}
