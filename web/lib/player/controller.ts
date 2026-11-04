import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { generationState, type GenState } from "@/lib/audio/generation";
import type { AudioResult } from "@/lib/data/audio";
import type { MsePlayerEngine } from "@/lib/player/engine"; // type only: the engine is loaded with import() on first play
import type { AudioManifest, AudioSnapshot, TimedSegment } from "@/lib/types";
import { needsManifest, playableAudio } from "./snapshot";
import { readPersisted, stepRate, type PlayerStore } from "./store";
import { segmentAt, startOfSegment } from "./timeline";

// Owns the <audio> element, the engine, the Realtime channel and the rAF loop for one chapter. React only reads the
// store: nothing here renders per frame. Responsibilities, top to bottom:
//   1. playback intent (play / pause / seek target)       4. engine + signed-URL manifest (rate limited)
//   2. snapshot intake (debounced read, Realtime)          5. highlight, auto-scroll, click and scroll listeners
//   3. generation state and the worker-offline clock

export type PlayerActions = {
  ensureChapterAudio(chapterId: string): Promise<AudioResult>;
  readAudioSnapshot(chapterId: string): Promise<AudioResult>;
  retrySynthesis(jobId: string): Promise<AudioResult>;
  prefetchAfter(novelId: string, chapterIndex: number): Promise<unknown>;
};

export type ControllerOptions = {
  chapterId: string;
  novelId: string;
  chapterIndex: number;
  snapshot: AudioSnapshot;
  initialSegment: number | null;
  store: PlayerStore;
  actions: PlayerActions;
  now?: () => number;
};

export const SNAPSHOT_DEBOUNCE_MS = 500;
export const MANIFEST_MIN_GAP_MS = 2000; // while partial
export const RATE_LIMIT_BACKOFF_MS = 30_000;
const MANIFEST_RETRY_MS = 5000; // after a failed refresh while something is already playing
const POLL_FALLBACK_MS = 5000;
const CLOCK_TICK_MS = 15_000;
const SCROLL_ANCHOR = 0.3; // the current segment sits in the upper third
const TEXT_PREVIEW_CHARS = 120;

export const TEXT_EXPIRED = "Liên kết âm thanh đã hết hạn. Bấm Thử lại.";
export const TEXT_MSE = "Trình duyệt không phát được âm thanh này. Bấm Thử lại.";
export const TEXT_NETWORK = "Không tải được âm thanh. Kiểm tra mạng rồi bấm Thử lại.";
export const TEXT_NO_MSE_PARTIAL = "Trình duyệt này chưa phát được chương đang tạo dở. Đợi tạo xong rồi nghe.";
export const TEXT_RATE_LIMITED = "Tải âm thanh quá nhanh. Sẽ tự thử lại sau 30 giây.";
const TEXT_AUTOPLAY = "Trình duyệt chặn tự phát. Bấm phát để nghe.";
const TEXT_ENSURE_FAILED = "Không yêu cầu được tạo âm thanh. Thử lại sau ít phút.";

class ManifestError extends Error {
  constructor(readonly status: number) {
    super(`manifest HTTP ${status}`);
  }
}

function isManifest(value: unknown): value is AudioManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<AudioManifest>;
  return typeof m.audioId === "string" && typeof m.attempt === "number" && Array.isArray(m.chunks);
}

function sortedTimings(snapshot: AudioSnapshot): TimedSegment[] {
  const audio = playableAudio(snapshot);
  return audio ? [...audio.segments].sort((a, b) => a.start_ms - b.start_ms) : [];
}

// The generation is in flight: a job is queued or running. Realtime and the clock only matter then.
function isGenerating(snapshot: AudioSnapshot): boolean {
  return snapshot.job?.status === "queued" || snapshot.job?.status === "running";
}

function bufferedContains(audio: HTMLAudioElement, t: number): boolean {
  const b = audio.buffered;
  for (let k = 0; k < b.length; k++) if (t >= b.start(k) - 0.05 && t <= b.end(k) + 0.05) return true;
  return false;
}

