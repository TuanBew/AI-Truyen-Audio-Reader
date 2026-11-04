import type { AudioManifest } from "@/lib/types";
import { durationToSet, nextAppends, shouldEndStream } from "./plan";

// One continuous WebM/Opus encode played through Media Source Extensions (spec 6.5): a shared init segment, then one
// cluster per append, in order. One SourceBuffer, mode "segments", no timestampOffset, no append windows.

const MIME = 'audio/webm; codecs="opus"';
const DEFAULT_RETRY_DELAYS_MS = [250, 750];

export type EngineEvents = {
  onBufferedEndMs(ms: number): void; // after each append
  onFatal(kind: "mse" | "expired" | "network"): void;
  onFallback(): void; // switched to full.webm
};

export class FetchError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "FetchError";
  }
}

type Deps = {
  fetchBytes?: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  refreshManifest?: () => Promise<AudioManifest>;
  retryDelaysMs?: number[];
};

async function defaultFetchBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new FetchError(res.status);
  return res.arrayBuffer();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export class MsePlayerEngine {
  private manifest: AudioManifest | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private openedReady = false;
  private initAppended = false;
  private appended = 0;
  private ended = false;
  private pumping = false;
  private onFallbackMetadata: (() => void) | null = null;
  private onFallbackError: (() => void) | null = null;
  private halted = false; // fatal error or fallback: nothing more is appended until load()
  private generation = 0; // bumped by load() and destroy(); stale async work checks it and stops quietly
  private abort = new AbortController();
  private readonly fetchBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  private readonly refreshManifest?: () => Promise<AudioManifest>;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly events: EngineEvents,
    deps: Deps = {},
  ) {
    this.fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
    this.refreshManifest = deps.refreshManifest;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  get attempt(): number | null {
    return this.manifest?.attempt ?? null;
  }

  // Starts a new MediaSource and resets everything. Also used when the attempt changes.
  load(manifest: AudioManifest): void {
    this.teardown();
    const gen = ++this.generation;
    this.abort = new AbortController();
    this.manifest = manifest;
    this.openedReady = manifest.status === "ready";
    this.initAppended = false;
    this.appended = 0;
    this.ended = false;
    this.halted = false;

    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(MIME)) {
      void this.fallbackOrFatal();
      return;
    }
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    ms.addEventListener(
      "sourceopen",
      () => {
        if (gen !== this.generation || this.sourceBuffer) return;
        try {
          const sb = ms.addSourceBuffer(MIME);
          sb.mode = "segments";
          this.sourceBuffer = sb;
          const duration = durationToSet(this.manifest!, this.openedReady, this.bufferedEndS());
          if (duration !== null) ms.duration = duration;
        } catch {
          void this.fallbackOrFatal();
          return;
        }
        void this.pump(gen);
      },
      { once: true },
    );
    this.audio.addEventListener("error", this.onAudioError);
    this.audio.src = this.objectUrl;
  }

  // Same attempt: append the chunks that appeared since. A different attempt reloads.
  update(manifest: AudioManifest): void {
    if (this.manifest === null || manifest.attempt !== this.manifest.attempt) {
      this.load(manifest);
      return;
    }
    this.manifest = manifest;
    if (this.sourceBuffer && !this.halted) void this.pump(this.generation);
  }

  destroy(): void {
    this.generation++;
    this.teardown();
    this.manifest = null;
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  private teardown(): void {
    this.abort.abort();
    this.audio.removeEventListener("error", this.onAudioError);
    this.clearFallbackListeners();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.pumping = false;
  }

  private clearFallbackListeners(): void {
    if (this.onFallbackMetadata) this.audio.removeEventListener("loadedmetadata", this.onFallbackMetadata);
    if (this.onFallbackError) this.audio.removeEventListener("error", this.onFallbackError);
    this.onFallbackMetadata = null;
    this.onFallbackError = null;
  }

  private readonly onAudioError = (): void => {
    // A decode error after the append succeeded (the element, not the SourceBuffer, rejects the stream).
    if (!this.halted) void void this.fallbackOrFatal();
  };

  private bufferedEndS(): number {
    const b = this.sourceBuffer?.buffered;
    return b && b.length > 0 ? b.end(b.length - 1) : 0;
  }

  private fatal(kind: "mse" | "expired" | "network"): void {
    if (this.halted) return;
    this.halted = true;
    this.events.onFatal(kind);
  }

  // MSE failed: play the single full file when there is one (from the same position), else report it. The signed URL
  // captured at load() may have expired (they live 10 minutes), so the manifest is refreshed first; if that fails the
  // URL we have is used. The element's error listener stays on while it plays the full file: a dead URL reports
  // instead of hanging.
  private async fallbackOrFatal(): Promise<void> {
    if (this.halted) return;
    if (this.manifest?.full == null && !this.refreshManifest) {
      this.fatal("mse");
      return;
    }
    this.halted = true;
    const gen = ++this.generation; // stops the pump and any in-flight fetch or append from reporting
    this.abort.abort();
    this.audio.removeEventListener("error", this.onAudioError);
    const audio = this.audio;
    const position = audio.currentTime;
    const wasPlaying = !audio.paused;

    let full = this.manifest?.full ?? null;
    let refreshOk = false;
    if (this.refreshManifest) {
      try {
        const next = await this.refreshManifest();
        if (next.attempt === this.manifest?.attempt && next.full) {
          full = next.full;
          refreshOk = true;
        }
      } catch {
        // keep the URL we have
      }
      if (gen !== this.generation) return; // load() or destroy() ran meanwhile
    }
    if (full === null) {
      this.events.onFatal("mse");
      return;
    }

    const oldUrl = this.objectUrl;
    this.objectUrl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.onFallbackMetadata = () => {
      this.onFallbackMetadata = null;
      if (position > 0) audio.currentTime = position;
      if (wasPlaying) audio.play().catch(() => {});
    };
    this.onFallbackError = () => {
      this.clearFallbackListeners();
      this.events.onFatal(refreshOk ? "network" : "expired");
    };
    audio.addEventListener("loadedmetadata", this.onFallbackMetadata, { once: true });
    audio.addEventListener("error", this.onFallbackError, { once: true });
    audio.src = full;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    this.events.onFallback();
  }

  private async pump(gen: number): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (gen === this.generation && !this.halted) {
        const manifest = this.manifest!;
        let data: ArrayBuffer | null;
        if (!this.initAppended) {
          if (manifest.init === null) return; // not synthesized yet; update() brings it
          data = await this.fetchWithRecovery(gen, (m) => m.init);
          if (data === null || gen !== this.generation) return;
          if (!(await this.append(gen, data))) return;
          this.initAppended = true;
          continue;
        }
        if (nextAppends(this.appended, manifest).length === 0) {
          this.maybeEnd(manifest);
          return;
        }
        const index = this.appended;
        data = await this.fetchWithRecovery(gen, (m) => m.chunks[index]?.url ?? null);
        if (data === null || gen !== this.generation) return;
        if (!(await this.append(gen, data))) return;
        this.appended++;
        if (gen !== this.generation || this.halted) return;
        this.events.onBufferedEndMs(this.bufferedEndS() * 1000);
      }
    } finally {
      if (gen === this.generation) this.pumping = false;
    }
  }

  private maybeEnd(manifest: AudioManifest): void {
    const ms = this.mediaSource;
    const sb = this.sourceBuffer;
    if (this.ended || !ms || !sb || sb.updating || ms.readyState !== "open") return;
    if (!shouldEndStream(manifest, this.appended)) return;
    this.ended = true;
    try {
      ms.endOfStream();
    } catch {
      void this.fallbackOrFatal();
    }
  }

  // Fetch with the recovery rules: a 403 refreshes the manifest once for this chunk and retries with the new URL, a
  // second 403 is fatal ("expired"); other failures retry with backoff, then "network". Returns null when cancelled
  // or after reporting a fatal error.
  private async fetchWithRecovery(
    gen: number,
    pick: (m: AudioManifest) => string | null,
  ): Promise<ArrayBuffer | null> {
    let refreshed = false;
    let failures = 0;
    for (;;) {
      if (this.halted) return null;
      const url = pick(this.manifest!);
      if (url === null) {
        this.fatal("expired");
        return null;
      }
      try {
        const bytes = await this.fetchBytes(url, this.abort.signal);
        return gen === this.generation ? bytes : null;
      } catch (err) {
        if (gen !== this.generation) return null;
        if (err instanceof FetchError && err.status === 403) {
          if (refreshed || !this.refreshManifest) {
            this.fatal("expired");
            return null;
          }
          refreshed = true;
          try {
            const next = await this.refreshManifest();
            if (gen !== this.generation) return null;
            if (next.attempt !== this.manifest!.attempt) {
              this.fatal("expired");
              return null;
            }
            this.manifest = next;
          } catch {
            if (gen === this.generation) this.fatal("network");
            return null;
          }
          continue;
        }
        if (failures >= this.retryDelaysMs.length) {
          this.fatal("network");
          return null;
        }
        await sleep(this.retryDelaysMs[failures++]!, this.abort.signal);
        if (gen !== this.generation) return null;
      }
    }
  }

  // Appends one buffer and waits for updateend. On an MSE error: fall back / fatal and return false.
  private append(gen: number, data: ArrayBuffer): Promise<boolean> {
    const sb = this.sourceBuffer;
    if (!sb) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        sb.removeEventListener("updateend", onEnd);
        sb.removeEventListener("error", onError);
      };
      const onEnd = () => {
        cleanup();
        resolve(gen === this.generation);
      };
      const onError = () => {
        cleanup();
        if (gen === this.generation) void this.fallbackOrFatal();
        resolve(false);
      };
      sb.addEventListener("updateend", onEnd);
      sb.addEventListener("error", onError);
      try {
        sb.appendBuffer(data);
      } catch {
        // Includes QuotaExceededError, which is not expected at 48 kbps: treated as an MSE error.
        cleanup();
        if (gen === this.generation) void this.fallbackOrFatal();
        resolve(false);
      }
    });
  }
}
