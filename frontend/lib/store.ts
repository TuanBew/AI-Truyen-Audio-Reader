import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AppState,
  AppView,
  ChapterData,
  TocData,
  TTSProvider,
  AudioFormat,
  TTSSettings,
  SavedNovel,
  WordTiming,
  AuthState,
  SentenceQueueState,
  AmbientState,
} from "./types";

const defaultTTSSettings: TTSSettings = {
  preferredProvider: "gemini",
  audioFormat: "mp3",
  geminiVoice: "vi-VN-Neural2-A",
  geminiLanguage: "vi-VN",
  openaiVoice: "nova",
  openaiModel: "tts-1",
  minimaxVoiceId: "male-qn-qingse",
  xttsEndpoint: "http://localhost:5002",
  speed: 1.0,
  pitch: 0.0,
  openaiApiKey: "",
  minimaxApiKey: "",
  minimaxGroupId: "",
  geminiCredentialsPath: "./credentials/service_account.json",
};

/** Derive a stable ID from a novel URL */
function novelIdFromUrl(url: string): string {
  try {
    return btoa(url).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  } catch {
    return url.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  }
}

interface AppStore extends AppState {
  // View / navigation
  setView: (view: AppView, novelId?: string | null) => void;
  setActiveNovel: (id: string | null) => void;

  // Library
  saveNovel: (toc: TocData, coverUrl?: string | null) => void;
  removeNovel: (id: string) => void;
  updateNovelProgress: (id: string, chapterUrl: string, chapterTitle: string) => void;
  openNovel: (novel: SavedNovel) => void;

  // Novel (transient)
  setNovelUrl: (url: string) => void;
  setToc: (toc: TocData | null) => void;
  setCurrentChapter: (chapter: ChapterData | null) => void;
  setCurrentChapterUrl: (url: string | null) => void;
  setLoadingToc: (v: boolean) => void;
  setLoadingChapter: (v: boolean) => void;

  // Word timings (transient)
  setWordTimings: (timings: WordTiming[]) => void;

  // TTS settings
  updateTTSSettings: (patch: Partial<TTSSettings>) => void;

  // Player
  setPlaying: (v: boolean) => void;
  setPlayerLoading: (v: boolean) => void;
  setProviderUsed: (provider: TTSProvider | null, fallback: boolean, reason: string) => void;
  setAutoAdvance: (v: boolean) => void;
  setHighlightedWordIndex: (idx: number) => void;

  // Chapter completion
  markChapterFinished: (chapterUrl: string) => void;
  isChapterFinished: (chapterUrl: string) => boolean;

  // Recording
  setRecording: (v: boolean) => void;
  setSaveDirectory: (dir: string) => void;
  setRecordingFormat: (fmt: AudioFormat) => void;
  addSavedFile: (path: string) => void;

  // UI
  toggleSettingsPanel: () => void;

  // Auth (transient — not persisted)
  authState: AuthState;
  setAuthState: (auth: Partial<AuthState>) => void;

  // Sentence queue
  setSentences: (sentences: string[]) => void;
  setCurrentSentenceIndex: (index: number) => void;
  cacheSentenceAudio: (index: number, blobUrl: string) => void;
  evictSentenceAudio: (index: number) => void;
  registerAbortController: (index: number, controller: AbortController) => void;
  abortAllPrefetches: () => void;
  setCurrentSentenceWordTimings: (timings: WordTiming[]) => void;

  // Ambient player
  ambientState: AmbientState
  setAmbientTrack: (id: string | null) => void
  setAmbientVolume: (volume: number) => void
  setAmbientLoopMode: (mode: 'all' | 'one') => void
  setAmbientPlaying: (playing: boolean) => void
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // ── Initial state ──────────────────────────────────────
      view: "home",
      activeNovelId: null,
      savedNovels: [],
      finishedChapterUrls: [],

      novelUrl: "",
      toc: null,
      currentChapter: null,
      currentChapterUrl: null,
      currentSentenceIndex: -1,
      chapterProgress: {},
      loadingToc: false,
      loadingChapter: false,
      wordTimings: [],
      ttsSettings: defaultTTSSettings,
      playerState: {
        isPlaying: false,
        isLoading: false,
        currentTime: 0,
        duration: 0,
        providerUsed: null,
        fallbackUsed: false,
        fallbackReason: "",
        autoAdvance: false,
        highlightedWordIndex: -1,
      },
      recordingState: {
        isRecording: false,
        saveDirectory: "",
        audioFormat: "mp3",
        savedFiles: [],
      },
      settingsPanelOpen: false,
      ambientState: {
        currentTrackId: null,
        volume: 0.4,
        loopMode: 'all',
        isPlaying: false,
      },
      authState: {
        supabaseUserId: null,
        supabaseEmail: null,
        syncStatus: 'idle',
      },
      sentenceQueue: {
        sentences: [],
        currentSentenceIndex: -1,
        sentenceAudioCache: {},
        prefetchingSentenceIndex: -1,
        sentenceAbortControllers: {},
        currentSentenceWordTimings: [],
      } as SentenceQueueState,

