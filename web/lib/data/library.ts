import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/lib/types";

export type NovelRow = {
  id: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  chapter_count: number;
};

export type NovelCounts = { read: number; new: number };

export type NovelCard = {
  id: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  chapterCount: number;
  readChapters: number;
  newChapters: number;
};

export type ResumeItem = {
  novelId: string;
  novelTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  segmentIndex: number;
};

// `url` is payload.url of the job, so the list can say which novel a job is about.
export type PendingJob = JobRow & { url: string | null };

export type Library = {
  resume: ResumeItem | null;
  novels: NovelCard[];
  recent: NovelCard[];
  pendingJobs: PendingJob[];
};

const RECENT_COUNT = 6;
const PENDING_JOBS_LIMIT = 10;

export function toNovelCard(row: NovelRow, counts: NovelCounts): NovelCard {
  const chapterCount = Math.max(0, row.chapter_count);
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    coverUrl: row.cover_url ? row.cover_url : null,
    chapterCount,
    readChapters: Math.min(Math.max(0, counts.read), chapterCount),
    newChapters: Math.max(0, counts.new),
  };
}

type ProgressRow = {
  novel_id: string;
  segment_index: number;
  chapter: { index: number; title: string } | { index: number; title: string }[] | null;
};

function check<T extends { error: { message: string } | null }>(result: T): T {
  if (result.error) throw new Error(`library query failed: ${result.error.message}`);
  return result;
}

// Two rounds of parallel queries: the lists first, then per-novel head counts (no chapter rows are fetched).
export async function loadLibrary(supabase: SupabaseClient): Promise<Library> {
  const [novelsRes, progressRes, jobsRes] = await Promise.all([
    supabase
      .from("novels")
      .select("id,title,author,cover_url,chapter_count")
      .order("created_at", { ascending: false }),
    supabase
      .from("progress")
      .select("novel_id,segment_index,updated_at,chapter:chapters(index,title)")
      .order("updated_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id,type,status,error,priority,created_at,url:payload->>url")
      .eq("type", "fetch_novel")
      .in("status", ["queued", "running", "failed"])
      .order("created_at", { ascending: false })
      .limit(PENDING_JOBS_LIMIT),
  ]);
  const novelRows = (check(novelsRes).data ?? []) as NovelRow[];
  const progressRows = (check(progressRes).data ?? []) as ProgressRow[];
  const pendingJobs = (check(jobsRes).data ?? []) as PendingJob[];

  const counts = await Promise.all(
    novelRows.map(async (novel) => {
      const [read, fresh] = await Promise.all([
        supabase
          .from("listened_chapters")
          .select("chapter_id,chapters!inner(novel_id)", { count: "exact", head: true })
          .eq("chapters.novel_id", novel.id),
        supabase
          .from("chapters")
          .select("id", { count: "exact", head: true })
          .eq("novel_id", novel.id)
          .eq("is_new", true),
      ]);
      return { read: check(read).count ?? 0, new: check(fresh).count ?? 0 } satisfies NovelCounts;
    }),
  );

  // Rows are already newest first; keep that order for `recent`.
  const cards = novelRows.map((row, i) => toNovelCard(row, counts[i]));
  const recent = cards.slice(0, RECENT_COUNT);

  const lastProgress = new Map<string, number>();
  progressRows.forEach((p, i) => {
    if (!lastProgress.has(p.novel_id)) lastProgress.set(p.novel_id, i);
  });
  // Array.prototype.sort is stable: novels without progress keep their created_at order after the read ones.
  const novels = [...cards].sort(
    (a, b) => (lastProgress.get(a.id) ?? Infinity) - (lastProgress.get(b.id) ?? Infinity) || 0,
  );

  return { resume: pickResume(progressRows, cards), novels, recent, pendingJobs };
}

function pickResume(progressRows: ProgressRow[], cards: NovelCard[]): ResumeItem | null {
  for (const p of progressRows) {
    const novel = cards.find((c) => c.id === p.novel_id);
    const chapter = Array.isArray(p.chapter) ? p.chapter[0] : p.chapter;
    if (!novel || !chapter) continue;
    return {
      novelId: novel.id,
      novelTitle: novel.title,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      segmentIndex: p.segment_index,
    };
  }
  return null;
}
