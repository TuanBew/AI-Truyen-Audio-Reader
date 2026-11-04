import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { CaretLeft } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { isWorkerOffline, loadFetchJob, loadReaderChapter, serverNowMs } from "@/lib/data/chapter";
import { TOC_PAGE_SIZE } from "@/lib/data/novel";
import { parseChapterIndex, parseSegment, parseUuid } from "@/lib/params";
import { createClient, getUserId } from "@/lib/supabase/server";
import { ReaderText } from "./reader-text";
import { Player } from "./player";
import { SegmentWaiter } from "./segment-waiter";
import { TextWaiter } from "./text-waiter";
import { TocDrawer } from "./toc-drawer";

type Props = {
  params: Promise<{ novelId: string; chapterIndex: string }>;
  searchParams: Promise<{ seg?: string | string[]; autoplay?: string | string[] }>;
};

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";
const iconLink = `inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-raised hover:text-text active:scale-[0.98] ${FOCUS_RING}`;
const iconOff = "inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-text-muted opacity-40";
const footLink = `inline-flex h-10 items-center gap-1 rounded-lg border border-border px-4 text-sm text-text transition-colors hover:border-border-strong hover:bg-surface-raised active:scale-[0.98] ${FOCUS_RING}`;

// Malformed route params give null (a 404 page). Shared by generateMetadata and the page so the chapter is read once.
const getChapter = cache(async (rawNovelId: string, rawIndex: string) => {
  const novelId = parseUuid(rawNovelId);
  const index = parseChapterIndex(rawIndex);
  if (!novelId || index === null) return null;
  return loadReaderChapter(await createClient(), novelId, index);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const data = await getChapter(p.novelId, p.chapterIndex);
  return { title: data ? `${data.chapter.title} · ${data.novel.title} · AudioTruyen` : "AudioTruyen" };
}

function ChapterLink({ novelId, index, label, children }: { novelId: string; index: number | null; label: string; children: React.ReactNode }) {
  return index === null ? (
    <span aria-disabled="true" aria-label={label} className={iconOff}>
      {children}
    </span>
  ) : (
    <Link href={`/read/${novelId}/${index}`} rel={label.includes("trước") ? "prev" : "next"} aria-label={label} title={label} className={iconLink}>
      {children}
    </Link>
  );
}

export default async function ReaderPage({ params, searchParams }: Props) {
  const p = await params;
  const data = await getChapter(p.novelId, p.chapterIndex);
  if (!data) notFound();
  const { novel, chapter, segments, snapshot, resumeSegment, prevIndex, nextIndex } = data;

  const query = await searchParams;
  const rawSeg = query.seg;
  const autoplay = (Array.isArray(query.autoplay) ? query.autoplay[0] : query.autoplay) === "1";
  const initialSegment = parseSegment(Array.isArray(rawSeg) ? rawSeg[0] : rawSeg) ?? resumeSegment;

  let waiter: React.ReactNode = null;
  // The text is saved before the analysis, so a refresh can see text without segments while the fetch_chapter job
  // is still running: keep polling until the segments (or the end of the job) arrive.
  const needsJob = chapter.text === null || segments.length === 0;
  const userId = needsJob ? await getUserId() : null;
  const job = userId ? await loadFetchJob(await createClient(), userId, chapter.id) : null;
  const segmentsPending = chapter.text !== null && segments.length === 0 && (job?.status === "queued" || job?.status === "running");
  if (chapter.text === null) {
    waiter = (
      <TextWaiter
        chapterId={chapter.id}
        job={job}
        workerOffline={isWorkerOffline(snapshot.workerLastSeen)}
      />
    );
  }

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2 sm:px-4">
          <Link href={`/novel/${novel.id}`} aria-label="Về trang truyện" title="Về trang truyện" className={iconLink}>
            <ArrowLeft size={20} aria-hidden="true" />
          </Link>
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate text-xs text-text-muted">{novel.title}</p>
            <h1 className="truncate text-sm font-medium text-text">{chapter.title}</h1>
          </div>
          <TocDrawer
            key={chapter.id}
            novelId={novel.id}
            currentIndex={chapter.index}
            initialPage={Math.ceil(chapter.index / TOC_PAGE_SIZE)}
            ownsKey={chapter.text === null}
          />
          <ChapterLink novelId={novel.id} index={prevIndex} label="Chương trước">
            <CaretLeft size={20} aria-hidden="true" />
          </ChapterLink>
          <ChapterLink novelId={novel.id} index={nextIndex} label="Chương sau">
            <CaretRight size={20} aria-hidden="true" />
          </ChapterLink>
        </div>
      </header>

      {/* pb-44 keeps text clear of the fixed player bar (about 6.5 rem) and the banner above it (about 3 rem). */}
      <main className="mx-auto max-w-[68ch] pb-44 pt-6 text-[1.125rem]">
        {chapter.text !== null ? (
          <ReaderText text={chapter.text} segments={segments} />
        ) : (
          waiter
        )}
        <nav aria-label="Chuyển chương" className="mt-10 flex items-center justify-between gap-3 px-4">
          {prevIndex !== null ? (
            <Link href={`/read/${novel.id}/${prevIndex}`} className={footLink}>
              <CaretLeft size={16} aria-hidden="true" />
              Chương trước
            </Link>
          ) : (
            <span />
          )}
          {nextIndex !== null ? (
            <Link href={`/read/${novel.id}/${nextIndex}`} className={footLink}>
              Chương sau
              <CaretRight size={16} aria-hidden="true" />
            </Link>
          ) : null}
        </nav>
      </main>

      {segmentsPending ? <SegmentWaiter jobId={job!.id} status={job!.status} /> : null}

      {chapter.text !== null ? (
        <Player
          key={`${chapter.id}:${segments.length > 0 ? "seg" : "plain"}`}
          chapterId={chapter.id}
          novelId={novel.id}
          chapterIndex={chapter.index}
          snapshot={snapshot}
          nowMs={serverNowMs()}
          initialSegment={initialSegment}
          textChars={chapter.text.length}
          autoplay={autoplay}
          prevHref={prevIndex === null ? null : `/read/${novel.id}/${prevIndex}`}
          nextHref={nextIndex === null ? null : `/read/${novel.id}/${nextIndex}`}
        />
      ) : null}
    </>
  );
}
