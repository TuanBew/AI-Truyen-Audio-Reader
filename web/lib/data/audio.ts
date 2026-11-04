import type { SupabaseClient } from "@supabase/supabase-js";
import { generationState } from "@/lib/audio/generation";
import { prefetchTargets } from "@/lib/audio/prefetch";
import { JOB_COLUMNS, enqueueOnce, isDuplicateJob, isQueueFull } from "@/lib/jobs";
import { parseSettings } from "@/lib/settings";
import type { AudioChunk, AudioRow, AudioSnapshot, JobRow, TimedSegment } from "@/lib/types";

const AUDIO_COLUMNS = "id,attempt,status,voice_hash,text_hash,init_key,chunks,full_key,duration_ms,segments,updated_at";
// A prefetch lookup reads the recent jobs of at most 10 chapters; newest first keeps each chapter's latest in range.
const PREFETCH_JOB_ROWS = 60;

export const CHAPTER_NOT_FOUND = "Không tìm thấy chương này.";
export const NO_TEXT_TO_SPEAK = "Chương này chưa có nội dung. Tải chương xong rồi hãy nghe.";
export const ENQUEUE_FAILED = "Không yêu cầu được tạo âm thanh. Thử lại sau ít phút.";
export const QUEUE_FULL = "Hàng chờ đã đầy (500 job). Đợi worker chạy bớt rồi thử lại.";

export type AudioResult = { snapshot: AudioSnapshot; error: null } | { snapshot: null; error: string };

function check<T extends { error: { message: string } | null }>(result: T): T {
  if (result.error) throw new Error(`audio query failed: ${result.error.message}`);
  return result;
}

export function enqueueErrorText(err: { code?: string | null; message?: string | null }): string {
  return isQueueFull(err) ? QUEUE_FULL : ENQUEUE_FAILED;
}

// The client only needs timings: keep { i, start_ms, end_ms } and drop entries with missing or non-numeric times.
function timedSegments(value: unknown): TimedSegment[] {
  if (!Array.isArray(value)) return [];
  const out: TimedSegment[] = [];
  for (const s of value) {
    if (typeof s !== "object" || s === null) continue;
    const { i, start_ms, end_ms } = s as Record<string, unknown>;
    if (
      typeof i === "number" &&
      typeof start_ms === "number" &&
      typeof end_ms === "number" &&
      Number.isFinite(i) &&
      Number.isFinite(start_ms) &&
      Number.isFinite(end_ms)
    ) {
      out.push({ i, start_ms, end_ms });
    }
  }
  return out;
}

function toAudioRow(row: Record<string, unknown> | null): AudioRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as AudioRow),
    chunks: Array.isArray(row.chunks) ? (row.chunks as AudioChunk[]) : [],
    segments: timedSegments(row.segments),
  };
}

export type KnownChapter = {
  chapterId: string;
  voiceHash: string;
  chapterTextHash: string | null;
  workerLastSeen: string | null;
};

