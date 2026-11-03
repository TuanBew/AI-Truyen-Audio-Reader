"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import type { PendingJob } from "@/lib/data/library";
import { retryJob } from "./actions";

const POLL_MS = 3000;

function label(url: string | null): string {
  if (!url) return "Truyện mới";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function RetryButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-8 shrink-0 rounded-lg border border-border-strong px-3 text-sm text-text transition-transform active:scale-[0.98] disabled:opacity-60"
    >
      Thử lại
    </button>
  );
}

export function PendingJobs({ jobs }: { jobs: PendingJob[] }) {
  const router = useRouter();
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [active, router]);

  if (jobs.length === 0) return null;
  return (
    <section aria-label="Truyện đang tải" className="max-w-xl">
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {jobs.map((job) => (
          <li key={job.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-text">{label(job.url)}</p>
              <p className="text-sm text-text-muted">
                {job.status === "failed"
                  ? (job.error ?? "Tải mục lục thất bại.")
                  : job.status === "running"
                    ? "Đang tải mục lục"
                    : "Đang chờ worker"}
              </p>
            </div>
            {job.status === "failed" ? (
              <form action={retryJob.bind(null, job.id)}>
                <RetryButton />
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
