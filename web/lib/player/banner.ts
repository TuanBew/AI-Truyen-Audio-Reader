import { formatClock } from "./timeline";
import type { PlayerState } from "./store";

export type BannerMessage = {
  text: string;
  retry: boolean; // show "Thử lại"
  alert: boolean; // an error (role="alert") rather than progress (role="status")
};

// The line above the player bar. Errors win; then the generation state; a click on a segment that does not exist yet
// adds a note to whichever line is showing.
export function bannerMessage(s: PlayerState): BannerMessage | null {
  if (s.error) return { text: s.error, retry: s.canRetry, alert: true };

  const g = s.gen;
  let text: string | null = null;
  let retry = false;
  let alert = false;

  switch (g.kind) {
    case "failed":
      text = g.error;
      retry = true;
      alert = true;
      break;
    case "partial":
      if (g.jobError) {
        text = g.jobError.error;
        retry = true;
        alert = true;
      } else if (!g.workerOnline) {
        text = offlineText(s.workerAgoMin);
      } else {
        text = `Đang tạo âm thanh, đã có ${formatClock(g.generatedMs)}`;
      }
      break;
    case "queued":
      text = !g.workerOnline
        ? offlineText(s.workerAgoMin)
        : g.position === null
          ? "Đang chờ tạo âm thanh"
          : `Đang chờ tạo âm thanh (vị trí ${g.position})`;
      break;
    case "starting":
      text = g.workerOnline ? "Đang tạo âm thanh…" : offlineText(s.workerAgoMin);
      break;
    default:
      break;
  }

  if (s.pendingSeekSeg !== null && !alert) {
    const note = g.kind === "ready" ? "Đang tải tới đoạn này…" : "Đang tạo tới đoạn này…";
    text = text === null ? note : `${text}. ${note}`;
  }
  return text === null ? null : { text, retry, alert };
}

function offlineText(agoMin: number | null): string {
  const since = agoMin === null ? "" : ` (lần cuối ${agoMin} phút trước)`;
  return `Worker đang tắt${since}. Chương sẽ được tạo khi worker bật lại.`;
}
