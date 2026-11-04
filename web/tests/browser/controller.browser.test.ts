import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generationState } from "@/lib/audio/generation";
import {
  ManifestError,
  PlayerController,
  TEXT_AUTOPLAY,
  TEXT_LAST_CHAPTER,
  TEXT_RELOAD_PAGE,
  TEXT_SESSION_ENDED,
  type ControllerDeps,
  type EngineLike,
  type PlayerActions,
} from "@/lib/player/controller";
import type { EngineEvents } from "@/lib/player/engine";
import { createPlayerStore, type PlayerStore } from "@/lib/player/store";
import type { ProgressBody } from "@/lib/progress/saver";
import type { AudioChunk, AudioManifest, AudioRow, AudioSnapshot, JobRow, TimedSegment } from "@/lib/types";
import { FIXTURE_CHUNKS, FIXTURE_DURATION_MS, fixtureManifest, waitFor } from "./fixture";

// The controller against a real <audio> element. Network, Realtime and (for the timer tests) the engine are injected.

const CH = "11111111-1111-4111-8111-111111111111";
const AUDIO_ID = "00000000-0000-4000-8000-000000000001";

type Pr = { ctl: PlayerController } & Record<string, unknown>;
const priv = (ctl: PlayerController) =>
  ctl as unknown as {
    applySnapshot(s: AudioSnapshot): void;
    requestManifest(o?: { force?: boolean }): void;
  };

function article(n = 3): void {
  document.body.innerHTML = `<article id="reader-text">${Array.from(
    { length: n },
    (_, i) => `<p><span data-seg="${i}" data-kind="narration">Câu số ${i}.</span></p>`,
  ).join("")}</article>`;
}

const chunk = (n: number): AudioChunk => ({ key: `c${n}`, start_ms: n * 1000, end_ms: n * 1000 + 900 });

function job(status: JobRow["status"] = "running", over: Partial<JobRow> = {}): JobRow {
  return { id: "job-1", type: "synthesize", status, error: null, priority: 0, created_at: "2026-01-01T00:00:00Z", ...over };
}

function snap(audio: Partial<AudioRow> | null, j: JobRow | null = job(), over: Partial<AudioSnapshot> = {}): AudioSnapshot {
  return {
    chapterId: CH,
    voiceHash: "v",
    chapterTextHash: "t1",
    audio: audio && {
      id: AUDIO_ID,
      attempt: 1,
      status: "partial",
      voice_hash: "v",
      text_hash: "t1",
      init_key: "init",
      chunks: [chunk(0)],
      full_key: null,
      duration_ms: null,
      segments: [],
      updated_at: "2026-01-01T00:00:00Z",
      ...audio,
    },
    job: j,
    queuePosition: null,
    workerLastSeen: new Date().toISOString(),
    ...over,
  };
}

const partial = (chunks = 1, segments: TimedSegment[] = []) =>
  snap({ chunks: Array.from({ length: chunks }, (_, n) => chunk(n)), segments });

// A ready row over the 25 s fixture; segment i starts at starts[i].
function fixtureSnap(attempt: number, starts: number[], status: "ready" | "partial" = "ready"): AudioSnapshot {
  const segments = starts.map((s, i) => ({ i, start_ms: s, end_ms: (starts[i + 1] ?? FIXTURE_DURATION_MS) - 100 }));
  return snap(
    {
      attempt,
      status,
      duration_ms: status === "ready" ? FIXTURE_DURATION_MS : null,
      chunks: FIXTURE_CHUNKS.map((c) => ({ key: c.file, start_ms: c.start_ms, end_ms: c.end_ms })),
      segments,
    },
    status === "ready" ? job("done") : job("running"),
  );
}

function fakeEngine() {
  const e = {
    attempt: null as number | null,
    loads: [] as AudioManifest[],
    updates: [] as AudioManifest[],
    destroyed: false,
    events: null as EngineEvents | null,
    load(m: AudioManifest) {
      e.attempt = m.attempt;
      e.loads.push(m);
    },
    update(m: AudioManifest) {
      if (m.attempt !== e.attempt) e.load(m);
      else e.updates.push(m);
    },
    destroy() {
      e.destroyed = true;
    },
  };
  return e;
}

