"use server";

import { enqueueFetchChapter, type EnqueueResult } from "@/lib/data/chapter";
import { parseUuid } from "@/lib/params";
import { createClient, getUserId } from "@/lib/supabase/server";

// Asks the worker to fetch a chapter's text. Returns the newest active fetch_chapter job when one exists, else a new
// one. Errors come back as Vietnamese copy in the result: a thrown error would reach the browser without its message.
export async function requestChapterText(chapterId: string): Promise<EnqueueResult> {
  const id = parseUuid(chapterId);
  if (!id) return { job: null, error: "Không tìm thấy chương này." };
  const userId = await getUserId();
  if (!userId) return { job: null, error: "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập." };

  const supabase = await createClient();
  // RLS scopes this to the caller's chapters, so a foreign id cannot get a job queued for it.
  const { data, error } = await supabase.from("chapters").select("id").eq("id", id).maybeSingle();
  if (error) {
    console.error("requestChapterText: chapter lookup failed", error.code, error.message);
    return { job: null, error: "Không yêu cầu được tải chương. Thử lại sau ít phút." };
  }
  if (!data) return { job: null, error: "Không tìm thấy chương này." };

  return enqueueFetchChapter(supabase, userId, id);
}
