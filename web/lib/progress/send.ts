import type { ProgressBody } from "./saver";

const URL_PATH = "/api/progress";

// Fire and forget: a lost save costs at most a few seconds of resume position. A beacon (pagehide) is sent as
// text/plain, which the route also accepts; everything else is a keepalive fetch so it survives a navigation.
export function sendProgress(body: ProgressBody, beacon: boolean): void {
  const json = JSON.stringify(body);
  if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(URL_PATH, json)) return;
    } catch {
      // fall through to fetch
    }
  }
  try {
    void fetch(URL_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // not saved
  }
}