      // ── View ──────────────────────────────────────────────
      setView: (view, novelId = null) =>
        set({ view, activeNovelId: novelId ?? get().activeNovelId }),
      setActiveNovel: (id) => set({ activeNovelId: id }),

      // ── Library ───────────────────────────────────────────
      saveNovel: (toc, coverUrl = null) => {
        const id = novelIdFromUrl(toc.novel_url);
        set((s) => {
          const existing = s.savedNovels.find((n) => n.id === id);
          const entry: SavedNovel = existing
            ? {
                ...existing,
                title: toc.novel_title,
                totalChapters: toc.total_chapters,
                coverUrl: coverUrl ?? existing.coverUrl,
                toc,
              }
            : {
                id,
                url: toc.novel_url,
                title: toc.novel_title,
                coverUrl,
                totalChapters: toc.total_chapters,
                addedAt: Date.now(),
                lastChapterUrl: null,
                lastChapterTitle: null,
                toc,
              };
          const others = s.savedNovels.filter((n) => n.id !== id);
          return { savedNovels: [entry, ...others] };
        });
        return id;
      },

      removeNovel: (id) =>
        set((s) => ({ savedNovels: s.savedNovels.filter((n) => n.id !== id) })),

      updateNovelProgress: (id, chapterUrl, chapterTitle) =>
        set((s) => ({
          savedNovels: s.savedNovels.map((n) =>
            n.id === id
              ? { ...n, lastChapterUrl: chapterUrl, lastChapterTitle: chapterTitle }
              : n
          ),
        })),

      openNovel: (novel) =>
        set({
          view: "reader",
          activeNovelId: novel.id,
          novelUrl: novel.url,
          toc: novel.toc,
          currentChapterUrl: novel.lastChapterUrl,
          currentChapter: null,
          wordTimings: [],
        }),

      // ── Novel (transient) ─────────────────────────────────
      setNovelUrl: (url) => set({ novelUrl: url }),
      setToc: (toc) => set({ toc }),
      setCurrentChapter: (chapter) => set({ currentChapter: chapter }),
      setCurrentChapterUrl: (url) =>
        set((state) => ({
          currentChapterUrl: url,
          // Reset sentence index when switching chapters so the guest resume fallback
          // never reads a stale index from a different chapter
          ...(url !== state.currentChapterUrl ? { currentSentenceIndex: -1 } : {}),
        })),
      setLoadingToc: (v) => set({ loadingToc: v }),
      setLoadingChapter: (v) => set({ loadingChapter: v }),

      // ── Word timings ──────────────────────────────────────
      setWordTimings: (timings) => set({ wordTimings: timings }),

      // ── TTS settings ──────────────────────────────────────
      updateTTSSettings: (patch) =>
        set((s) => ({ ttsSettings: { ...s.ttsSettings, ...patch } })),

      // ── Player ───────────────────────────────────────────
      setPlaying: (v) =>
        set((s) => ({ playerState: { ...s.playerState, isPlaying: v } })),
      setPlayerLoading: (v) =>
        set((s) => ({ playerState: { ...s.playerState, isLoading: v } })),
      setProviderUsed: (provider, fallback, reason) =>
        set((s) => ({
          playerState: {
            ...s.playerState,
            providerUsed: provider,
            fallbackUsed: fallback,
            fallbackReason: reason,
          },
        })),
      setAutoAdvance: (v) =>
        set((s) => ({ playerState: { ...s.playerState, autoAdvance: v } })),
      setHighlightedWordIndex: (idx) =>
        set((s) => ({ playerState: { ...s.playerState, highlightedWordIndex: idx } })),

      // ── Chapter completion ────────────────────────────────
      markChapterFinished: (chapterUrl) =>
        set((s) => {
          if (s.finishedChapterUrls.includes(chapterUrl)) return s;
          return { finishedChapterUrls: [...s.finishedChapterUrls, chapterUrl] };
        }),
      isChapterFinished: (chapterUrl) =>
        get().finishedChapterUrls.includes(chapterUrl),

      // ── Recording ────────────────────────────────────────
      setRecording: (v) =>
        set((s) => ({ recordingState: { ...s.recordingState, isRecording: v } })),
      setSaveDirectory: (dir) =>
        set((s) => ({ recordingState: { ...s.recordingState, saveDirectory: dir } })),
      setRecordingFormat: (fmt) =>
        set((s) => ({ recordingState: { ...s.recordingState, audioFormat: fmt } })),
      addSavedFile: (path) =>
        set((s) => ({
          recordingState: {
            ...s.recordingState,
            savedFiles: [path, ...s.recordingState.savedFiles.slice(0, 19)],
          },
        })),

