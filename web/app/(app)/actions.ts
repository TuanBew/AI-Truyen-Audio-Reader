"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseTruyenfullNovelUrl } from "@/lib/truyenfull-url";
import { createClient, getUserId } from "@/lib/supabase/server";

export type AddNovelState = { error: string | null; ok: boolean };

export async function addNovel(_prev: AddNovelState, formData: FormData): Promise<AddNovelState> {
  const url = parseTruyenfullNovelUrl(String(formData.get("url") ?? ""));
  if (!url) {
    return { error: "Đường dẫn không phải một truyện trên truyenfull.live.", ok: false };
  }
  const userId = await getUserId();
  if (!userId) {
    return { error: "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập.", ok: false };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("jobs")
    .insert({ type: "fetch_novel", payload: { url }, priority: 0, user_id: userId });
  if (error) {
    console.error("addNovel: enqueue failed", error.code, error.message);
    return { error: "Không thêm được vào hàng chờ. Thử lại sau ít phút.", ok: false };
  }
  revalidatePath("/");
  return { error: null, ok: true };
}

// failed -> queued; the jobs_guard_write trigger resets attempts, error and the lease.
export async function retryJob(jobId: string): Promise<void> {
  if (!z.uuid().safeParse(jobId).success) return;
  const supabase = await createClient();
  const { error } = await supabase.from("jobs").update({ status: "queued" }).eq("id", jobId).eq("status", "failed");
  if (error) console.error("retryJob: update failed", error.code, error.message);
  revalidatePath("/");
}