export class PlayerController {
  private readonly audio: HTMLAudioElement;
  private readonly store: PlayerStore;
  private readonly actions: PlayerActions;
  private readonly chapterId: string;
  private readonly novelId: string;
  private readonly chapterIndex: number;
  private readonly now: () => number;
  private readonly article: HTMLElement | null;
  private readonly cleanups: (() => void)[] = [];

  private destroyed = false;
  private started = false;
  private bootstrapped = false; // ensureChapterAudio succeeded once
  private wantPlay = false;
  private sourceReady = false; // the element has a source (engine loaded, or the full file)
  private plain = false; // no MediaSource: playing the full file directly
  private softError = false; // store.error is informational (rate limit) and clears by itself

  private snapshot: AudioSnapshot;
  private gen: GenState;
  private timed: TimedSegment[];
  private manifest: AudioManifest | null = null;
  private engine: MsePlayerEngine | null = null;
  private enginePromise: Promise<MsePlayerEngine> | null = null;

  private spans = new Map<number, HTMLElement>();
  private segOrder: number[] = [];
  private curSeg: number | null = null;
  private target: number | null = null; // segment whose start playback should land on
  private pendingEl: HTMLElement | null = null;
  private raf = 0;
  private reloadingUntil = 0;

  // signed-URL manifest scheduling
  private mFlight = false;
  private mWanted = false;
  private mReload = false;
  private mLastAt = Number.NEGATIVE_INFINITY;
  private mBlockedUntil = 0;
  private mTimer: ReturnType<typeof setTimeout> | null = null;

  // snapshot intake
  private sTimer: ReturnType<typeof setTimeout> | null = null;
  private sFlight = false;
  private sDirty = false;

  // Realtime
  private channel: RealtimeChannel | null = null;
  private channelClient: SupabaseClient | null = null;
  private channelKey: string | null = null;
  private channelToken = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private genKey = "";

  constructor(opts: ControllerOptions) {
    this.store = opts.store;
    this.actions = opts.actions;
    this.chapterId = opts.chapterId;
    this.novelId = opts.novelId;
    this.chapterIndex = opts.chapterIndex;
    this.now = opts.now ?? Date.now;
    this.snapshot = opts.snapshot;
    this.gen = this.store.getState().gen;
    this.timed = sortedTimings(opts.snapshot);

    // Saved speed and volume (read here, not during render, so server and client markup match).
    this.store.setState(readPersisted());

    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.preservesPitch = true;
    this.applyAudioSettings();
    this.bindAudio();

    this.article = document.getElementById("reader-text");
    this.indexSegments();
    this.bindDom();
    this.recompute();
    this.clockTimer = setInterval(() => this.recompute(), CLOCK_TICK_MS);
    this.showInitialSegment(opts.initialSegment);
  }

  // ---- public API --------------------------------------------------------------------------------------------

  play(fromSeg?: number): void {
    if (this.destroyed) return;
    this.wantPlay = true;
    const cur = this.store.getState();
    // loading: sound has not started yet. Seeking while already playing does not fire "playing" again.
    this.store.setState({ loading: !cur.playing, error: this.softError ? cur.error : null });
    if (!this.started) {
      this.started = true;
      this.store.setState({ started: true, error: null, canRetry: false });
      const first = fromSeg ?? this.curSeg;
      if (first !== null && first !== undefined) this.setTarget(first);
      void this.bootstrap();
      return;
    }
    if (fromSeg !== undefined) {
      this.setTarget(fromSeg);
      return;
    }
    this.kick();
  }

  pause(): void {
    this.wantPlay = false;
    this.store.setState({ loading: false });
    this.audio.pause();
  }

  toggle(): void {
    const s = this.store.getState();
    if (s.playing || s.loading) this.pause();
    else this.play();
  }

  // Moves to a segment, keeping the play/pause state; starts playback when nothing has played yet.
  seekToSegment(i: number): void {
    if (this.destroyed) return;
    if (!this.started) this.play(i);
    else this.setTarget(i);
  }

