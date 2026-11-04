import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchError, MsePlayerEngine, type EngineEvents } from "@/lib/player/engine";
import type { AudioManifest } from "@/lib/types";
import { INIT_URL, SEG_URLS, FIXTURE_DURATION_MS, fetchFixture, fixtureManifest, fullFileUrl, waitFor } from "./fixture";

let audio: HTMLAudioElement;
let engine: MsePlayerEngine | null;
let sources: MediaSource[];
let revoked: string[];
let events: EngineEvents & { buffered: number[]; fatals: string[]; fallbacks: number };

function makeEvents() {
  const e = {
    buffered: [] as number[],
    fatals: [] as string[],
    fallbacks: 0,
    onBufferedEndMs(ms: number) {
      e.buffered.push(ms);
    },
    onFatal(kind: string) {
      e.fatals.push(kind);
    },
    onFallback() {
      e.fallbacks++;
    },
  };
  return e;
}

const lastBuffered = () => events.buffered[events.buffered.length - 1] ?? 0;

beforeEach(() => {
  audio = new Audio();
  engine = null;
  sources = [];
  revoked = [];
  events = makeEvents();
  const create = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, "createObjectURL").mockImplementation((obj) => {
    if (obj instanceof MediaSource) sources.push(obj);
    return create(obj);
  });
  const revoke = URL.revokeObjectURL.bind(URL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
    revoke(url);
  });
});

afterEach(() => {
  engine?.destroy();
  vi.restoreAllMocks();
});

