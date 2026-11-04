"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { TEXT_POLL_START_MS, fetchFailedText, requestSafely } from "@/lib/reader/shared";
import { nextPollDelay } from "@/lib/data/pending-jobs";
import type { JobRow } from "@/lib/types";
import { requestChapterText } from "./actions";

type Props = {
  chapterId: string;
  // Newest fetch_chapter job for the chapter, re-read by the server on every router.refresh().
  job: JobRow | null;
  workerOffline: boolean;
};

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";
const OFFLINE_NOTE = "Worker đang tắt. Bật worker trên máy để tải chương.";

// Shown while a chapter has no text. It queues a fetch_chapter job if none is live, then refreshes the page
// (2 s, doubling to 30 s, restarting when the job changes state) until the server renders the text.
// Realtime is not used: `chapters` is not in the publication.
export function TextWaiter({ chapterId, job, workerOffline }: Props) {
  const router = useRouter();
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const requested = useRef(false);

  const status = job?.status ?? null;
  const failed = status === "failed";
  const active = status === "queued" || status === "running";

  const request = useCallback(() => {
    startTransition(async () => {
      const res = await requestSafely(requestChapterText, chapterId);
      if (res.error !== null) {
        setRequestError(res.error);
        return;
      }
      setRequestError(null);
      router.refresh();
    });
  }, [chapterId, router]);

  // Once per mount. A live job needs no request, and a failed one waits for the "Thử lại" button.
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    if (!active && !failed) request();
  }, [active, failed, request]);

  const polling = requestError === null && !failed;
  // A job changing state restarts the effect, which resets the back-off to the fast interval.
  const signature = `${job?.id ?? "none"}:${status ?? "none"}`;

  useEffect(() => {
    if (!polling) return;
    let delay = TEXT_POLL_START_MS;
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
  }, [polling, signature, router]);

  const message = requestError ?? (failed ? fetchFailedText(job?.error ?? null) : null);

  if (message !== null) {
    return (
      <section role="alert" className="space-y-4 px-4 py-10">
        <p className="text-text">{message}</p>
        {workerOffline ? <p className="text-text-muted">{OFFLINE_NOTE}</p> : null}
        <button
          type="button"
          onClick={request}
          disabled={pending}
          className={`h-10 rounded-lg border border-border-strong px-4 text-sm font-medium text-text transition-transform active:scale-[0.98] disabled:opacity-60 ${FOCUS_RING}`}
        >
          Thử lại
        </button>
      </section>
    );
  }

  return (
    <section role="status" className="space-y-2 px-4 py-10">
      <p className="text-text">Đang tải nội dung chương…</p>
      {workerOffline ? <p className="text-text-muted">{OFFLINE_NOTE}</p> : null}
    </section>
  );
}
