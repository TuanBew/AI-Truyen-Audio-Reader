import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { FileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { SpeakerHigh } from "@phosphor-icons/react/dist/ssr/SpeakerHigh";
import {
  loadNovel,
  loadNovelResume,
  loadTocPage,
  pageCountFor,
  type NovelDetail,
  type TocItem,
} from "@/lib/data/novel";
import { parsePage, parseUuid } from "@/lib/params";
import { createClient } from "@/lib/supabase/server";
import { CoverImage } from "../../cover-image";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ trang?: string | string[] }>;
};

// Shared by generateMetadata and the page so the novel is read once per request.
const getNovel = cache(async (id: string) => loadNovel(await createClient(), id));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = parseUuid((await params).id);
  const found = id ? await getNovel(id) : null;
  return { title: found ? `${found.novel.title} · AudioTruyen` : "AudioTruyen" };
}

const STATUS_LABEL = { ongoing: "Đang ra", completed: "Hoàn thành" } as const;
const LONG_DESCRIPTION_CHARS = 240;
const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

function Description({ text }: { text: string }) {
  if (text.length <= LONG_DESCRIPTION_CHARS) {
    return <p className="mt-4 whitespace-pre-line text-text-muted">{text}</p>;
  }
  // <details> keeps the toggle keyboard accessible without client JS: closed shows 4 lines, open shows all.
  return (
    <details className="group mt-4">
      <summary className={`cursor-pointer list-none rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
        <p className="line-clamp-4 whitespace-pre-line text-text-muted group-open:line-clamp-none">{text}</p>
        <span className="mt-1 inline-block text-sm font-medium text-accent group-open:hidden">Xem thêm</span>
        <span className="mt-1 hidden text-sm font-medium text-accent group-open:inline-block">Thu gọn</span>
      </summary>
    </details>
  );
}

function Mark({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span title={label} className="inline-flex items-center">
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function TocRow({ novelId, item }: { novelId: string; item: TocItem }) {
  return (
    <li>
      <Link
        href={`/read/${novelId}/${item.index}`}
        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]"
      >
        <span className="w-12 shrink-0 text-right text-sm tabular-nums text-text-muted">{item.index}</span>
        <span className={`min-w-0 flex-1 truncate ${item.listened ? "text-text-muted" : "text-text"}`}>{item.title}</span>
        <span className="flex shrink-0 items-center gap-2 text-text-muted">
          {item.isNew ? (
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-contrast">Mới</span>
          ) : null}
          {item.hasText ? (
            <Mark label="Đã tải văn bản">
              <FileText size={18} aria-hidden="true" />
            </Mark>
          ) : null}
          {item.audioReady ? (
            <Mark label="Âm thanh sẵn sàng">
              <SpeakerHigh size={18} aria-hidden="true" className="text-accent" />
            </Mark>
          ) : null}
          {item.listened ? (
            <Mark label="Đã nghe">
              <Check size={18} aria-hidden="true" />
            </Mark>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

const pageButton = `inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm text-text transition-colors hover:border-border-strong hover:bg-surface-raised active:scale-[0.98] ${FOCUS_RING}`;
const pageButtonOff =
  "inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm text-text-muted opacity-50";

function Pagination({ novel, page, pageCount }: { novel: NovelDetail; page: number; pageCount: number }) {
  const href = (n: number) => (n === 1 ? `/novel/${novel.id}` : `/novel/${novel.id}?trang=${n}`);
  return (
    <nav aria-label="Phân trang mục lục" className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} rel="prev" className={pageButton}>
            Trang trước
          </Link>
        ) : (
          <span aria-disabled="true" className={pageButtonOff}>
            Trang trước
          </span>
        )}
        <span className="px-1 text-sm tabular-nums text-text-muted">
          Trang {page}/{pageCount}
        </span>
        {page < pageCount ? (
          <Link href={href(page + 1)} rel="next" className={pageButton}>
            Trang sau
          </Link>
        ) : (
          <span aria-disabled="true" className={pageButtonOff}>
            Trang sau
          </span>
        )}
      </div>
      <form action={`/novel/${novel.id}/toi`} method="get" className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-text-muted">
          Tới chương
          <input
            name="n"
            type="number"
            inputMode="numeric"
            min={1}
            max={novel.chapter_count}
            required
            className={`h-9 w-24 rounded-lg border border-border bg-surface px-2 text-text ${FOCUS_RING}`}
          />
        </label>
        <button type="submit" className={pageButton}>
          Đi
        </button>
      </form>
    </nav>
  );
}

export default async function NovelPage({ params, searchParams }: Props) {
  const id = parseUuid((await params).id);
  if (!id) notFound();

  const supabase = await createClient();
  const [found, resume] = await Promise.all([getNovel(id), loadNovelResume(supabase, id)]);
  if (!found) notFound();
  const { novel, voiceHash } = found;

  const raw = (await searchParams).trang;
  const page = parsePage(Array.isArray(raw) ? raw[0] : raw, pageCountFor(novel.chapter_count));
  const toc = await loadTocPage(supabase, id, voiceHash, page, novel.chapter_count);

  const buttonBase = `inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium transition-transform active:scale-[0.98] ${FOCUS_RING}`;

  return (
    <div className="space-y-10">
      <section className="flex gap-4 sm:gap-6">
        <div className="aspect-[2/3] w-28 shrink-0 self-start overflow-hidden rounded-lg border border-border bg-surface-raised sm:w-44">
          {novel.cover_url ? <CoverImage src={novel.cover_url} eager /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text">{novel.title}</h1>
          <p className="mt-1 text-text-muted">
            {novel.author ?? "Chưa rõ tác giả"}
            {novel.status ? ` · ${STATUS_LABEL[novel.status]}` : ""}
            {` · ${novel.chapter_count} chương`}
          </p>
          {novel.chapter_count > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {resume ? (
                <Link
                  href={`/read/${novel.id}/${resume.chapterIndex}?seg=${resume.segmentIndex}`}
                  className={`${buttonBase} bg-accent text-accent-contrast`}
                >
                  Đọc tiếp
                </Link>
              ) : null}
              <Link
                href={`/read/${novel.id}/1`}
                className={`${buttonBase} border border-border text-text hover:border-border-strong hover:bg-surface-raised`}
              >
                Đọc từ đầu
              </Link>
            </div>
          ) : null}
          {novel.description ? <Description text={novel.description} /> : null}
        </div>
      </section>

      <section aria-labelledby="toc-title" className="space-y-4">
        <h2 id="toc-title" className="text-lg font-semibold tracking-tight text-text">
          Mục lục
        </h2>
        {toc.items.length === 0 ? (
          <p className="text-text-muted">Chưa có chương nào. Worker sẽ tải danh sách chương khi chạy.</p>
        ) : (
          <>
            <Pagination novel={novel} page={toc.page} pageCount={toc.pageCount} />
            <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {toc.items.map((item) => (
                <TocRow key={item.id} novelId={novel.id} item={item} />
              ))}
            </ol>
            <Pagination novel={novel} page={toc.page} pageCount={toc.pageCount} />
          </>
        )}
      </section>
    </div>
  );
}
