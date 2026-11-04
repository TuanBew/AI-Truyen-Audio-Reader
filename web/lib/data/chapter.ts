import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAudioState } from "@/lib/data/audio";
import { JOB_COLUMNS, isQueueFull } from "@/lib/jobs";
import type { EnqueueResult } from "@/lib/reader/shared";
import type { AnalysisSegment, AudioSnapshot, JobRow } from "@/lib/types";


export type ReaderChapter = {
  novel: { id: string; title: string; chapterCount: number };
  chapter: { id: string; index: number; title: string; textHash: string | null; text: string | null };
  segments: AnalysisSegment[];
  snapshot: AudioSnapshot;
  resumeSegment: number | null;
  prevIndex: number | null;
  nextIndex: number | null;
};

type DbError = { code?: string | null; message?: string | null };

function check<T extends { error: { message: string } | null }>(result: T): T {
  if (result.error) throw new Error(`chapter query failed: ${result.error.message}`);
  return result;
}

export function neighbours(index: number, chapterCount: number): { prevIndex: number | null; nextIndex: number | null } {
  return {
    prevIndex: index > 1 ? index - 1 : null,
    nextIndex: index < chapterCount ? index + 1 : null,
  };
}

// The server clock handed to client islands, so their first render matches the server HTML.
export function serverNowMs(): number {
  return Date.now();
}

export function requestChapterError(err: DbError): string {
  if (isQueueFull(err)) {
    return "Hàng chờ đã đầy (500 job). Đợi worker chạy bớt rồi thử lại.";
  }
  return "Không yêu cầu được tải chương. Thử lại sau ít phút.";
}

// Stored segments come from jsonb; keep only entries shaped like AnalysisSegment so a bad row cannot break the page.
function validSegments(value: unknown): AnalysisSegment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is AnalysisSegment => {
    if (typeof s !== "object" || s === null) return false;
    const seg = s as Partial<AnalysisSegment>;
    return (
      typeof seg.i === "number" &&
      (seg.kind === "narration" || seg.kind === "dialogue") &&
      Array.isArray(seg.src) &&
      seg.src.length === 2 &&
      typeof seg.src[0] === "number" &&
      typeof seg.src[1] === "number"
    );
  });
}

type ChapterRow = { id: string; index: number; title: string; text: string | null; text_hash: string | null };

// Round 1 runs the five lookups in parallel; round 2 the analysis and the audio snapshot. RLS scopes every query to
// the signed-in user, so a foreign or unknown novel gives null. The voice hash RPC raises for a novel it cannot see,
// so its error only matters once the novel and chapter are known to exist.
export async function loadReaderChapter(
  supabase: SupabaseClient,
  novelId: string,
  index: number,
): Promise<ReaderChapter | null> {
  const [novelRes, chapterRes, hashRes, workerRes, progressRes] = await Promise.all([
    supabase.from("novels").select("id,title,chapter_count").eq("id", novelId).maybeSingle(),
    supabase
      .from("chapters")
      .select("id,index,title,text,text_hash")
      .eq("novel_id", novelId)
      .eq("index", index)
      .maybeSingle(),
    supabase.rpc("current_voice_hash", { p_novel_id: novelId }),
    supabase.from("worker_status").select("last_seen").order("last_seen", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("progress").select("chapter_id,segment_index").eq("novel_id", novelId).maybeSingle(),
  ]);

  const novel = check(novelRes).data as { id: string; title: string; chapter_count: number } | null;
  const chapter = check(chapterRes).data as ChapterRow | null;
  if (!novel || !chapter) return null;
  const voiceHash = check(hashRes).data;
  if (typeof voiceHash !== "string") throw new Error("chapter query failed: no voice hash");
  const workerLastSeen = (check(workerRes).data as { last_seen: string } | null)?.last_seen ?? null;
  const progress = check(progressRes).data as { chapter_id: string; segment_index: number } | null;

  const [segments, snapshot] = await Promise.all([
    loadSegments(supabase, chapter),
    loadAudioState(supabase, { chapterId: chapter.id, voiceHash, chapterTextHash: chapter.text_hash, workerLastSeen }),
  ]);

  const chapterCount = Math.max(0, novel.chapter_count);
  return {
    novel: { id: novel.id, title: novel.title, chapterCount },
    chapter: { id: chapter.id, index: chapter.index, title: chapter.title, textHash: chapter.text_hash, text: chapter.text },
    segments,
    snapshot,
    resumeSegment: progress && progress.chapter_id === chapter.id ? progress.segment_index : null,
    ...neighbours(chapter.index, chapterCount),
  };
}

// The newest analysis for the chapter's current text; an analysis of older text is never used (spec 4.1).
async function loadSegments(supabase: SupabaseClient, chapter: ChapterRow): Promise<AnalysisSegment[]> {
  if (chapter.text_hash === null) return [];
  const res = check(
    await supabase
      .from("chapter_analysis")
      .select("segments")
      .eq("chapter_id", chapter.id)
      .eq("text_hash", chapter.text_hash)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return validSegments((res.data as { segments: unknown } | null)?.segments);
}

// The newest fetch_chapter job for the chapter, of any status (index jobs_chapter_latest).
export async function loadFetchJob(supabase: SupabaseClient, userId: string, chapterId: string): Promise<JobRow | null> {
  const res = check(
    await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("user_id", userId)
      .eq("type", "fetch_chapter")
      .eq("payload->>chapter_id", chapterId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return (res.data as JobRow | null) ?? null;
}

async function findActiveFetchJob(supabase: SupabaseClient, userId: string, chapterId: string): Promise<JobRow | null> {
  const res = check(
    await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("user_id", userId)
      .eq("type", "fetch_chapter")
      .eq("payload->>chapter_id", chapterId)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return (res.data as JobRow | null) ?? null;
}

// The active job if there is one, else a new priority 0 fetch_chapter job. jobs_fetch_chapter_dedupe makes a racing
// insert fail with 23505, which means an active job exists: return it. If that job finished between the insert and
// the select, the lookup and insert run once more before the generic error.
export async function enqueueFetchChapter(
  supabase: SupabaseClient,
  userId: string,
  chapterId: string,
): Promise<EnqueueResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = await findActiveFetchJob(supabase, userId, chapterId);
      if (active) return { job: active, error: null };

      const inserted = await supabase
        .from("jobs")
        .insert({ type: "fetch_chapter", payload: { chapter_id: chapterId }, priority: 0, user_id: userId })
        .select(JOB_COLUMNS)
        .single();
      if (!inserted.error) return { job: inserted.data as JobRow, error: null };

      if (inserted.error.code === "23505") {
        const existing = await findActiveFetchJob(supabase, userId, chapterId);
        if (existing) return { job: existing, error: null };
        continue;
      }
      console.error("enqueueFetchChapter: insert failed", inserted.error.code, inserted.error.message);
      return { job: null, error: requestChapterError(inserted.error) };
    }
    return { job: null, error: requestChapterError({}) };
  } catch (err) {
    console.error("enqueueFetchChapter failed", err);
    return { job: null, error: requestChapterError({}) };
  }
}

// Shared with the client islands through lib/reader/shared; re-exported so server code and tests keep one import.
export {
  CONNECT_ERROR,
  TEXT_POLL_START_MS,
  WORKER_OFFLINE_MS,
  fetchFailedText,
  isWorkerOffline,
  requestSafely,
  type EnqueueResult,
} from "@/lib/reader/shared";
