// Client-safe: no zod, no server modules (this file ships in the reader's first-load JS). The server validates the same
// shape with lib/progress/body.ts.

export type ProgressBody = {
  novelId: string;
  chapterId: string;
  segmentIndex: number;
  positionMs: number;
  finished: boolean;
};

export type SaverClock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ProgressSaver = {
  update(body: ProgressBody): void;
  flush(beacon?: boolean): void;
  dispose(): void;
};

export const SAVE_DEBOUNCE_MS = 2000; // spec 6.3

// Looked up at call time so fake timers installed after import still apply.
const globalClock: SaverClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function same(a: ProgressBody, b: ProgressBody): boolean {
  return (
    a.novelId === b.novelId &&
    a.chapterId === b.chapterId &&
    a.segmentIndex === b.segmentIndex &&
    a.positionMs === b.positionMs &&
    a.finished === b.finished
  );
}

// Debounces the position writes: update() keeps the latest body and sends it SAVE_DEBOUNCE_MS after the last call;
// flush() sends it now (pause, chapter end, pagehide). A body equal to the one last sent is never sent again.
export function createProgressSaver(
  send: (body: ProgressBody, beacon: boolean) => void,
  clock: SaverClock = globalClock,
): ProgressSaver {
  let pending: ProgressBody | null = null;
  let lastSent: ProgressBody | null = null;
  let timer: unknown = null;
  let disposed = false;

  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const flush = (beacon = false) => {
    cancel();
    const body = pending;
    pending = null;
    if (disposed || body === null || (lastSent !== null && same(lastSent, body))) return;
    lastSent = body;
    send(body, beacon);
  };

  return {
    update(body) {
      if (disposed) return;
      pending = body;
      cancel();
      timer = clock.setTimeout(() => {
        timer = null;
        flush(false);
      }, SAVE_DEBOUNCE_MS);
    },
    flush,
    dispose() {
      disposed = true;
      cancel();
      pending = null;
    },
  };
}
