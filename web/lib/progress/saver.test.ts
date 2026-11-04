import { describe, expect, it, vi } from "vitest";
import { createProgressSaver, type ProgressBody } from "./saver";

const body = (over: Partial<ProgressBody> = {}): ProgressBody => ({
  novelId: "n",
  chapterId: "c",
  segmentIndex: 0,
  positionMs: 0,
  finished: false,
  ...over,
});

// A fake clock: timers fire only when advance() passes their time.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: unknown) {
      timers.delete(id as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe("createProgressSaver", () => {
  it("three updates within 2 s send once, with the last body", () => {
    const clock = fakeClock();
    const send = vi.fn();
    const saver = createProgressSaver(send, clock);
    saver.update(body({ segmentIndex: 1 }));
    clock.advance(500);
    saver.update(body({ segmentIndex: 2 }));
    clock.advance(500);
    saver.update(body({ segmentIndex: 3 }));
    clock.advance(1999);
    expect(send).not.toHaveBeenCalled();
    clock.advance(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(body({ segmentIndex: 3 }), false);
  });

  it("flush sends immediately and cancels the timer", () => {
    const clock = fakeClock();
    const send = vi.fn();
    const saver = createProgressSaver(send, clock);
    saver.update(body({ segmentIndex: 4 }));
    saver.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
    clock.advance(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending sends nothing", () => {
    const send = vi.fn();
    createProgressSaver(send, fakeClock()).flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("flush after the same body was already sent sends nothing", () => {
    const clock = fakeClock();
    const send = vi.fn();
    const saver = createProgressSaver(send, clock);
    saver.update(body({ segmentIndex: 5 }));
    clock.advance(2000);
    expect(send).toHaveBeenCalledTimes(1);
    saver.update(body({ segmentIndex: 5 }));
    saver.flush();
    clock.advance(2000);
    expect(send).toHaveBeenCalledTimes(1);
    saver.update(body({ segmentIndex: 5, positionMs: 1 }));
    saver.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("flush(true) passes beacon = true", () => {
    const send = vi.fn();
    const saver = createProgressSaver(send, fakeClock());
    saver.update(body({ segmentIndex: 6 }));
    saver.flush(true);
    expect(send).toHaveBeenCalledWith(body({ segmentIndex: 6 }), true);
  });

  it("dispose stops pending sends", () => {
    const clock = fakeClock();
    const send = vi.fn();
    const saver = createProgressSaver(send, clock);
    saver.update(body({ segmentIndex: 7 }));
    saver.dispose();
    clock.advance(5000);
    saver.update(body({ segmentIndex: 8 }));
    saver.flush();
    expect(send).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("works with the global timers (vitest fake timers) when no clock is given", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const saver = createProgressSaver(send);
      saver.update(body({ segmentIndex: 9 }));
      vi.advanceTimersByTime(2000);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
