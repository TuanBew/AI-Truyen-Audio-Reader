import { NextResponse, type NextRequest } from "next/server";
import { crossSite } from "@/lib/http/origin";
import { createClient, getUserId } from "@/lib/supabase/server";
import { vitalsBody } from "@/lib/vitals/body";

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// Stores a batch of Web Vitals samples for the signed-in user. Accepts the text/plain body that navigator.sendBeacon
// sends. The rate limit lives in the RPC; when it stores 0 the answer is still 204, since the client can do nothing.
export async function POST(request: NextRequest) {
  if (crossSite(request)) return fail(403, "Yêu cầu không hợp lệ.");
  const userId = await getUserId();
  if (!userId) return fail(401, "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập.");

  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return fail(400, "Dữ liệu đo hiệu năng không hợp lệ.");
  }
  const parsed = vitalsBody.safeParse(raw);
  if (!parsed.success) return fail(400, "Dữ liệu đo hiệu năng không hợp lệ.");

  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("record_web_vitals", { p_samples: parsed.data });
    if (error) {
      console.error("vitals route failed", error);
      return fail(500, "Không lưu được số liệu hiệu năng. Thử lại sau ít phút.");
    }
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    console.error("vitals route failed", err);
    return fail(500, "Không lưu được số liệu hiệu năng. Thử lại sau ít phút.");
  }
}
