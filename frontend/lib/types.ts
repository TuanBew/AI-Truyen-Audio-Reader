// Global application types for AudioTruyen

export type AudioFormat = "mp3" | "wav";

export type TTSProvider = "gemini" | "openai" | "minimax" | "gtranslate";

export interface ChapterMeta {
  title: string;
  number: number | null;
  url: string;
}

export interface TocData {
  novel_title: string;
  novel_url: string;
  total_chapters: number;
  chapters: ChapterMeta[];
}

export interface ChapterData {
  novel_title: string;
  chapter_title: string;
  chapter_number: number | null;
  content: string;
  prev_url: string | null;
  next_url: string | null;
  source_url: string;
}

export interface TTSSettings {
  preferredProvider: TTSProvider;
  audioFormat: AudioFormat;
  // Gemini
  geminiVoice: string;
  geminiLanguage: string;
  // OpenAI
  openaiVoice: string;
  openaiModel: string;
  // MiniMax
  minimaxVoiceId: string;
  // Common
  speed: number;
  pitch: number;
  // API keys (stored in localStorage, sent to backend in headers)
  openaiApiKey: string;
  minimaxApiKey: string;
  minimaxGroupId: string;
  geminiCredentialsPath: string;
}

/** Word-level timing data returned by the backend TTS timing endpoint */
export interface WordTiming {
  word: string;
  start_ms: number;
  end_ms: number;
}

export interface PlayerState {
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  providerUsed: TTSProvider | null;
  fallbackUsed: boolean;
  fallbackReason: string;
  autoAdvance: boolean;
  /** Index of currently highlighted word (-1 = none) */
  highlightedWordIndex: number;
}

export interface RecordingState {
  isRecording: boolean;
  saveDirectory: string;
  audioFormat: AudioFormat;
  savedFiles: string[];
}

/** A novel saved in the user's library */
export interface SavedNovel {
  id: string;           // URL-based unique ID (btoa of novel_url)
  url: string;          // canonical novel URL
  title: string;
  coverUrl: string | null;
  totalChapters: number;
  addedAt: number;      // Date.now()
  lastChapterUrl: string | null;
  lastChapterTitle: string | null;
  toc: TocData;         // full TOC stored for instant restore
}

export type AppView = "home" | "reader";

export interface AppState {
  // View / navigation
  view: AppView;
  activeNovelId: string | null;

  // Novel library (persisted)
  savedNovels: SavedNovel[];

  // Finished chapters (persisted) — set of chapter URLs where ≥90% was read
  finishedChapterUrls: string[];

  // Novel & chapters (transient)
  novelUrl: string;
  toc: TocData | null;
  currentChapter: ChapterData | null;
  currentChapterUrl: string | null;
  loadingToc: boolean;
  loadingChapter: boolean;

  // Word-level timing (transient, resets each synthesis)
  wordTimings: WordTiming[];

  // TTS / Player
  ttsSettings: TTSSettings;
  playerState: PlayerState;

  // Recording
  recordingState: RecordingState;

  // UI
  settingsPanelOpen: boolean;
}
