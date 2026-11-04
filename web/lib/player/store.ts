import type { GenState } from "@/lib/audio/generation";

export const STORAGE_KEY = "audiotruyen.player";
export const MIN_RATE = 0.75;
export const MAX_RATE = 2;
const RATE_STEP = 0.25;

export type PlayerState = {
  gen: GenState;
  playing: boolean;
  currentSeg: number | null;
  positionMs: number;
  rate: number;
  volume: number;
  pendingSeekSeg: number | null;
  follow: boolean;
  error: string | null;
  // Beyond the brief's fields, all written by the controller:
  started: boolean; // the first play of this chapter happened
  loading: boolean; // play was asked for and sound has not started yet (or stalled)
  bufferedEndMs: number; // end of what the engine has appended
  workerAgoMin: number | null; // minutes since the worker's last heartbeat, for the offline banner
  canRetry: boolean; // the error can be retried with the controller's retry()
};

export type PlayerStore = {
  getState(): PlayerState;
  setState(partial: Partial<PlayerState>): void;
  subscribe(fn: () => void): () => void;
};

function clampRate(rate: number): number {
  return Number.isFinite(rate) ? Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) : MIN_RATE;
}

function clampVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
}

// One step of the speed control: 0.25 within 0.75..2. Off-grid values (an old saved rate) snap to the grid first.
export function stepRate(rate: number, dir: 1 | -1): number {
  const stepped = dir > 0 ? Math.floor(rate / RATE_STEP + 1e-9) + 1 : Math.ceil(rate / RATE_STEP - 1e-9) - 1;
  return clampRate(stepped * RATE_STEP);
}

// Saved rate and volume. localStorage may be missing or throw (private window, blocked site data): then nothing is saved.
export function readPersisted(): Partial<Pick<PlayerState, "rate" | "volume">> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return {};
    const out: Partial<Pick<PlayerState, "rate" | "volume">> = {};
    const { rate, volume } = data as Record<string, unknown>;
    if (typeof rate === "number" && Number.isFinite(rate)) out.rate = clampRate(rate);
    if (typeof volume === "number" && Number.isFinite(volume)) out.volume = clampVolume(volume);
    return out;
  } catch {
    return {};
  }
}

function persist(state: PlayerState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rate: state.rate, volume: state.volume }));
  } catch {
    // not saved
  }
}

export function createPlayerStore(initial: Partial<PlayerState> & Pick<PlayerState, "gen">): PlayerStore {
  let state: PlayerState = {
    playing: false,
    currentSeg: null,
    positionMs: 0,
    rate: 1,
    volume: 1,
    pendingSeekSeg: null,
    follow: true,
    error: null,
    started: false,
    loading: false,
    bufferedEndMs: 0,
    workerAgoMin: null,
    canRetry: false,
    ...initial,
  };
  state = { ...state, rate: clampRate(state.rate), volume: clampVolume(state.volume) };
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(partial) {
      const next = { ...state, ...partial };
      next.rate = clampRate(next.rate);
      next.volume = clampVolume(next.volume);
      const keys = Object.keys(next) as (keyof PlayerState)[];
      if (keys.every((k) => Object.is(state[k], next[k]))) return;
      const saveNeeded = next.rate !== state.rate || next.volume !== state.volume;
      state = next;
      if (saveNeeded) persist(state);
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
