import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenState } from "@/lib/audio/generation";
import { STORAGE_KEY, createPlayerStore, readPersisted, stepRate } from "./store";

const idle: GenState = { workerOnline: true, kind: "idle" };

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("createPlayerStore", () => {
  it("starts from the defaults", () => {
    const s = createPlayerStore({ gen: idle });
    expect(s.getState()).toMatchObject({
      playing: false,
      currentSeg: null,
      positionMs: 0,
      rate: 1,
      volume: 1,
      pendingSeekSeg: null,
      follow: true,
      error: null,
    });
  });

  it("notifies subscribers on change and not on a no-op", () => {
    const s = createPlayerStore({ gen: idle });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.setState({ playing: true });
    expect(fn).toHaveBeenCalledTimes(1);
    s.setState({ playing: true });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.setState({ playing: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns a new state object only when something changed", () => {
    const s = createPlayerStore({ gen: idle });
    const a = s.getState();
    s.setState({ follow: true });
    expect(s.getState()).toBe(a);
    s.setState({ follow: false });
    expect(s.getState()).not.toBe(a);
  });

  it("clamps rate to 0.75..2 and volume to 0..1", () => {
    const s = createPlayerStore({ gen: idle });
    s.setState({ rate: 5 });
    expect(s.getState().rate).toBe(2);
    s.setState({ rate: 0.1 });
    expect(s.getState().rate).toBe(0.75);
    s.setState({ rate: Number.NaN });
    expect(s.getState().rate).toBe(0.75);
    s.setState({ volume: -3 });
    expect(s.getState().volume).toBe(0);
    s.setState({ volume: 9 });
    expect(s.getState().volume).toBe(1);
  });

  it("persists rate and volume", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const s = createPlayerStore({ gen: idle });
    s.setState({ rate: 1.5, volume: 0.4 });
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)).toEqual({ rate: 1.5, volume: 0.4 });
    expect(readPersisted()).toEqual({ rate: 1.5, volume: 0.4 });
  });

  it("does not write storage for other fields", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const s = createPlayerStore({ gen: idle });
    s.setState({ playing: true, positionMs: 5 });
    expect(storage.data.size).toBe(0);
  });

  it("survives a localStorage whose methods throw", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    });
    const s = createPlayerStore({ gen: idle });
    expect(() => s.setState({ rate: 1.25 })).not.toThrow();
    expect(s.getState().rate).toBe(1.25);
    expect(readPersisted()).toEqual({});
  });

  it("survives a localStorage getter that throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      const s = createPlayerStore({ gen: idle });
      expect(() => s.setState({ volume: 0.5 })).not.toThrow();
      expect(readPersisted()).toEqual({});
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("ignores garbage in storage", () => {
    const storage = memoryStorage();
    storage.data.set(STORAGE_KEY, '{"rate":"fast","volume":7}');
    vi.stubGlobal("localStorage", storage);
    expect(readPersisted()).toEqual({ volume: 1 });
    storage.data.set(STORAGE_KEY, "not json");
    expect(readPersisted()).toEqual({});
  });
});

describe("stepRate", () => {
  it("steps by 0.25 within 0.75..2", () => {
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
    expect(stepRate(0.75, -1)).toBe(0.75);
    expect(stepRate(2, 1)).toBe(2);
    expect(stepRate(1.1, 1)).toBe(1.25); // off-grid values snap
  });
});
