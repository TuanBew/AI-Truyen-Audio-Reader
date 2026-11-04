import type { SupabaseClient } from "@supabase/supabase-js";
import { usableAudio } from "@/lib/audio/generation";
import type { AudioStatus } from "@/lib/types";

export const TOC_PAGE_SIZE = 100;

export type NovelDetail = {
  id: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  description: string | null;
  status: "ongoing" | "completed" | null;
  chapter_count: number;
};

export type TocChapter = {
  id: string;
  index: number;
  title: string;
  text_hash: string | null;
  fetched_at: string | null;
  is_new: boolean;
};

export type TocAudio = { status: AudioStatus; text_hash: string | null };

export type TocItem = {
  id: string;
  index: number;
  title: string;
  hasText: boolean;
  audioReady: boolean;
  listened: boolean;
  isNew: boolean;
};

export type TocPage = { page: number; pageCount: number; items: TocItem[] };

function check<T extends { error: { message: string } | null }>(result: T): T {
  if (result.error) throw new Error(`novel query failed: ${result.error.message}`);
  return result;
}

export function pageCountFor(chapterCount: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chapterCount) / TOC_PAGE_SIZE));
}

// Audio counts as ready only when it was made from the chapter's current text (Review Focus 1): a null hash on
// either side means "unknown", which is treated as absent.
export function tocItem(chapter: TocChapter, audio: TocAudio | null, listened: boolean): TocItem {
  return {
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    hasText: chapter.text_hash !== null,
    audioReady: usableAudio(audio, chapter.text_hash)?.status === "ready",
    listened,
    isNew: chapter.is_new,
  };
}

// RLS scopes both queries: another user's novel is "not found". The voice hash is only asked for once the novel exists.
export async function loadNovel(
  supabase: SupabaseClient,
  novelId: string,
): Promise<{ novel: NovelDetail; voiceHash: string } | null> {
  const res = check(
    await supabase
      .from("novels")
      .select("id,title,author,cover_url,description,status,chapter_count")
      .eq("id", novelId)
      .maybeSingle(),
  );
  if (!res.data) return null;
  const hash = check(await supabase.rpc("current_voice_hash", { p_novel_id: novelId }));
  if (typeof hash.data !== "string") throw new Error("novel query failed: no voice hash");
  return { novel: res.data as NovelDetail, voiceHash: hash.data };
}

export type NovelResume = { chapterIndex: number; segmentIndex: number };

// Progress is one row per novel (primary key user_id, novel_id).
export async function loadNovelResume(supabase: SupabaseClient, novelId: string): Promise<NovelResume | null> {
  const res = check(
    await supabase
      .from("progress")
      .select("segment_index,chapter:chapters(index)")
      .eq("novel_id", novelId)
      .maybeSingle(),
  );
  const row = res.data as { segment_index: number; chapter: { index: number } | { index: number }[] | null } | null;
  if (!row) return null;
  const chapter = Array.isArray(row.chapter) ? row.chapter[0] : row.chapter;
  return chapter ? { chapterIndex: chapter.index, segmentIndex: row.segment_index } : null;
}

// Three parallel queries. The audio and listened queries filter through an inner join on chapters, so they do not
// wait for the chapter ids and the request URL stays short. `page` is clamped to 1..pageCount.
export async function loadTocPage(
  supabase: SupabaseClient,
  novelId: string,
  voiceHash: string,
  page: number,
  chapterCount: number,
): Promise<TocPage> {
  const pageCount = pageCountFor(chapterCount);
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const from = (current - 1) * TOC_PAGE_SIZE + 1;
  const to = current * TOC_PAGE_SIZE;

  const [chaptersRes, audioRes, listenedRes] = await Promise.all([
    supabase
      .from("chapters")
      .select("id,index,title,text_hash,fetched_at,is_new")
      .eq("novel_id", novelId)
      .gte("index", from)
      .lte("index", to)
      .order("index", { ascending: true }),
    supabase
      .from("chapter_audio")
      .select("chapter_id,status,text_hash,chapters!inner(novel_id,index)")
      .eq("voice_hash", voiceHash)
      .eq("chapters.novel_id", novelId)
      .gte("chapters.index", from)
      .lte("chapters.index", to),
    supabase
      .from("listened_chapters")
      .select("chapter_id,chapters!inner(novel_id,index)")
      .eq("chapters.novel_id", novelId)
      .gte("chapters.index", from)
      .lte("chapters.index", to),
  ]);

  const chapters = (check(chaptersRes).data ?? []) as TocChapter[];
  const audioById = new Map<string, TocAudio>();
  for (const row of (check(audioRes).data ?? []) as (TocAudio & { chapter_id: string })[]) {
    audioById.set(row.chapter_id, { status: row.status, text_hash: row.text_hash });
  }
  const listened = new Set(((check(listenedRes).data ?? []) as { chapter_id: string }[]).map((r) => r.chapter_id));

  return {
    page: current,
    pageCount,
    items: chapters.map((c) => tocItem(c, audioById.get(c.id) ?? null, listened.has(c.id))),
  };
}
