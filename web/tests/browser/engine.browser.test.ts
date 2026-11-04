import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchError, MsePlayerEngine, type EngineEvents } from "@/lib/player/engine";
import type { AudioManifest } from "@/lib/types";
import { SEG_URLS, FIXTURE_DURATION_MS, fetchFixture, fixtureManifest, waitFor } from "./fixture";

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
    engine.destroy();

    events = makeEvents();
    const dead = async (url: string) => {
      if (url.includes("seg-0001")) throw new TypeError("network down");
      return fetchFixture(url);
    };
    engine = new MsePlayerEngine(audio, events, { fetchBytes: dead, retryDelaysMs: [1, 1] });
    engine.load(fixtureManifest());
    await waitFor(() => events.fatals.length > 0, "network fatal");
    expect(events.fatals).toEqual(["network"]);
  });

  it("(d) falls back to full.webm on a corrupt chunk", async () => {
    const full = SEG_URLS[0]!; // any playable URL: only the switch is under test
    const corrupt = async (url: string) =>
      url.includes("seg-0001") ? new Uint8Array(2000).fill(0x55).buffer : fetchFixture(url);
    engine = new MsePlayerEngine(audio, events, { fetchBytes: corrupt });
    engine.load(fixtureManifest({ full }));
    await waitFor(() => events.fallbacks > 0, "fallback");
    expect(events.fallbacks).toBe(1);
    expect(audio.src.endsWith(full)).toBe(true);
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

  it("does not assume the buffered end equals duration_ms", async () => {
    const manifest: AudioManifest = fixtureManifest();
    engine = new MsePlayerEngine(audio, events, { fetchBytes: fetchFixture });
    engine.load(manifest);
    await waitFor(() => lastBuffered() > FIXTURE_DURATION_MS - 100, "full buffer");
    expect(lastBuffered()).toBeLessThan(FIXTURE_DURATION_MS + 100);
  });
});