  stepSegment(dir: 1 | -1): void {
    if (!this.started || this.destroyed) return;
    const base = this.target ?? this.curSeg ?? -1;
    const order = this.segOrder;
    const next = dir > 0 ? order.find((i) => i > base) : [...order].reverse().find((i) => i < base);
    if (next !== undefined) this.seekToSegment(next);
    else if (dir < 0 && order.length > 0) this.seekToSegment(order[0]!);
  }

  // A click on the timeline. The caller only passes positions inside the generated range.
  seekToMs(ms: number): void {
    if (this.destroyed) return;
    this.clearTarget(); // a different seek
    const seg = segmentAt(this.timed, ms);
    if (!this.started) {
      this.play(seg ?? undefined);
      return;
    }
    if (this.sourceReady && ms < this.store.getState().bufferedEndMs) {
      this.audio.currentTime = ms / 1000;
      this.onTime();
      this.kickIfWanted();
    } else if (seg !== null) {
      this.setTarget(seg);
    }
  }

  setRate(rate: number): void {
    this.store.setState({ rate });
    this.applyAudioSettings();
  }

  nudgeRate(dir: 1 | -1): void {
    this.setRate(stepRate(this.store.getState().rate, dir));
  }

  // The speed button: up a step, back to the slowest after the fastest.
  cycleRate(): void {
    const rate = this.store.getState().rate;
    const next = stepRate(rate, 1);
    this.setRate(next === rate ? 0.75 : next);
  }

  setVolume(volume: number): void {
    this.store.setState({ volume });
    this.applyAudioSettings();
  }

  // The "Về chỗ đang đọc" pill.
  followNow(): void {
    this.store.setState({ follow: true });
    const el = this.curSeg === null ? undefined : this.spans.get(this.curSeg);
    if (el) this.scrollToEl(el, true);
  }

  // "Thử lại": a failed job is queued again; a playback error reloads the audio from the current segment.
  retry(): void {
    if (this.destroyed) return;
    const g = this.gen;
    const jobId = g.kind === "failed" ? g.jobId : g.kind === "partial" ? (g.jobError?.jobId ?? null) : null;
    this.softError = false;
    this.store.setState({ error: null, canRetry: false });
    if (jobId !== null) {
      void this.runAction(this.actions.retrySynthesis(jobId));
      return;
    }
    if (!this.bootstrapped) {
      this.wantPlay = true;
      this.store.setState({ loading: true });
      void this.bootstrap();
      return;
    }
    if (this.target === null && this.curSeg !== null) this.target = this.curSeg;
    this.wantPlay = true;
    this.store.setState({ loading: true });
    this.requestManifest({ force: true, reload: true });
  }

  segmentText(i: number): string | null {
    const text = this.spans.get(i)?.textContent?.trim();
    if (!text) return null;
    return text.length > TEXT_PREVIEW_CHARS ? `${text.slice(0, TEXT_PREVIEW_CHARS)}…` : text;
  }