      // ── UI ───────────────────────────────────────────────
      toggleSettingsPanel: () =>
        set((s) => ({ settingsPanelOpen: !s.settingsPanelOpen })),

      // ── Ambient player ────────────────────────────────────
      setAmbientTrack: (id) =>
        set((s) => ({ ambientState: { ...s.ambientState, currentTrackId: id } })),
      setAmbientVolume: (volume) =>
        set((s) => ({ ambientState: { ...s.ambientState, volume } })),
      setAmbientLoopMode: (loopMode) =>
        set((s) => ({ ambientState: { ...s.ambientState, loopMode } })),
      setAmbientPlaying: (isPlaying) =>
        set((s) => ({ ambientState: { ...s.ambientState, isPlaying } })),

      // ── Auth (transient) ─────────────────────────────────
      setAuthState: (auth) =>
        set((state) => ({
          authState: { ...state.authState, ...auth },
        })),

      // ── Sentence queue ────────────────────────────────────
      setSentences: (sentences: string[]) =>
        set((state) => {
          // Revoke all blob URLs from previous chapter before replacing
          Object.values(state.sentenceQueue.sentenceAudioCache).forEach(
            (url) => URL.revokeObjectURL(url)
          )
          // Abort all in-flight prefetch requests
          Object.values(state.sentenceQueue.sentenceAbortControllers).forEach(
            (c) => c.abort()
          )
          return {
            sentenceQueue: {
              sentences,
              currentSentenceIndex: -1,
              sentenceAudioCache: {},
              prefetchingSentenceIndex: -1,
              sentenceAbortControllers: {},
              currentSentenceWordTimings: [],
            },
          }
        }),

      setCurrentSentenceIndex: (index: number) =>
        set((state) => ({
          currentSentenceIndex: index,  // persisted top-level
          // Also persist per-chapter so we can restore when returning to this chapter
          chapterProgress: state.currentChapterUrl && index >= 0
            ? { ...state.chapterProgress, [state.currentChapterUrl]: index }
            : state.chapterProgress,
          sentenceQueue: { ...state.sentenceQueue, currentSentenceIndex: index },
        })),

      cacheSentenceAudio: (index: number, blobUrl: string) =>
        set((state) => ({
          sentenceQueue: {
            ...state.sentenceQueue,
            sentenceAudioCache: { ...state.sentenceQueue.sentenceAudioCache, [index]: blobUrl },
          },
        })),

      evictSentenceAudio: (index: number) =>
        set((state) => {
          const cache = { ...state.sentenceQueue.sentenceAudioCache }
          if (cache[index]) {
            URL.revokeObjectURL(cache[index])  // release Blob from browser memory
            delete cache[index]
          }
          return { sentenceQueue: { ...state.sentenceQueue, sentenceAudioCache: cache } }
        }),

      registerAbortController: (index: number, controller: AbortController) =>
        set((state) => ({
          sentenceQueue: {
            ...state.sentenceQueue,
            sentenceAbortControllers: {
              ...state.sentenceQueue.sentenceAbortControllers,
              [index]: controller,
            },
            prefetchingSentenceIndex: index,
          },
        })),

      abortAllPrefetches: () =>
        set((state) => {
          Object.values(state.sentenceQueue.sentenceAbortControllers).forEach((c) => c.abort())
          return {
            sentenceQueue: {
              ...state.sentenceQueue,
              sentenceAbortControllers: {},
              prefetchingSentenceIndex: -1,
            },
          }
        }),

      setCurrentSentenceWordTimings: (timings: WordTiming[]) =>
        set((state) => ({
          sentenceQueue: { ...state.sentenceQueue, currentSentenceWordTimings: timings },
        })),
    }),
    {
      name: "audiotruyen-store",
      // Persist view state so the reader page survives a reload
      // Also persist library + settings + finished chapters; NOT transient reader state
      partialize: (state) => ({
        view: state.view,
        activeNovelId: state.activeNovelId,
        savedNovels: state.savedNovels,
        finishedChapterUrls: state.finishedChapterUrls,
        ttsSettings: state.ttsSettings,
        recordingState: {
          saveDirectory: state.recordingState.saveDirectory,
          audioFormat: state.recordingState.audioFormat,
          savedFiles: [],
          isRecording: false,
        },
        currentChapterUrl: state.currentChapterUrl,
        currentSentenceIndex: state.currentSentenceIndex,
        chapterProgress: state.chapterProgress,
        ambientState: {
          currentTrackId: state.ambientState.currentTrackId,
          volume: state.ambientState.volume,
          loopMode: state.ambientState.loopMode,
          // isPlaying intentionally excluded — avoids browser autoplay-policy block on reload
        },
      }),
    }
  )
);
