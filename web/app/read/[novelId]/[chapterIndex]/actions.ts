"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHAPTER_NOT_FOUND,
  ENQUEUE_FAILED,
  ensureAudio,
  loadAudioSnapshot,
  prefetchNext,
  retryJob,
  type AudioResult,
} from "@/lib/data/audio";
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

const SESSION_ENDED = "Phiên đăng nhập đã hết. Tải lại trang để đăng nhập.";

// Like requestChapterText, the audio actions return their failures as Vietnamese copy in the result: a thrown error
// would reach the browser without its message in production.
async function audioAction(
  id: string,
  run: (supabase: SupabaseClient, userId: string, id: string) => Promise<AudioResult>,
): Promise<AudioResult> {
  const uuid = parseUuid(id);
  if (!uuid) return { snapshot: null, error: CHAPTER_NOT_FOUND };
  const userId = await getUserId();
  if (!userId) return { snapshot: null, error: SESSION_ENDED };
  try {
    return await run(await createClient(), userId, uuid);
  } catch (err) {
    console.error("audio action failed", err);
    return { snapshot: null, error: ENQUEUE_FAILED };
  }
}

// First play in a chapter (decision 1): queue synthesis if nothing usable exists or is in flight, then return the
// current snapshot. A second call while a job is live returns that job.
export async function ensureChapterAudio(chapterId: string): Promise<AudioResult> {
  return audioAction(chapterId, ensureAudio);
}

// The player's poll while a chapter is generating.
export async function readAudioSnapshot(chapterId: string): Promise<AudioResult> {
  return audioAction(chapterId, async (supabase, _userId, id) => {
    const snapshot = await loadAudioSnapshot(supabase, id);
    return snapshot ? { snapshot, error: null } : { snapshot: null, error: CHAPTER_NOT_FOUND };
  });
}

// "Thử lại" on a failed job.
export async function retrySynthesis(jobId: string): Promise<AudioResult> {
  return audioAction(jobId, retryJob);
}

// Queues the next chapters after the one playing. Never blocks playback: a failure is logged here and returned for
// completeness, and the client ignores it.
export async function prefetchAfter(
  novelId: string,
  chapterIndex: number,
): Promise<{ enqueued: number; error: string | null }> {
  const id = parseUuid(novelId);
  const userId = await getUserId();
  if (!id || !userId || !Number.isInteger(chapterIndex) || chapterIndex < 1) {
    return { enqueued: 0, error: CHAPTER_NOT_FOUND };
  }
  try {
    return await prefetchNext(await createClient(), userId, id, chapterIndex);
  } catch (err) {
    console.error("prefetchAfter failed", err);
    return { enqueued: 0, error: ENQUEUE_FAILED };
  }
}