  segmentAtMs(ms: number): number | null {
    return segmentAt(this.timed, ms);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Task 11: flush the reading progress here, before anything is torn down.
    this.stopRaf();
    for (const t of [this.mTimer, this.sTimer]) if (t) clearTimeout(t);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.closeChannel();
    this.engine?.destroy();
    this.audio.pause();
    if (!this.engine) {
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    for (const fn of this.cleanups.splice(0)) fn();
    this.spans.get(this.curSeg ?? -1)?.removeAttribute("data-current");
    this.pendingEl?.removeAttribute("data-pending");
    this.article?.removeAttribute("data-interactive");
  }

  // ---- playback intent ---------------------------------------------------------------------------------------

  private async bootstrap(): Promise<void> {
    // A row that is already ready does not need to wait for the server action: fetch the URLs and load the engine now.
    if (this.gen.kind === "ready" && playableAudio(this.snapshot)) this.requestManifest({ force: true });
    let res: AudioResult;
    try {
      res = await this.actions.ensureChapterAudio(this.chapterId);
    } catch {
      res = { snapshot: null, error: TEXT_ENSURE_FAILED };
    }
    if (this.destroyed) return;
    if (!res.snapshot) {
      this.wantPlay = false;
      this.clearTarget();
      this.store.setState({ loading: false, error: res.error, canRetry: true });
      return;
    }
    this.bootstrapped = true;
    this.applySnapshot(res.snapshot);
    // Decision 1: the next chapters are queued on the first play. Never blocks playback.
    void Promise.resolve(this.actions.prefetchAfter(this.novelId, this.chapterIndex)).catch(() => {});
  }

  private async runAction(pending: Promise<AudioResult>): Promise<void> {
    try {
      const res = await pending;
      if (this.destroyed) return;
      if (res.snapshot) this.applySnapshot(res.snapshot);
      else this.store.setState({ error: res.error, canRetry: true });
    } catch {
      if (!this.destroyed) this.store.setState({ error: TEXT_ENSURE_FAILED, canRetry: true });
    }
  }

  private setTarget(seg: number): void {
    this.clearTarget(); // starting a different seek drops the pending one
    this.target = seg;
    this.store.setState({ follow: true });
    this.resolveTarget();
  }

  private clearTarget(): void {
    this.target = null;
    this.setPending(null);
  }

  private setPending(seg: number | null): void {
    if (this.store.getState().pendingSeekSeg === seg) return;
    this.pendingEl?.removeAttribute("data-pending");
    this.pendingEl = seg === null ? null : (this.spans.get(seg) ?? null);
    this.pendingEl?.setAttribute("data-pending", "");
    this.store.setState({ pendingSeekSeg: seg });
  }

  // Lands on the target once its timing exists and the engine has buffered past its start (Review Focus 2). Called on
  // every snapshot and every append.
  private resolveTarget(): void {
    const seg = this.target;
    if (seg === null) return;
    const ms = startOfSegment(this.timed, seg);
    if (ms === 0) {
      // The very start: nothing to seek to, only to play.
      this.clearTarget();
      this.kickIfWanted();
      return;
    }
    if (ms === null) {
      // Timings are still to come: the first play has not heard back from the server yet, or a job is in flight.
      if ((!this.bootstrapped || isGenerating(this.snapshot)) && this.gen.kind !== "failed") {
        this.setPending(seg);
        return;
      }
      // Nothing will ever time it (a segment after the last timed one): play from where we are.
      this.clearTarget();
      this.kickIfWanted();
      return;
    }
    if (!this.sourceReady || ms >= this.store.getState().bufferedEndMs) {
      this.setPending(seg);
      return;
    }
    this.clearTarget();
    this.audio.currentTime = ms / 1000;
    this.store.setState({ positionMs: ms });
    const timedSeg = segmentAt(this.timed, ms);
    if (timedSeg !== null) this.setCurrent(timedSeg);
    this.kickIfWanted();
  }

  private kickIfWanted(): void {
    if (this.wantPlay) this.kick();
  }

  private kick(): void {
    if (!this.wantPlay || !this.sourceReady || this.target !== null || this.destroyed) return;
    this.audio.play().catch((err: unknown) => {
      if (this.destroyed || (err instanceof DOMException && err.name === "AbortError")) return;
      this.wantPlay = false;
      this.store.setState({ loading: false, error: TEXT_AUTOPLAY, canRetry: false });
      this.softError = true;
    });
  }

  // ---- snapshots and Realtime --------------------------------------------------------------------------------

  private applySnapshot(next: AudioSnapshot): void {
    if (this.destroyed || next.chapterId !== this.chapterId) return;
    const prev = this.snapshot;
    this.snapshot = next;
    this.timed = sortedTimings(next);
    this.recompute();

    const g = this.gen;
    const dead = g.kind === "failed" || (g.kind === "partial" && g.jobError !== null);
    if (dead) {
      // Nothing more will be generated: a seek waiting for it can never resolve.
      this.setPending(null);
      if (g.kind === "failed") {
        this.target = null;
        this.wantPlay = false;
        this.store.setState({ loading: false });
      }
    }

    void this.syncChannel();
    if (needsManifest(prev, next) || (!this.sourceReady && playableAudio(next) !== null && !this.store.getState().error)) {
      this.requestManifest();
    }
    this.resolveTarget();
  }

  private clearSoftError(): void {
    if (!this.softError) return;
    this.softError = false;
    this.store.setState({ error: null });
  }

  // Debounced read (SNAPSHOT_DEBOUNCE_MS after the first event of a burst), never more than one in flight; events that
  // arrive while a read runs schedule exactly one more afterwards.
  private requestSnapshot(): void {
    if (this.destroyed) return;
    if (this.sFlight) {
      this.sDirty = true;
      return;
    }
    if (this.sTimer) return;
    this.sTimer = setTimeout(() => {
      this.sTimer = null;
      void this.readSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private async readSnapshot(): Promise<void> {
    this.sFlight = true;
    try {
      const res = await this.actions.readAudioSnapshot(this.chapterId);
      if (!this.destroyed && res.snapshot) this.applySnapshot(res.snapshot);
    } catch {
      // The next event or the fallback poll tries again.
    } finally {
      this.sFlight = false;
      if (this.sDirty) {
        this.sDirty = false;
        this.requestSnapshot();
      }
    }
  }

  // One channel with three bindings while a job is in flight: chapter_audio of this chapter, the job row (rebound by
  // building a new channel when the job id changes) and worker_status. Not needed once nothing is generating.
  private async syncChannel(): Promise<void> {
    if (this.destroyed) return;
    const key = isGenerating(this.snapshot) ? (this.snapshot.job?.id ?? "") : null;
    if (key === null) {
      this.closeChannel();
      return;
    }
    if (key === this.channelKey) return;
    this.closeChannel();
    this.channelKey = key;
    const token = ++this.channelToken;
    try {
      const { getBrowserClient } = await import("@/lib/supabase/browser");
      if (this.destroyed || token !== this.channelToken) return;
      const client = getBrowserClient() as unknown as SupabaseClient;
      // The first join must carry the user's token: with the anon key the server rejects the jobs filter ("invalid
      // column for filter") and delivers nothing, because RLS hides every row from anon. The client only picks the
      // session up after the join otherwise.
      const { data } = await client.auth.getSession();
      if (data.session) await client.realtime.setAuth(data.session.access_token);
      if (this.destroyed || token !== this.channelToken) return;
      const poke = () => this.requestSnapshot();
      let ch = client
        .channel(`reader:${this.chapterId}:${token}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "chapter_audio", filter: `chapter_id=eq.${this.chapterId}` },
          poke,
        );
      if (key !== "") {
        ch = ch.on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `id=eq.${key}` }, poke);
      }
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: "worker_status" }, poke);
      // The join can be acknowledged and still fail afterwards (bad filter, revoked RLS): that arrives as a system
      // message with status "error", not as a subscribe status. Treat it like a dropped channel.
      ch = ch.on("system", {}, (payload: { status?: string }) => {
        if (token === this.channelToken && payload.status === "error") this.startPoll();
      });
      this.channel = ch;
      this.channelClient = client;
      ch.subscribe((status) => {
        if (token !== this.channelToken || this.destroyed) return;
        if (status === "SUBSCRIBED") {
          this.stopPoll();
          this.requestSnapshot(); // catch up on whatever happened before the subscription was live
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.startPoll();
        }
      });
    } catch {
      if (token === this.channelToken) this.startPoll();
    }
  }

  // A Realtime channel that fails or drops must not stop playback or leave the banner stale: while a job is in
  // flight the snapshot is read every POLL_FALLBACK_MS until the channel reports SUBSCRIBED again or the generation
  // ends (closeChannel). The read still goes through the debounce, so there is never more than one in flight.
  private startPoll(): void {
    if (this.pollTimer || this.destroyed) return;
    this.pollTimer = setInterval(() => this.requestSnapshot(), POLL_FALLBACK_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private closeChannel(): void {
    this.channelToken++;
    this.channelKey = null;
    this.stopPoll();
    const { channel, channelClient } = this;
    this.channel = null;
    this.channelClient = null;
    if (channel && channelClient) void channelClient.removeChannel(channel).catch(() => {});
  }

  // ---- generation state and the offline clock ------------------------------------------------------------------

  private recompute(): void {
    if (this.destroyed) return;
    const now = this.now();
    const gen = generationState(this.snapshot, now);
    const seen = this.snapshot.workerLastSeen === null ? Number.NaN : Date.parse(this.snapshot.workerLastSeen);
    const agoMin = Number.isNaN(seen) ? null : Math.max(0, Math.floor((now - seen) / 60_000));
    const key = JSON.stringify([gen, agoMin]);
    this.gen = gen;
    if (key === this.genKey) return;
    this.genKey = key;
    this.store.setState({ gen, workerAgoMin: agoMin });
  }

  // ---- engine and signed URLs ---------------------------------------------------------------------------------

  private ensureEngine(): Promise<MsePlayerEngine> {
    this.enginePromise ??= import("@/lib/player/engine").then(({ MsePlayerEngine }) => {
      const engine = new MsePlayerEngine(
        this.audio,
        {
          onBufferedEndMs: (ms) => {
            this.store.setState({ bufferedEndMs: ms });
            this.resolveTarget();
          },
          onFatal: (kind) =>
            this.fail(kind === "expired" ? TEXT_EXPIRED : kind === "mse" ? TEXT_MSE : TEXT_NETWORK),
          onFallback: () => {
            // The element now plays the single full file: everything is "buffered" as far as seeking goes.
            this.store.setState({ bufferedEndMs: this.manifest?.durationMs ?? Number.MAX_SAFE_INTEGER });
            this.resolveTarget();
          },
        },
        { refreshManifest: () => this.fetchManifest() },
      );
      if (this.destroyed) engine.destroy();
      else this.engine = engine;
      return engine;
    });
    return this.enginePromise;
  }

  private fail(text: string): void {
    if (this.destroyed) return;
    this.wantPlay = false;
    this.target = null;
    this.setPending(null);
    this.softError = false;
    this.store.setState({ loading: false, error: text, canRetry: true });
  }

  private async fetchManifest(): Promise<AudioManifest> {
    const audio = playableAudio(this.snapshot);
    if (!audio) throw new ManifestError(404);
    this.mLastAt = this.now();
    const res = await fetch(`/api/audio/${audio.id}/urls`, { headers: { Accept: "application/json" } });
    if (res.status === 429) this.mBlockedUntil = this.now() + RATE_LIMIT_BACKOFF_MS;
    if (!res.ok) throw new ManifestError(res.status);
    const body: unknown = await res.json().catch(() => null);
    if (!isManifest(body)) throw new ManifestError(502);
    return body;
  }

  // The route is rate limited and shares its bucket with the engine's own refresh, so it is never polled: callers
  // ask when a snapshot added chunks, flipped the status or changed the attempt. Requests coalesce (at most one in
  // flight, one more queued), keep MANIFEST_MIN_GAP_MS apart while partial, and wait out a 429 for 30 s.
  private requestManifest(opts: { force?: boolean; reload?: boolean } = {}): void {
    if (this.destroyed) return;
    if (opts.reload) this.mReload = true;
    if (this.mFlight) {
      this.mWanted = true;
      return;
    }
    const now = this.now();
    const gap = !opts.force && this.gen.kind === "partial" ? MANIFEST_MIN_GAP_MS : 0;
    const wait = Math.max(this.mBlockedUntil - now, this.mLastAt + gap - now, 0);
    if (wait > 0) {
      this.mWanted = true;
      this.armManifestTimer(wait);
      return;
    }
    void this.runManifest();
  }

  private armManifestTimer(wait: number): void {
    if (this.mTimer) return;
    this.mTimer = setTimeout(() => {
      this.mTimer = null;
      if (this.mWanted) {
        this.mWanted = false;
        this.requestManifest();
      }
    }, wait);
  }

  private async runManifest(): Promise<void> {
    this.mFlight = true;
    try {
      const [manifest, engine] = await Promise.all([this.fetchManifest(), this.ensureEngineIfMse()]);
      if (this.destroyed) return;
      this.mBlockedUntil = 0;
      this.clearSoftError();
      this.applyManifest(manifest, engine);
    } catch (err) {
      if (this.destroyed) return;
      const limited = err instanceof ManifestError && err.status === 429;
      if (!this.sourceReady) {
        // Nothing to play yet: say so. A rate limit heals itself; anything else needs the user.
        if (!limited) this.wantPlay = false;
        this.softError = limited;
        this.store.setState({
          loading: this.wantPlay,
          error: limited ? TEXT_RATE_LIMITED : TEXT_NETWORK,
          canRetry: !limited,
        });
      } else if (!limited) {
        this.mBlockedUntil = this.now() + MANIFEST_RETRY_MS; // keep playing what is buffered
      }
      if (limited || this.sourceReady) {
        this.mWanted = true;
        this.armManifestTimer(Math.max(this.mBlockedUntil - this.now(), 0));
      }
    } finally {
      this.mFlight = false;
      if (this.mWanted && !this.mTimer && !this.destroyed) {
        this.mWanted = false;
        this.requestManifest();
      }
    }
  }

  private ensureEngineIfMse(): Promise<MsePlayerEngine | null> {
    return typeof window.MediaSource === "undefined" ? Promise.resolve(null) : this.ensureEngine();
  }

  private applyManifest(manifest: AudioManifest, engine: MsePlayerEngine | null): void {
    this.manifest = manifest;
    if (engine === null) {
      this.playFullFile(manifest);
      return;
    }
    const reload = this.mReload;
    this.mReload = false;
    const before = engine.attempt;
    const fresh = before === null || before !== manifest.attempt || reload;
    if (fresh) {
      // A new MediaSource: the element starts again from zero with nothing buffered (spec 6.5: the same segment index
      // is found again in the new attempt's timings, then playback resumes there).
      const resume = this.curSeg;
      const wasPlaying = this.store.getState().playing;
      if (before !== null) {
        this.reloadingUntil = this.now() + 1000;
        this.stopRaf();
        this.store.setState({ playing: false, bufferedEndMs: 0, loading: wasPlaying || this.wantPlay });
        this.wantPlay = this.wantPlay || wasPlaying;
        if (this.target === null && resume !== null) this.target = resume;
      }
      engine.load(manifest);
    } else {
      engine.update(manifest);
    }
    this.sourceReady = true;
    this.applyAudioSettings();
    this.resolveTarget();
    this.kickIfWanted();
  }

  // No MediaSource (some old or restricted browsers): a finished chapter plays as its single full file.
  private playFullFile(manifest: AudioManifest): void {
    if (manifest.status === "ready" && manifest.full) {
      this.plain = true;
      if (this.audio.getAttribute("src") !== manifest.full) this.audio.src = manifest.full;
      this.sourceReady = true;
      this.store.setState({ bufferedEndMs: manifest.durationMs ?? Number.MAX_SAFE_INTEGER });
      this.applyAudioSettings();
      this.resolveTarget();
      this.kickIfWanted();
    } else {
      this.wantPlay = false;
      this.softError = true; // heals when the row turns ready and the manifest is fetched again
      this.store.setState({ loading: false, error: TEXT_NO_MSE_PARTIAL, canRetry: false });
    }
  }

  // ---- the element --------------------------------------------------------------------------------------------

  private applyAudioSettings(): void {
    const { rate, volume } = this.store.getState();
    // defaultPlaybackRate survives the element reloading its source (a new attempt, the full-file fallback).
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.audio.preservesPitch = true;
    this.audio.volume = volume;
  }

  private bindAudio(): void {
    const a = this.audio;
    const on = (type: string, fn: () => void) => {
      a.addEventListener(type, fn);
      this.cleanups.push(() => a.removeEventListener(type, fn));
    };
    on("playing", () => {
      this.store.setState({ playing: true, loading: false });
      this.startRaf();
    });
    on("pause", () => {
      // Also the OS media keys or a headset: whoever paused, the intent to play is over (unless the controller is
      // swapping the source for a new attempt, which resumes by itself).
      if (this.now() >= this.reloadingUntil) this.wantPlay = false;
      this.stopRaf();
      this.store.setState({ playing: false, loading: false });
    });
    on("waiting", () => {
      if (this.wantPlay) this.store.setState({ loading: true });
    });
    on("ended", () => {
      this.wantPlay = false;
      this.stopRaf();
      this.store.setState({ playing: false, loading: false });
    });
    on("timeupdate", () => this.onTime());
    on("seeked", () => this.onTime());
    on("error", () => {
      if (this.plain) this.fail(TEXT_NETWORK); // the engine watches the element itself when MSE is in use
    });
  }

  private onTime(): void {
    if (this.destroyed) return;
    this.store.setState({ positionMs: Math.round(this.audio.currentTime * 1000) });
    this.syncHighlight();
  }

  // ---- highlight, scroll, listeners -------------------------------------------------------------------------

  private startRaf(): void {
    if (this.raf || this.destroyed) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.syncHighlight();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopRaf(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // audio.currentTime drives the highlight. It only counts inside the buffered range: segments of a partial row can run
  // slightly ahead of the chunks that were uploaded.
  private syncHighlight(): void {
    if (this.timed.length === 0) return;
    const t = this.audio.currentTime;
    if (!bufferedContains(this.audio, t)) return;
    const seg = segmentAt(this.timed, t * 1000);
    if (seg !== null) this.setCurrent(seg);
  }

  private setCurrent(seg: number): void {
    if (seg === this.curSeg) return;
    if (this.curSeg !== null) this.spans.get(this.curSeg)?.removeAttribute("data-current");
    this.curSeg = seg;
    const el = this.spans.get(seg);
    el?.setAttribute("data-current", "");
    this.store.setState({ currentSeg: seg });
    if (el && this.store.getState().follow) this.scrollToEl(el, false);
  }

  private scrollToEl(el: HTMLElement, force: boolean): void {
    const rect = el.getBoundingClientRect();
    const delta = rect.top - window.innerHeight * SCROLL_ANCHOR;
    if (!force && Math.abs(delta) < 4) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: reduced ? "auto" : "smooth" });
  }

  private indexSegments(): void {
    this.spans.clear();
    this.article?.querySelectorAll<HTMLElement>("[data-seg]").forEach((el) => {
      const i = Number(el.dataset.seg);
      if (Number.isInteger(i)) this.spans.set(i, el);
    });
    this.segOrder = [...this.spans.keys()].sort((a, b) => a - b);
  }

  // The segment to start from (?seg= or saved progress) is highlighted and scrolled to without animation, after the
  // router's own scroll handling for the navigation has run.
  private showInitialSegment(seg: number | null): void {
    if (seg === null || !this.spans.has(seg)) return;
    this.curSeg = seg;
    this.spans.get(seg)?.setAttribute("data-current", "");
    this.store.setState({ currentSeg: seg });
    let frames = 0;
    const step = () => {
      if (this.destroyed || !this.store.getState().follow) return;
      if (++frames < 3) {
        requestAnimationFrame(step);
        return;
      }
      const el = this.spans.get(seg);
      if (!el) return;
      const delta = el.getBoundingClientRect().top - window.innerHeight * SCROLL_ANCHOR;
      window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: "auto" });
    };
    requestAnimationFrame(step);
  }

  private bindDom(): void {
    const listen = <T extends EventTarget>(target: T, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn, opts));
    };

    if (this.article) {
      this.article.setAttribute("data-interactive", "");
      listen(this.article, "click", (e) => {
        const el = (e.target as Element | null)?.closest<HTMLElement>("[data-seg]");
        if (!el || !this.article?.contains(el)) return;
        if (window.getSelection()?.toString()) return; // selecting text is not a request to play
        const i = Number(el.dataset.seg);
        if (Number.isInteger(i)) this.play(i);
      });
    }

    // Scrolling the user did (not the controller's own scrollTo) turns following off.
    const manual = () => {
      if (this.store.getState().follow) this.store.setState({ follow: false });
    };
    listen(window, "wheel", manual, { passive: true });
    listen(window, "touchmove", manual, { passive: true });
    listen(window, "pointerdown", (e) => {
      // The page scrollbar belongs to the <html> element; content clicks never target it.
      if (e.target === document.documentElement) manual();
    });
    listen(window, "keydown", (e) => {
      const k = e as KeyboardEvent;
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(k.key)) manual();
    });
  }
}
