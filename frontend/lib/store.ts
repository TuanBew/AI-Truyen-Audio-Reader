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
} from "./types";

const defaultTTSSettings: TTSSettings = {
  preferredProvider: "gemini",
  audioFormat: "mp3",
  geminiVoice: "vi-VN-Neural2-A",
  geminiLanguage: "vi-VN",
  openaiVoice: "nova",
  openaiModel: "tts-1",
  minimaxVoiceId: "male-qn-qingse",
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
      setCurrentChapterUrl: (url) => set({ currentChapterUrl: url }),
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
      }),
    }
  )
);