describe("MsePlayerEngine", () => {
  it("(a) sets the duration of a ready row before the first append and buffers to duration_ms", async () => {
    const durationAtFirstAppend: number[] = [];
    const append = SourceBuffer.prototype.appendBuffer;
    vi.spyOn(SourceBuffer.prototype, "appendBuffer").mockImplementation(function (this: SourceBuffer, data) {
      if (durationAtFirstAppend.length === 0) durationAtFirstAppend.push(sources[0]!.duration);
      return append.call(this, data);
    });

    engine = new MsePlayerEngine(audio, events, { fetchBytes: fetchFixture });
    engine.load(fixtureManifest());
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "full buffer");

    expect(durationAtFirstAppend).toEqual([FIXTURE_DURATION_MS / 1000]);
    expect(Math.abs(lastBuffered() - FIXTURE_DURATION_MS)).toBeLessThan(50);
    expect(events.fatals).toEqual([]);
  });

  it("(b) appends a growing partial row and ends the stream once when it becomes ready", async () => {
    const endOfStream = vi.spyOn(MediaSource.prototype, "endOfStream");
    engine = new MsePlayerEngine(audio, events, { fetchBytes: fetchFixture });
    engine.load(fixtureManifest({ status: "partial", durationMs: null }, 1));
    await waitFor(() => lastBuffered() > 9_900, "first cluster");
    expect(lastBuffered()).toBeLessThan(10_100);
    expect(endOfStream).not.toHaveBeenCalled();

    engine.update(fixtureManifest({ status: "ready" }));
    await waitFor(() => endOfStream.mock.calls.length === 1, "endOfStream");
    expect(Math.abs(lastBuffered() - FIXTURE_DURATION_MS)).toBeLessThan(50);
    engine.update(fixtureManifest({ status: "ready" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(endOfStream).toHaveBeenCalledTimes(1);
    expect(events.fatals).toEqual([]);
  });

  it("(c) refreshes once on a 403 and continues; a second 403 is fatal", async () => {
    let failed = false;
    const refresh = vi.fn(async () => fixtureManifest({}, 3, "?fresh=1"));
    const fetchBytes = async (url: string) => {
      if (url.includes("seg-0001") && !url.includes("fresh") && !failed) {
        failed = true;
        throw new FetchError(403);
      }
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes, refreshManifest: refresh });
    engine.load(fixtureManifest());
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "full buffer after refresh");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(events.fatals).toEqual([]);
    engine.destroy();

    const refresh2 = vi.fn(async () => fixtureManifest({}, 3, "?fresh=1"));
    const always403 = async (url: string) => {
      if (url.includes("seg-0001")) throw new FetchError(403);
      return fetchFixture(url);
    };
    events = makeEvents();
    engine = new MsePlayerEngine(audio, events, { fetchBytes: always403, refreshManifest: refresh2 });
    engine.load(fixtureManifest());
    await waitFor(() => events.fatals.length > 0, "fatal");
    expect(events.fatals).toEqual(["expired"]);
    expect(refresh2).toHaveBeenCalledTimes(1);
  });

  it("(c2) a successful chunk resets the refresh budget, so a later expiry also recovers", async () => {
    // seg-0001 expires with the original URLs; seg-0002 expires with the URLs of the first refresh.
    const failedOnce = new Set<string>();
    let refreshes = 0;
    const refresh = vi.fn(async () => fixtureManifest({}, 3, `?fresh=${++refreshes}`));
    const fetchBytes = async (url: string) => {
      const expired = (url.includes("seg-0001") && !url.includes("fresh")) || (url.includes("seg-0002") && url.endsWith("fresh=1"));
      if (expired && !failedOnce.has(url)) {
        failedOnce.add(url);
        throw new FetchError(403);
      }
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes, refreshManifest: refresh });
    engine.load(fixtureManifest());
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "full buffer");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(events.fatals).toEqual([]);
  });

  it("(c3) retries network failures twice, then reports network", async () => {
    let calls = 0;
    const flaky = async (url: string) => {
      if (url.includes("seg-0001") && ++calls <= 2) throw new TypeError("network down");
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes: flaky, retryDelaysMs: [1, 1] });
    engine.load(fixtureManifest());
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "recovered buffer");
    expect(events.fatals).toEqual([]);
    expect(calls).toBe(3); // two failures, then the success
    engine.destroy();

    events = makeEvents();
    let deadCalls = 0;
    const dead = async (url: string) => {
      if (url.includes("seg-0001")) {
        deadCalls++;
        throw new TypeError("network down");
      }
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes: dead, retryDelaysMs: [1, 1] });
    engine.load(fixtureManifest());
    await waitFor(() => events.fatals.length > 0, "network fatal");
    expect(events.fatals).toEqual(["network"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(deadCalls).toBe(3); // the first try plus exactly 2 retries, then no more
  });

  it("(d) falls back to full.webm on a corrupt chunk", async () => {
    const full = await fullFileUrl();
    const corrupt = async (url: string) =>
      url.includes("seg-0001") ? new Uint8Array(2000).fill(0x55).buffer : fetchFixture(url);
    engine = new MsePlayerEngine(audio, events, { fetchBytes: corrupt });
    engine.load(fixtureManifest({ full }));
    await waitFor(() => events.fallbacks > 0, "fallback");
    expect(events.fallbacks).toBe(1);
    expect(audio.src).toBe(full);
    expect(events.fatals).toEqual([]);

    engine.destroy();
    events = makeEvents();
    engine = new MsePlayerEngine(audio, events, { fetchBytes: corrupt });
    engine.load(fixtureManifest({ full: null }));
    await waitFor(() => events.fatals.length > 0, "mse fatal");
    expect(events.fatals).toEqual(["mse"]);
    expect(events.fallbacks).toBe(0);
  });

  it("(e) load() with a new attempt replaces the MediaSource and revokes the old URL", async () => {
    engine = new MsePlayerEngine(audio, events, { fetchBytes: fetchFixture });
    engine.load(fixtureManifest({ attempt: 1 }));
    const oldUrl = audio.src;
    expect(engine.attempt).toBe(1);
    engine.update(fixtureManifest({ attempt: 2 }));
    expect(engine.attempt).toBe(2);
    expect(sources).toHaveLength(2);
    expect(sources[1]).not.toBe(sources[0]);
    expect(revoked).toContain(oldUrl);
    expect(audio.src).not.toBe(oldUrl);
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "new attempt buffer");
  });

  it("destroy() during an in-flight fetch does not throw or fire events afterwards", async () => {
    let release!: (b: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((resolve) => (release = resolve));
    let started = false;
    const slow = (url: string) => {
      if (url.includes("seg-0000")) {
        started = true;
        return pending;
      }
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes: slow });
    engine.load(fixtureManifest());
    await waitFor(() => started, "chunk fetch started");
    engine.destroy();
    release(await fetchFixture(SEG_URLS[0]!));
    await new Promise((r) => setTimeout(r, 200));
    expect(events.buffered).toEqual([]);
    expect(events.fatals).toEqual([]);
    expect(events.fallbacks).toBe(0);
  });

  it("a new attempt during an in-flight fetch never lets the stale bytes reach the new SourceBuffer", async () => {
    for (const how of ["load", "update"] as const) {
      events = makeEvents();
      const appended: ArrayBuffer[] = [];
      const append = SourceBuffer.prototype.appendBuffer;
      const spy = vi.spyOn(SourceBuffer.prototype, "appendBuffer").mockImplementation(function (
        this: SourceBuffer,
        data,
      ) {
        appended.push(data as ArrayBuffer);
        return append.call(this, data);
      });
      const stale = (await fetchFixture(SEG_URLS[0]!)).slice(0);
      let release!: (b: ArrayBuffer) => void;
      let started = false;
      const fetchBytes = (url: string) => {
        if (url.includes("seg-0000") && url.includes("stale=1")) {
          started = true;
          return new Promise<ArrayBuffer>((resolve) => (release = resolve));
        }
        return fetchFixture(url);
      };
      engine = new MsePlayerEngine(audio, events, { fetchBytes });
      engine.load(fixtureManifest({ attempt: 1 }, 3, "?stale=1"));
      await waitFor(() => started, "stale fetch started");
      const next = fixtureManifest({ attempt: 2 });
      if (how === "load") engine.load(next);
      else engine.update(next);
      release(stale);
      await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "attempt 2 buffer");
      expect(appended).not.toContain(stale);
      expect(appended).toHaveLength(5); // the old init, then init + 3 clusters of the new attempt; never the stale cluster
      expect(events.fatals).toEqual([]);
      expect(engine.attempt).toBe(2);
      engine.destroy();
      spy.mockRestore();
    }
  });

  it("update() during an in-flight append keeps the order and appends each chunk once", async () => {
    const lengths: number[] = [];
    const append = SourceBuffer.prototype.appendBuffer;
    let updated = false;
    vi.spyOn(SourceBuffer.prototype, "appendBuffer").mockImplementation(function (this: SourceBuffer, data) {
      lengths.push((data as ArrayBuffer).byteLength);
      const result = append.call(this, data);
      if (!updated && lengths.length === 2) {
        updated = true; // the first cluster is being appended right now
        engine!.update(fixtureManifest({ status: "ready" }));
      }
      return result;
    });
    engine = new MsePlayerEngine(audio, events, { fetchBytes: fetchFixture });
    engine.load(fixtureManifest({ status: "partial", durationMs: null }, 1));
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "full buffer");
    const expected = await Promise.all([INIT_URL, ...SEG_URLS].map(async (u) => (await fetchFixture(u)).byteLength));
    expect(lengths).toEqual(expected);
    expect(events.fatals).toEqual([]);
  });

  it("reports nothing from the MSE path after a fallback and stops fetching", async () => {
    let seg2Calls = 0;
    let release!: (b: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((resolve) => (release = resolve));
    const fetchBytes = (url: string) => {
      if (url.includes("seg-0001")) return Promise.resolve(new Uint8Array(2000).fill(0x55).buffer);
      if (url.includes("seg-0002")) {
        seg2Calls++;
        return pending;
      }
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes, retryDelaysMs: [1, 1] });
    engine.load(fixtureManifest({ full: await fullFileUrl() }));
    await waitFor(() => events.fallbacks > 0, "fallback");
    const before = events.buffered.length;
    release(await fetchFixture(SEG_URLS[2]!));
    await new Promise((r) => setTimeout(r, 200));
    expect(events.buffered).toHaveLength(before);
    expect(events.fatals).toEqual([]);
    expect(events.fallbacks).toBe(1);
    expect(seg2Calls).toBeLessThanOrEqual(1);
  });

  it("a dead full.webm reports an error instead of hanging", async () => {
    const corrupt = async (url: string) =>
      url.includes("seg-0001") ? new Uint8Array(2000).fill(0x55).buffer : fetchFixture(url);
    engine = new MsePlayerEngine(audio, events, { fetchBytes: corrupt });
    engine.load(fixtureManifest({ full: "/tests/fixtures/sine-25s/missing-full.webm" }));
    await waitFor(() => events.fatals.length > 0, "error from the dead full URL");
    expect(events.fallbacks).toBe(1);
    expect(events.fatals).toEqual(["expired"]);
  });

  it("refreshes the manifest before falling back and uses the newest full URL", async () => {
    const corrupt = async (url: string) =>
      url.includes("seg-0001") ? new Uint8Array(2000).fill(0x55).buffer : fetchFixture(url);
    const good = await fullFileUrl();
    const refresh = vi.fn(async () => fixtureManifest({ full: good }));
    engine = new MsePlayerEngine(audio, events, { fetchBytes: corrupt, refreshManifest: refresh });
    engine.load(fixtureManifest({ full: "/tests/fixtures/sine-25s/expired-full.webm" }));
    await waitFor(() => events.fallbacks > 0, "fallback");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe(good);
    await waitFor(() => audio.readyState >= 1, "full file metadata");
    expect(events.fatals).toEqual([]);

    // A failed refresh falls back to the URL already in hand.
    engine.destroy();
    events = makeEvents();
    engine = new MsePlayerEngine(audio, events, {
      fetchBytes: corrupt,
      refreshManifest: async () => {
        throw new Error("offline");
      },
    });
    engine.load(fixtureManifest({ full: good }));
    await waitFor(() => events.fallbacks > 0, "fallback after failed refresh");
    expect(audio.src).toBe(good);
  });

  it("destroy() removes the fallback listeners", async () => {
    const removed: string[] = [];
    const remove = audio.removeEventListener.bind(audio);
    vi.spyOn(audio, "removeEventListener").mockImplementation((type, listener, options) => {
      removed.push(type);
      remove(type, listener, options);
    });
    const corrupt = async (url: string) =>
      url.includes("seg-0001") ? new Uint8Array(2000).fill(0x55).buffer : fetchFixture(url);
    engine = new MsePlayerEngine(audio, events, { fetchBytes: corrupt });
    // Destroy right inside onFallback, before the full file has loaded its metadata.
    events.onFallback = () => {
      events.fallbacks++;
      removed.length = 0;
      engine!.destroy();
    };
    engine.load(fixtureManifest({ full: await fullFileUrl() }));
    await waitFor(() => events.fallbacks > 0, "fallback");
    expect(removed).toContain("loadedmetadata");
    expect(removed).toContain("error");
    expect(events.fatals).toEqual([]);
  });

  it("does not assume the buffered end equals duration_ms", async () => {
    const manifest: AudioManifest = fixtureManifest();
    engine = new MsePlayerEngine(audio, events, { fetchBytes: fetchFixture });
    engine.load(manifest);
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "full buffer");
    expect(lastBuffered()).toBeLessThan(FIXTURE_DURATION_MS + 100);
  });
});
