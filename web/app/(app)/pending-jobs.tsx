"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { failedJobText, nextPollDelay, POLL_START_MS } from "@/lib/data/pending-jobs";
import type { PendingJob } from "@/lib/data/library";
import { retryJob, type RetryState } from "./actions";

function label(url: string | null): string {
  if (!url) return "Truyện mới";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

const noError: RetryState = { error: null };

function RetryForm({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(retryJob.bind(null, jobId), noError);
  return (
    <form action={action} className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="submit"
        disabled={pending}
        className="h-8 rounded-lg border border-border-strong px-3 text-sm text-text transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        Thử lại
      </button>
      {state.error ? (
        <p role="alert" className="max-w-56 text-right text-sm text-text-muted">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function PendingJobs({ jobs }: { jobs: PendingJob[] }) {
  const router = useRouter();
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  // Any job changing state restarts the effect, which resets the back-off to the fast interval.
  const signature = jobs.map((j) => `${j.id}:${j.status}`).join(",");

  useEffect(() => {
    if (!active) return;
    let delay = POLL_START_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        delay = nextPollDelay(delay);
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
    // `signature` is a deliberate dependency: it is the reset signal.
  }, [active, signature, router]);

  if (jobs.length === 0) return null;
  return (
    <section aria-label="Truyện đang tải" className="max-w-xl">
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {jobs.map((job) => (
          <li key={job.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-text">{label(job.url)}</p>
              <p className="break-words text-sm text-text-muted">
                {job.status === "failed"
                  ? failedJobText(job.error)
                  : job.status === "running"
                    ? "Đang tải mục lục"
                    : "Đang chờ worker"}
              </p>
            </div>
            {job.status === "failed" ? <RetryForm jobId={job.id} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