function fakeClient() {
  const handlers: (() => void)[] = [];
  let statusCb: ((s: string) => void) | null = null;
  let systemCb: ((p: { status: string }) => void) | null = null;
  const channel = {
    on(type: string, _cfg: unknown, cb: (p: never) => void) {
      if (type === "postgres_changes") handlers.push(cb as () => void);
      else systemCb = cb as never;
      return channel;
    },
    subscribe(cb: (s: string) => void) {
      statusCb = cb;
      return channel;
    },
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => "ok"),
    auth: { getSession: async () => ({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
  };
  return {
    client: client as unknown as SupabaseClient,
    raw: client,
    fire: () => handlers.forEach((h) => h()),
    status: (s: string) => statusCb?.(s),
    system: (status: string) => systemCb?.({ status }),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let audios: HTMLAudioElement[];
let made: PlayerController[];

function make(
  snapshot: AudioSnapshot,
  over: {
    actions?: Partial<PlayerActions>;
    deps?: ControllerDeps;
    initialSegment?: number | null;
    nextHref?: string | null;
    sendProgress?: (body: ProgressBody, beacon: boolean) => void;
  } = {},
) {
  const store: PlayerStore = createPlayerStore({ gen: generationState(snapshot, Date.now()) });
  const actions: PlayerActions = {
    ensureChapterAudio: vi.fn(async () => ({ snapshot, error: null })),
    readAudioSnapshot: vi.fn(async () => ({ snapshot, error: null })),
    retrySynthesis: vi.fn(async () => ({ snapshot, error: null })),
    prefetchAfter: vi.fn(async () => ({ enqueued: 0, error: null })),
    ...over.actions,
  };
  const fc = fakeClient();
  const engine = fakeEngine();
  const deps: ControllerDeps = {
    loadClient: async () => fc.client,
    createEngine: async (_a, events) => {
      engine.events = events;
      return engine as EngineLike;
    },
    ...over.deps,
  };
  const sendProgress = vi.fn(over.sendProgress ?? (() => {}));
  const navigate = vi.fn();
  const ctl = new PlayerController({
    chapterId: CH,
    novelId: "n",
    chapterIndex: 1,
    snapshot,
    initialSegment: over.initialSegment ?? null,
    store,
    actions,
    deps: { ...deps, sendProgress },
    nextHref: over.nextHref ?? null,
    navigate,
  });
  made.push(ctl);
  return { ctl, store, actions, fc, engine, sendProgress, navigate };
}

beforeEach(() => {
  audios = [];
  made = [];
  article();
  localStorage.clear();
  const Native = window.Audio;
  vi.stubGlobal(
    "Audio",
    class extends Native {
      constructor() {
        super();
        audios.push(this);
      }
    },
  );
});

afterEach(() => {
  for (const c of made) c.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const flush = () => vi.advanceTimersByTimeAsync(1);
const okManifest = (over: Partial<AudioManifest> = {}) => fixtureManifest({ status: "partial", durationMs: null, ...over }, 1);

describe("snapshot reads", () => {
  it("debounces events, keeps one read in flight and runs one trailing read afterwards", async () => {
    vi.useFakeTimers();
    const reads: ReturnType<typeof deferred<{ snapshot: AudioSnapshot; error: null }>>[] = [];
    const s = snap(null);
    const { ctl, fc, actions } = make(s, {
      actions: {
        readAudioSnapshot: vi.fn(() => {
          const d = deferred<{ snapshot: AudioSnapshot; error: null }>();
          reads.push(d);
          return d.promise;
        }),
      },
    });
    ctl.play();
    await flush();
    fc.status("SUBSCRIBED"); // catch-up read is scheduled
    fc.fire();
    fc.fire();
    fc.fire();
    await vi.advanceTimersByTimeAsync(499);
    expect(actions.readAudioSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(actions.readAudioSnapshot).toHaveBeenCalledTimes(1); // the burst became one read

    fc.fire(); // events while a read is in flight
    fc.fire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(actions.readAudioSnapshot).toHaveBeenCalledTimes(1); // still one in flight

    reads[0]!.resolve({ snapshot: s, error: null });
    await vi.advanceTimersByTimeAsync(499);
    expect(actions.readAudioSnapshot).toHaveBeenCalledTimes(1); // the trailing read is debounced too
    await vi.advanceTimersByTimeAsync(1);
    expect(actions.readAudioSnapshot).toHaveBeenCalledTimes(2);
    reads[1]!.resolve({ snapshot: s, error: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(actions.readAudioSnapshot).toHaveBeenCalledTimes(2); // nothing else was pending
  });

  it("a failed read while generating starts the 5 s poll until a read succeeds with a healthy channel", async () => {
    vi.useFakeTimers();
    const s = snap(null);
    const results: (() => Promise<{ snapshot: AudioSnapshot | null; error: string | null }>)[] = [
      async () => ({ snapshot: null, error: "x" }),
      async () => {
        throw new Error("offline");
      },
      async () => ({ snapshot: s, error: null }),
    ];
    const read = vi.fn(async () => (results.shift() ?? results[0] ?? (async () => ({ snapshot: s, error: null })))());
    const { ctl, fc } = make(s, { actions: { readAudioSnapshot: read as never } });
    ctl.play();
    await flush();
    fc.status("SUBSCRIBED"); // healthy channel: no poll
    await vi.advanceTimersByTimeAsync(500); // read 1 fails
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000 + 500); // poll tick, debounce, read 2 throws
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000 + 500); // read 3 succeeds and the poll stops
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("a dead channel (error status or system error) polls every 5 s until SUBSCRIBED", async () => {
    vi.useFakeTimers();
    const { ctl, fc, actions } = make(snap(null));
    ctl.play();
    await flush();
    fc.system("error");
    await vi.advanceTimersByTimeAsync(12_000);
    expect((actions.readAudioSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    fc.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(600); // the catch-up read
    const n = (actions.readAudioSnapshot as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect((actions.readAudioSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n);
  });
});

describe("signed URL manifest", () => {
  it("a 429 waits 30 s, keeps what is loaded and shows no error", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const t0 = Date.now();
    const fetchManifest = vi.fn(async () => {
      calls.push(Date.now() - t0);
      if (calls.length === 2) throw new ManifestError(429);
      return okManifest();
    });
    const { ctl, store, engine } = make(partial(1), { deps: { fetchManifest } });
    ctl.play();
    await flush();
    expect(engine.loads).toHaveLength(1);
    priv(ctl).applySnapshot(partial(2)); // more chunks: a refresh, at least 2 s after the first
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls).toHaveLength(2);
    expect(store.getState().error).toBeNull(); // something is loaded: no fatal error
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(3);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(30_000);
    expect(engine.loads).toHaveLength(1);
    expect(engine.updates).toHaveLength(1);
    expect(store.getState().error).toBeNull();
  });

  it("other failures back off 5, 10, 20, 40 s and give up after the fifth", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const t0 = Date.now();
    let first = true;
    const fetchManifest = vi.fn(async () => {
      calls.push(Date.now() - t0);
      if (first) {
        first = false;
        return okManifest(); // loaded once, so playback is under way
      }
      throw new ManifestError(503);
    });
    const { ctl, store } = make(partial(1), { deps: { fetchManifest } });
    ctl.play();
    await flush();
    const base = calls.length;
    calls.length = 0;
    const t1 = Date.now();
    priv(ctl).requestManifest({ force: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(base).toBe(1);
    const gaps = calls.map((t) => Math.round((t + t0 - t1) / 1000));
    expect(gaps).toEqual([0, 5, 15, 35, 75]);
    expect(store.getState().error).toBe(TEXT_RELOAD_PAGE);
    expect(store.getState().canRetry).toBe(false);
  });

  it("a success resets the failure count", async () => {
    vi.useFakeTimers();
    const outcomes = ["ok", 500, 500, "ok", 500, "ok", "ok", "ok"] as const;
    const calls: number[] = [];
    const t0 = Date.now();
    let n = 0;
    const fetchManifest = vi.fn(async () => {
      calls.push(Date.now() - t0);
      const o = outcomes[Math.min(n++, outcomes.length - 1)]!;
      if (o !== "ok") throw new ManifestError(o);
      return okManifest();
    });
    const { ctl } = make(partial(1), { deps: { fetchManifest } });
    ctl.play();
    await flush(); // call 1 ok
    priv(ctl).requestManifest({ force: true }); // call 2: fail, retry in 5 s
    await vi.advanceTimersByTimeAsync(5100); // call 3: fail, retry in 10 s
    await vi.advanceTimersByTimeAsync(10_100); // call 4: ok, count reset
    expect(calls).toHaveLength(4);
    const t = calls[3]!;
    priv(ctl).requestManifest({ force: true }); // call 5: fails once more: retry in 5 s, not 20 s
    await flush();
    expect(calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(5100);
    expect(calls).toHaveLength(6);
    expect(calls[5]! - calls[4]!).toBeLessThan(6000);
    expect(t).toBeGreaterThan(0);
  });

  it.each([
    [401, TEXT_SESSION_ENDED],
    [403, TEXT_RELOAD_PAGE],
    [404, TEXT_RELOAD_PAGE],
  ])("%i is never retried and says what to do", async (status, text) => {
    vi.useFakeTimers();
    let first = true;
    const fetchManifest = vi.fn(async () => {
      if (first) {
        first = false;
        return okManifest();
      }
      throw new ManifestError(status);
    });
    const { ctl, store } = make(partial(1), { deps: { fetchManifest } });
    ctl.play();
    await flush();
    priv(ctl).requestManifest({ force: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchManifest).toHaveBeenCalledTimes(2);
    expect(store.getState().error).toBe(text);
  });

  it("never retries once a ready row is fully appended", async () => {
    vi.useFakeTimers();
    let first = true;
    const fetchManifest = vi.fn(async () => {
      if (first) {
        first = false;
        return fixtureManifest({}, 3);
      }
      throw new ManifestError(500);
    });
    const { ctl, engine } = make(fixtureSnap(1, [0, 10_000, 20_000]), { deps: { fetchManifest } });
    ctl.play();
    await flush();
    engine.events!.onBufferedEndMs(FIXTURE_DURATION_MS + 21);
    priv(ctl).requestManifest({ force: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchManifest).toHaveBeenCalledTimes(2); // the failing one, once
  });
});

describe("destroy during every async gap", () => {
  function watch(store: PlayerStore) {
    const w = { writes: 0 };
    store.subscribe(() => w.writes++);
    return w;
  }
  const clean = (w: { writes: number }) => {
    expect(w.writes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  };

  it("while ensureChapterAudio is pending", async () => {
    vi.useFakeTimers();
    const d = deferred<{ snapshot: AudioSnapshot; error: null }>();
    const fetchManifest = vi.fn(async () => okManifest());
    const loadClient = vi.fn(async () => fakeClient().client);
    const { ctl, store, actions } = make(partial(1), {
      actions: { ensureChapterAudio: vi.fn(() => d.promise) },
      deps: { fetchManifest, loadClient },
    });
    ctl.play();
    await flush();
    const w = watch(store);
    ctl.destroy();
    d.resolve({ snapshot: snap(null), error: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadClient).not.toHaveBeenCalled();
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(actions.prefetchAfter).not.toHaveBeenCalled();
    clean(w);
  });

  it("while the Realtime client is loading, and after the channel exists", async () => {
    vi.useFakeTimers();
    const d = deferred<SupabaseClient>();
    const late = fakeClient();
    const a = make(snap(null), { deps: { loadClient: () => d.promise } });
    a.ctl.play();
    await flush();
    const w = watch(a.store);
    a.ctl.destroy();
    d.resolve(late.client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.raw.channel).not.toHaveBeenCalled();
    clean(w);

    const b = make(snap(null));
    b.ctl.play();
    await flush();
    b.fc.status("CHANNEL_ERROR"); // the poll timer exists
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    const w2 = watch(b.store);
    b.ctl.destroy();
    expect(b.fc.raw.removeChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    clean(w2);
  });

  it("while the manifest or the engine is pending", async () => {
    vi.useFakeTimers();
    const d = deferred<AudioManifest>();
    const engine = fakeEngine();
    const a = make(fixtureSnap(1, [0, 10_000, 20_000]), {
      deps: { fetchManifest: () => d.promise, createEngine: async () => engine as EngineLike },
    });
    a.ctl.play();
    await flush();
    const w = watch(a.store);
    a.ctl.destroy();
    d.resolve(fixtureManifest());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.loads).toHaveLength(0);
    expect(engine.destroyed).toBe(true);
    clean(w);

    const e = deferred<EngineLike>();
    const late = fakeEngine();
    const b = make(fixtureSnap(1, [0, 10_000, 20_000]), {
      deps: { fetchManifest: async () => fixtureManifest(), createEngine: () => e.promise },
    });
    b.ctl.play();
    await flush();
    const w2 = watch(b.store);
    b.ctl.destroy();
    e.resolve(late as EngineLike);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.loads).toHaveLength(0);
    expect(late.destroyed).toBe(true);
    clean(w2);
  });

  it("while a snapshot read is in flight and while a backoff timer is armed", async () => {
    vi.useFakeTimers();
    const d = deferred<{ snapshot: AudioSnapshot; error: null }>();
    const a = make(snap(null), { actions: { readAudioSnapshot: vi.fn(() => d.promise) } });
    a.ctl.play();
    await flush();
    a.fc.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(500);
    const w = watch(a.store);
    a.ctl.destroy();
    d.resolve({ snapshot: fixtureSnap(1, [0, 10_000, 20_000]), error: null });
    await vi.advanceTimersByTimeAsync(60_000);
    clean(w);

    let first = true;
    const b = make(partial(1), {
      deps: {
        fetchManifest: async () => {
          if (first) {
            first = false;
            return okManifest();
          }
          throw new ManifestError(500);
        },
      },
    });
    b.ctl.play();
    await flush();
    priv(b.ctl).requestManifest({ force: true });
    await flush(); // fails, retry armed
    const w2 = watch(b.store);
    b.ctl.destroy();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    clean(w2);
  });
});

// ---- real <audio> and the real MSE engine on the fixture ----------------------------------------------------

describe("playback on the fixture", () => {
  const STARTS = [0, 10_000, 20_000];
  const lastAudio = () => audios[audios.length - 1]!;

  function real(snapshot: AudioSnapshot, manifests: () => AudioManifest) {
    return make(snapshot, { deps: { fetchManifest: async () => manifests(), createEngine: undefined } });
  }

  it("a seek to a segment that starts at 0 moves the playhead back to 0", async () => {
    const { ctl, store } = real(fixtureSnap(1, STARTS), () => fixtureManifest());
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(2);
    await waitFor(() => lastAudio().currentTime >= 19.9, "seek to segment 2");
    expect(store.getState().currentSeg).toBe(2);
    ctl.seekToSegment(0);
    await waitFor(() => lastAudio().currentTime < 1.5, "seek back to segment 0");
    expect(store.getState().currentSeg).toBe(0);
    expect(document.querySelector("[data-current]")?.getAttribute("data-seg")).toBe("0");
  });

  it("clicking the first sentence mid-chapter seeks to the start", async () => {
    const { ctl, store } = real(fixtureSnap(1, STARTS), () => fixtureManifest());
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    (document.querySelector('[data-seg="2"]') as HTMLElement).click();
    await waitFor(() => lastAudio().currentTime >= 19.9, "seek to segment 2");
    (document.querySelector('[data-seg="0"]') as HTMLElement).click();
    await waitFor(() => lastAudio().currentTime < 1.5, "seek back");
  });

  it("a new attempt reloads and resumes at the same segment index in the new timings", async () => {
    let attempt = 1;
    const { ctl, store } = real(fixtureSnap(1, STARTS), () => fixtureManifest({ attempt }, 3, attempt === 1 ? "" : "?a=2"));
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(2);
    await waitFor(() => lastAudio().currentTime >= 19.9, "at segment 2");

    attempt = 2; // regenerated: the same segment now starts at 10 s
    priv(ctl).applySnapshot(fixtureSnap(2, [0, 5000, 10_000]));
    await waitFor(() => lastAudio().currentTime >= 9.9 && lastAudio().currentTime < 14 && !lastAudio().paused, "resumed at the new start");
    expect(store.getState().currentSeg).toBe(2);
    expect(store.getState().pendingSeekSeg).toBeNull();
    expect(store.getState().error).toBeNull();
  });

  it("a new attempt without timings yet waits, then lands when they arrive", async () => {
    let attempt = 1;
    const { ctl, store } = real(fixtureSnap(1, STARTS), () =>
      attempt === 1 ? fixtureManifest() : fixtureManifest({ attempt: 2, status: "partial", durationMs: null }, 3, "?a=2"),
    );
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(2);
    await waitFor(() => lastAudio().currentTime >= 19.9, "at segment 2");

    attempt = 2;
    priv(ctl).applySnapshot(fixtureSnap(2, [], "partial")); // chunks exist, no timings yet
    await waitFor(() => store.getState().pendingSeekSeg === 2, "waiting for the timing of segment 2");
    await waitFor(() => store.getState().bufferedEndMs > 20_000, "new attempt buffered"); // reset to 0 by the reload
    expect(store.getState().pendingSeekSeg).toBe(2); // still waiting: the timing has not arrived
    expect(store.getState().error).toBeNull();

    priv(ctl).applySnapshot(fixtureSnap(2, [0, 5000, 10_000], "partial"));
    await waitFor(() => store.getState().pendingSeekSeg === null, "pending cleared");
    await waitFor(() => lastAudio().currentTime >= 9.9 && lastAudio().currentTime < 14, "landed at the new start");
    expect(store.getState().currentSeg).toBe(2);
  });
});

describe("autoplay", () => {
  it("unlocks the element inside play() without an error, and clears a stale autoplay error", async () => {
    const original = HTMLMediaElement.prototype.play;
    let blocked = true;
    const playCalls: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      playCalls.push(blocked ? "blocked" : "ok");
      if (blocked) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      return original.call(this);
    });
    const { ctl, store } = make(fixtureSnap(1, [0, 10_000, 20_000]), {
      deps: { fetchManifest: async () => fixtureManifest(), createEngine: undefined },
    });
    ctl.play();
    expect(playCalls).toEqual(["blocked"]); // the unlock call, synchronously in the gesture
    await Promise.resolve();
    expect(store.getState().error).toBeNull(); // its rejection is expected and silent

    await waitFor(() => store.getState().error === TEXT_AUTOPLAY, "autoplay error after the real play was rejected");
    expect(store.getState().loading).toBe(false);

    blocked = false;
    ctl.play(); // the user taps Play
    expect(store.getState().error).toBeNull();
    await waitFor(() => store.getState().playing, "playing");
    expect(store.getState().error).toBeNull();

    // And a stale error is also cleared by the element starting by itself.
    ctl.pause();
    await waitFor(() => !store.getState().playing, "paused");
    store.setState({ error: TEXT_AUTOPLAY });
    (ctl as unknown as { softError: boolean }).softError = true;
    await audios[audios.length - 1]!.play();
    await waitFor(() => store.getState().playing, "playing again");
    expect(store.getState().error).toBeNull();
  });
});

describe("progress, chapter end and auto-advance", () => {
  const STARTS = [0, 10_000, 20_000];
  const lastAudio = () => audios[audios.length - 1]!;
  const NEXT = "/read/n/2?autoplay=1";
  const startReal = (over: Parameters<typeof make>[1] = {}, snapshot = fixtureSnap(1, STARTS)) =>
    make(snapshot, { ...over, deps: { fetchManifest: async () => fixtureManifest(), createEngine: undefined } });

  it("opening a chapter, and destroying it unplayed, saves nothing", async () => {
    const { ctl, sendProgress } = startReal({ initialSegment: 2 });
    ctl.destroy();
    expect(sendProgress).not.toHaveBeenCalled();
  });

  it("a seek is saved when the user pauses, with the segment and the position", async () => {
    const { ctl, store, sendProgress } = startReal();
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(2);
    await waitFor(() => lastAudio().currentTime >= 19.9, "seek to segment 2");
    expect(sendProgress).not.toHaveBeenCalled(); // debounced
    ctl.pause();
    expect(sendProgress).toHaveBeenCalledTimes(1);
    const [body, beacon] = sendProgress.mock.calls[0]!;
    expect(beacon).toBe(false);
    expect(body).toMatchObject({ novelId: "n", chapterId: CH, segmentIndex: 2, finished: false });
    expect(body.positionMs).toBeGreaterThanOrEqual(19_900);
  });

  it("a segment change is saved by itself after the 2 s debounce", async () => {
    const { ctl, store, sendProgress } = startReal();
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(1);
    await waitFor(() => store.getState().currentSeg === 1, "segment 1");
    await waitFor(() => sendProgress.mock.calls.length > 0, "debounced save");
    expect(sendProgress.mock.calls.at(-1)![0].segmentIndex).toBe(1);
  });

  it("pagehide flushes with the beacon flag, and destroy flushes too", async () => {
    const { ctl, store, sendProgress } = startReal();
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(1);
    await waitFor(() => lastAudio().currentTime >= 9.9, "seek to segment 1");
    window.dispatchEvent(new Event("pagehide"));
    expect(sendProgress).toHaveBeenCalledTimes(1);
    expect(sendProgress.mock.calls[0]![1]).toBe(true);
    expect(sendProgress.mock.calls[0]![0].segmentIndex).toBe(1);

    ctl.seekToSegment(2);
    await waitFor(() => lastAudio().currentTime >= 19.9, "seek to segment 2");
    ctl.destroy();
    expect(sendProgress).toHaveBeenCalledTimes(2);
    expect(sendProgress.mock.calls[1]![0].segmentIndex).toBe(2);
  });

  it("the page going hidden flushes", async () => {
    const { ctl, store, sendProgress } = startReal();
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(1);
    await waitFor(() => lastAudio().currentTime >= 9.9, "seek to segment 1");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sendProgress).toHaveBeenCalledTimes(1);
  });

  it("a position with no current segment is not saved", async () => {
    const { ctl, store, sendProgress } = startReal({}, fixtureSnap(1, []));
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    expect(store.getState().currentSeg).toBeNull();
    ctl.pause();
    ctl.destroy();
    expect(sendProgress).not.toHaveBeenCalled();
  });

  it("the end of a ready chapter saves finished and navigates to the next one", async () => {
    const { ctl, store, sendProgress, navigate } = startReal({ nextHref: NEXT });
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToMs(FIXTURE_DURATION_MS - 1500);
    await waitFor(() => navigate.mock.calls.length > 0, "auto-advance after the real ended event");
    expect(navigate).toHaveBeenCalledWith(NEXT);
    const finished = sendProgress.mock.calls.filter(([b]) => b.finished);
    expect(finished).toHaveLength(1);
    expect(finished[0]![0]).toMatchObject({ chapterId: CH, segmentIndex: 2, finished: true });
    expect(finished[0]![1]).toBe(false);
    ctl.destroy();
    expect(sendProgress.mock.calls.filter(([b]) => b.finished)).toHaveLength(1); // destroy does not resend
    expect(sendProgress.mock.calls.at(-1)![0].finished).toBe(true); // and nothing overwrites it
  });

  it("a failed save never stops the auto-advance", async () => {
    const { ctl, store, navigate } = startReal({
      nextHref: NEXT,
      sendProgress: () => {
        throw new Error("save failed");
      },
    });
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToMs(FIXTURE_DURATION_MS - 1500);
    await waitFor(() => navigate.mock.calls.length > 0, "auto-advance");
  });

  it("the last chapter shows the end message through the banner error and does not navigate", async () => {
    const { ctl, store, sendProgress, navigate } = startReal({ nextHref: null });
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToMs(FIXTURE_DURATION_MS - 1500);
    await waitFor(() => store.getState().error === TEXT_LAST_CHAPTER, "end message");
    expect(TEXT_LAST_CHAPTER).toBe("Đã hết chương mới nhất.");
    expect(navigate).not.toHaveBeenCalled();
    expect(sendProgress.mock.calls.some(([b]) => b.finished)).toBe(true);
    ctl.play(); // listening again clears the message
    await waitFor(() => store.getState().playing, "playing again");
    expect(store.getState().error).toBeNull();
  });

  it("ended on a partial row is not a finished chapter: nothing saved as finished, no navigation", async () => {
    const { ctl, store, sendProgress, navigate } = startReal({ nextHref: NEXT }, fixtureSnap(1, STARTS, "partial"));
    ctl.play();
    await waitFor(() => store.getState().playing, "playing");
    ctl.seekToSegment(1);
    await waitFor(() => lastAudio().currentTime >= 9.9, "seek");
    lastAudio().dispatchEvent(new Event("ended")); // playback caught up with generation
    expect(store.getState().loading).toBe(true); // still waiting for more audio (the real element plays on, so check at once)
    await new Promise((r) => setTimeout(r, 50));
    expect(navigate).not.toHaveBeenCalled();
    expect(sendProgress.mock.calls.some(([b]) => b.finished)).toBe(false);
    expect(store.getState().error).toBeNull();
  });
});

export type { Pr };
