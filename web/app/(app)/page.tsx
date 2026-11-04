import type { Metadata } from "next";
import Link from "next/link";
import { loadLibrary, type NovelCard } from "@/lib/data/library";
import { createClient } from "@/lib/supabase/server";
import { AddNovel } from "./add-novel";
import { CoverImage } from "./cover-image";
import { PendingJobs } from "./pending-jobs";

export const metadata: Metadata = { title: "Thư viện · AudioTruyen" };

function Cover({ novel, eager }: { novel: NovelCard; eager?: boolean }) {
  return (
    <div className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-border bg-surface-raised">
      {novel.coverUrl ? <CoverImage src={novel.coverUrl} eager={eager} /> : null}
    </div>
  );
}

function NovelLink({ novel, eager }: { novel: NovelCard; eager?: boolean }) {
  return (
    <Link href={`/novel/${novel.id}`} className="group block">
      <Cover novel={novel} eager={eager} />
      <h3 className="mt-2 line-clamp-2 text-sm font-medium text-text group-hover:underline">{novel.title}</h3>
      <p className="mt-0.5 text-sm text-text-muted">
        đã đọc {novel.readChapters}/{novel.chapterCount} chương
      </p>
      {novel.newChapters > 0 ? (
        <span className="mt-1 inline-block rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-contrast">
          {novel.newChapters} chương mới
        </span>
      ) : null}
    </Link>
  );
}

export default async function LibraryPage() {
  const supabase = await createClient();
  const { resume, novels, recent, pendingJobs } = await loadLibrary(supabase);

  return (
    <div className="space-y-10">
      {resume ? (
        <section aria-labelledby="resume-title">
          <h2 id="resume-title" className="text-sm font-medium text-text-muted">
            Nghe tiếp
          </h2>
          <Link
            href={`/read/${resume.novelId}/${resume.chapterIndex}?seg=${resume.segmentIndex}`}
            className="mt-2 block max-w-xl rounded-lg border border-border bg-surface-raised p-4 transition-transform hover:border-border-strong active:scale-[0.99]"
          >
            <p className="font-semibold text-text">{resume.novelTitle}</p>
            <p className="mt-1 text-text-muted">{resume.chapterTitle}</p>
          </Link>
        </section>
      ) : null}

      <section aria-label="Thêm truyện" className="space-y-4">
        <AddNovel />
        <PendingJobs jobs={pendingJobs} />
      </section>

      {novels.length === 0 ? (
        <p className="text-text-muted">Chưa có truyện nào. Dán đường dẫn truyện trên truyenfull.live để thêm.</p>
      ) : (
        <>
          <section aria-labelledby="recent-title">
            <h2 id="recent-title" className="text-lg font-semibold tracking-tight text-text">
              Mới thêm
            </h2>
            <ul className="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
              {recent.map((novel) => (
                <li key={novel.id}>
                  <NovelLink novel={novel} eager />
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="all-title">
            <h2 id="all-title" className="text-lg font-semibold tracking-tight text-text">
              Truyện của tôi
            </h2>
            <ul className="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
              {novels.map((novel) => (
                <li key={novel.id}>
                  <NovelLink novel={novel} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
