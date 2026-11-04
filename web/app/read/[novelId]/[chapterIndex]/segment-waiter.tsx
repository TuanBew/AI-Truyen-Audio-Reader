"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TEXT_POLL_START_MS } from "@/lib/reader/shared";
import { nextPollDelay } from "@/lib/data/pending-jobs";

type Props = {
  jobId: string;
  status: string;
};

// Renders nothing. The chapter text is on screen but its analysis (the segment spans) is not saved yet while the
// fetch_chapter job runs: refresh the page (2 s, doubling to 30 s, restarting when the job changes state) until the
// server sends the spans. The page is only given this component while a job is live, so polling stops by itself
// when the job ends or the segments arrive. The player is keyed on the segment state, so it is re-created then.
export function SegmentWaiter({ jobId, status }: Props) {
  const router = useRouter();
  const signature = `${jobId}:${status}`;

  useEffect(() => {
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
  }, [signature, router]);

  return null;
}