// The newest synthesize job for this chapter and voice hash. The voice hash filter keeps a job of an old voice from
// hiding a current one (index jobs_chapter_latest serves the chapter lookup).
async function loadNewestJob(supabase: SupabaseClient, chapterId: string, voiceHash: string): Promise<JobRow | null> {
  const res = check(
    await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("type", "synthesize")
      .eq("payload->>chapter_id", chapterId)
      .eq("payload->>voice_hash", voiceHash)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return (res.data as JobRow | null) ?? null;
}

async function findActiveSynthJob(
  supabase: SupabaseClient,
  chapterId: string,
  voiceHash: string,
): Promise<JobRow | null> {
  const res = check(
    await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("type", "synthesize")
      .eq("payload->>chapter_id", chapterId)
      .eq("payload->>voice_hash", voiceHash)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return (res.data as JobRow | null) ?? null;
}

// 1 + the owner's queued jobs ahead of this one by (priority, created_at), the order the worker claims in. RLS
// scopes the count to the caller's jobs.
async function queuePositionOf(supabase: SupabaseClient, job: JobRow): Promise<number> {
  const res = check(
    await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .or(`priority.lt.${job.priority},and(priority.eq.${job.priority},created_at.lt.${job.created_at})`),
  );
  return 1 + (res.count ?? 0);
}

// The audio row, newest job and queue position for a chapter whose voice hash and text hash are already known.
export async function loadAudioState(supabase: SupabaseClient, known: KnownChapter): Promise<AudioSnapshot> {
  const [audioRes, job] = await Promise.all([
    supabase
      .from("chapter_audio")
      .select(AUDIO_COLUMNS)
      .eq("chapter_id", known.chapterId)
      .eq("voice_hash", known.voiceHash)
      .maybeSingle(),
    loadNewestJob(supabase, known.chapterId, known.voiceHash),
  ]);
  const audio = toAudioRow(check(audioRes).data as Record<string, unknown> | null);
  const queuePosition = job?.status === "queued" ? await queuePositionOf(supabase, job) : null;
  return { ...known, audio, job, queuePosition };
}

// The full snapshot from a chapter id alone, or null when the chapter is not the caller's. The chapter lookup comes
// first because current_voice_hash raises for a novel the caller cannot see.
export async function loadAudioSnapshot(supabase: SupabaseClient, chapterId: string): Promise<AudioSnapshot | null> {
  const chapter = check(await supabase.from("chapters").select("novel_id,text_hash").eq("id", chapterId).maybeSingle())
    .data as { novel_id: string; text_hash: string | null } | null;
  if (!chapter) return null;

  const [hashRes, workerRes] = await Promise.all([
    supabase.rpc("current_voice_hash", { p_novel_id: chapter.novel_id }),
    supabase.from("worker_status").select("last_seen").order("last_seen", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const voiceHash = check(hashRes).data;
  if (typeof voiceHash !== "string") throw new Error("audio query failed: no voice hash");
  const workerLastSeen = (check(workerRes).data as { last_seen: string } | null)?.last_seen ?? null;

  return loadAudioState(supabase, {
    chapterId,
    voiceHash,
    chapterTextHash: chapter.text_hash,
    workerLastSeen,
  });
}

// Press play: when nothing usable exists and nothing is in flight, queue a priority 0 synthesize job. A failed job
// is left alone so the UI can show its error and a retry button (spec 7.3.1); a done or cancelled one with no usable
// audio is queued again. Two plays racing the enqueue both get the same job (Review Focus 4).
export async function ensureAudio(supabase: SupabaseClient, userId: string, chapterId: string): Promise<AudioResult> {
  const snapshot = await loadAudioSnapshot(supabase, chapterId);
  if (!snapshot) return { snapshot: null, error: CHAPTER_NOT_FOUND };
  const state = generationState(snapshot, Date.now());
  // A partial row with no live job (cancelled, done or none) would be stuck, so it is queued again; a failed newest
  // job is left for Thử lại (jobError).
  const stuckPartial =
    state.kind === "partial" && (!snapshot.job || ["cancelled", "done"].includes(snapshot.job.status));
  if (state.kind !== "idle" && !stuckPartial) return { snapshot, error: null };
  if (snapshot.chapterTextHash === null) return { snapshot: null, error: NO_TEXT_TO_SPEAK };

  try {
    await enqueueOnce(
      supabase,
      {
        type: "synthesize",
        payload: { chapter_id: chapterId, voice_hash: snapshot.voiceHash },
        priority: 0,
        user_id: userId,
      },
      () => findActiveSynthJob(supabase, chapterId, snapshot.voiceHash),
    );
  } catch (err) {
    console.error("ensureAudio: enqueue failed", err);
    return {
      snapshot: null,
      error: enqueueErrorText(err as { code?: string; message?: string }),
    };
  }
  return { snapshot: await loadAudioState(supabase, snapshot), error: null };
}

// "Thử lại": failed -> queued for the same job. A job of an older voice is not retried (the worker would cancel it);
// the chapter is enqueued afresh instead.
export async function retryJob(supabase: SupabaseClient, userId: string, jobId: string): Promise<AudioResult> {
  const found = check(
    await supabase.from("jobs").select("id,status,payload").eq("id", jobId).eq("type", "synthesize").maybeSingle(),
  ).data as {
    id: string;
    status: string;
    payload: { chapter_id?: unknown; voice_hash?: unknown };
  } | null;
  const chapterId = found?.payload?.chapter_id;
  if (!found || typeof chapterId !== "string") return { snapshot: null, error: "Không tìm thấy yêu cầu này." };

  const snapshot = await loadAudioSnapshot(supabase, chapterId);
  if (!snapshot) return { snapshot: null, error: CHAPTER_NOT_FOUND };
  if (found.payload.voice_hash !== snapshot.voiceHash) return ensureAudio(supabase, userId, chapterId);

  if (found.status === "failed") {
    const { error } = await supabase.from("jobs").update({ status: "queued" }).eq("id", jobId).eq("status", "failed");
    // 23505: another job for this chapter and voice is already live, which is what the retry wanted.
    if (error && !isDuplicateJob(error)) {
      console.error("retryJob: update failed", error.code, error.message);
      return { snapshot: null, error: enqueueErrorText(error) };
    }
  }
  return { snapshot: await loadAudioState(supabase, snapshot), error: null };
}

type PrefetchResult = { enqueued: number; error: string | null };

// Queues priority 10 synthesize jobs for the next settings.worker.prefetchCount chapters. Every query is bounded to
// those chapters. A duplicate on one target is ignored; any other failure stops the loop and is returned (the caller
// only logs it: a prefetch problem never blocks playback).
export async function prefetchNext(
  supabase: SupabaseClient,
  userId: string,
  novelId: string,
  chapterIndex: number,
): Promise<PrefetchResult> {
  try {
    const settingsRes = check(await supabase.from("settings").select("data").eq("user_id", userId).maybeSingle());
    const k = parseSettings((settingsRes.data as { data: unknown } | null)?.data).worker.prefetchCount;
    if (k === 0) return { enqueued: 0, error: null };

    const [chaptersRes, hashRes] = await Promise.all([
      supabase
        .from("chapters")
        .select("id,index,text_hash")
        .eq("novel_id", novelId)
        .gte("index", chapterIndex + 1)
        .lte("index", chapterIndex + k)
        .order("index", { ascending: true }),
      supabase.rpc("current_voice_hash", { p_novel_id: novelId }),
    ]);
    const chapters = (check(chaptersRes).data ?? []) as {
      id: string;
      index: number;
      text_hash: string | null;
    }[];
    const voiceHash = check(hashRes).data;
    if (typeof voiceHash !== "string") throw new Error("audio query failed: no voice hash");
    if (chapters.length === 0) return { enqueued: 0, error: null };
    const ids = chapters.map((c) => c.id);

    const [audioRes, jobsRes] = await Promise.all([
      supabase
        .from("chapter_audio")
        .select("chapter_id,status,text_hash")
        .in("chapter_id", ids)
        .eq("voice_hash", voiceHash),
      supabase
        .from("jobs")
        .select("status,created_at,payload")
        .eq("type", "synthesize")
        .eq("payload->>voice_hash", voiceHash)
        .in("payload->>chapter_id", ids)
        .order("created_at", { ascending: false })
        .limit(PREFETCH_JOB_ROWS),
    ]);
    const audio = (check(audioRes).data ?? []) as {
      chapter_id: string;
      status: AudioRow["status"];
      text_hash: string | null;
    }[];
    const jobs = (
      (check(jobsRes).data ?? []) as {
        status: JobRow["status"];
        created_at: string;
        payload: { chapter_id: string };
      }[]
    ).map((j) => ({
      chapter_id: j.payload.chapter_id,
      status: j.status,
      created_at: j.created_at,
    }));

    let enqueued = 0;
    for (const chapterId of prefetchTargets({
      index: chapterIndex,
      k,
      chapters,
      audio,
      jobs,
    })) {
      const { error } = await supabase.from("jobs").insert({
        type: "synthesize",
        payload: { chapter_id: chapterId, voice_hash: voiceHash },
        priority: 10,
        user_id: userId,
      });
      if (!error) enqueued++;
      else if (!isDuplicateJob(error)) {
        console.error("prefetchNext: insert failed", error.code, error.message);
        return { enqueued, error: enqueueErrorText(error) };
      }
    }
    return { enqueued, error: null };
  } catch (err) {
    console.error("prefetchNext failed", err);
    return { enqueued: 0, error: ENQUEUE_FAILED };
  }
}
