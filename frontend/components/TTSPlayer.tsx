"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Play, Pause, Square, Volume2, AlertTriangle, Loader2, RefreshCw
} from "lucide-react";
import AudioVisualizer from "./AudioVisualizer";
import { toast } from "react-toastify";
import { useAppStore } from "@/lib/store";
import { supabase } from "@/lib/supabase";
import type { TTSProvider, WordTiming } from "@/lib/types";
import { useSyncProgress } from "@/lib/hooks/useSyncProgress";

const PROVIDER_LABELS: Record<TTSProvider, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  minimax: "MiniMax",
  xtts: "XTTS",
  edge: "Microsoft Edge",
  gtranslate: "Google Translate",
};

const PROVIDER_COLORS: Record<TTSProvider, string> = {
  gemini: "#00ffff",
  openai: "#00ffff",
  minimax: "#00ffff",
  xtts: "#00ffff",
  edge: "#00ffff",
  gtranslate: "#00ffff",
};

/** Chapter is marked "finished" when this % of words have been highlighted */
const COMPLETION_THRESHOLD = 0.9;

interface Props {
  text: string;
  chapterTitle: string;
  chapterUrl: string;
  onEnded?: () => void;
}

export default function TTSPlayer({ text, chapterTitle, chapterUrl, onEnded }: Props) {
  const {
    ttsSettings,
    playerState,
    wordTimings,
    setPlaying,
    setPlayerLoading,
    setProviderUsed,
    setAutoAdvance,
    setWordTimings,
    setHighlightedWordIndex,
    markChapterFinished,
    isChapterFinished,
  } = useAppStore();

  // Sentence queue state and actions
  const currentChapter = useAppStore((s) => s.currentChapter);
  const setSentences = useAppStore((s) => s.setSentences);
  const { sentences, currentSentenceIndex } = useAppStore(
    (s) => s.sentenceQueue
  );
  const cacheSentenceAudio = useAppStore((s) => s.cacheSentenceAudio);
  const evictSentenceAudio = useAppStore((s) => s.evictSentenceAudio);
  const registerAbortController = useAppStore((s) => s.registerAbortController);
  const abortAllPrefetches = useAppStore((s) => s.abortAllPrefetches);
  const setCurrentSentenceIndex = useAppStore((s) => s.setCurrentSentenceIndex);
  const setCurrentSentenceWordTimings = useAppStore((s) => s.setCurrentSentenceWordTimings);

  const syncProgress = useSyncProgress();

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Deduplication map: index → in-flight promise, so concurrent calls share one request
  const pendingRef = useRef<Map<number, Promise<string | null>>>(new Map());
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const markedFinishedRef = useRef(false);
  const [resumeFromIndex, setResumeFromIndex] = useState(0);

  // Reset finished marker when chapter changes
  useEffect(() => {
    markedFinishedRef.current = isChapterFinished(chapterUrl);
    setHighlightedWordIndex(-1);
  }, [chapterUrl, isChapterFinished, setHighlightedWordIndex]);

  // Clean up blob URL on unmount or new audio
  useEffect(() => {
    return () => {
      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
    };
  }, [audioBlobUrl]);

  // Split chapter into sentences when the loaded chapter changes
  useEffect(() => {
    if (!currentChapter?.content) return;

    const fetchSentences = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/tts/split-sentences`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: currentChapter.content }),
        });
        if (!res.ok) throw new Error(`Split failed: ${res.status}`);
        const data = await res.json();
        setSentences(data.sentences); // revokes previous blobs automatically

        // Restore resume position: prefer Supabase (logged-in users), fall back to localStorage
        const userId = useAppStore.getState().authState.supabaseUserId
        let restoredIndex = 0

        if (userId && currentChapter?.source_url) {
          const { data: progressData } = await supabase
            .from('reading_progress')
            .select('sentence_index')
            .eq('user_id', userId)
            .eq('chapter_url', currentChapter.source_url)
            .single()

          if (progressData && progressData.sentence_index > 0) {
            restoredIndex = progressData.sentence_index
          }
        }

        // Guest fallback: use persisted store index (only if it belongs to this chapter)
        if (restoredIndex === 0) {
          const state = useAppStore.getState()
          const persistedIndex = state.currentSentenceIndex
          const persistedUrl = state.currentChapterUrl
          if (
            persistedIndex > 0 &&
            persistedIndex < data.sentences.length &&
            persistedUrl === currentChapter?.source_url
          ) {
            restoredIndex = persistedIndex
          }
        }

        if (restoredIndex > 0) {
          setResumeFromIndex(restoredIndex)
        }
      } catch (err) {
        console.error("Failed to split chapter into sentences:", err);
      }
    };

    fetchSentences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter?.source_url]);

  // Cleanup on unmount: revoke all cached blob URLs and clear the store
  useEffect(() => {
    return () => {
      const cache = useAppStore.getState().sentenceQueue.sentenceAudioCache;
      Object.values(cache).forEach((url) => URL.revokeObjectURL(url));
      useAppStore.getState().abortAllPrefetches();
      pendingRef.current.clear();
      useAppStore.getState().setSentences([]);
    };
  }, []);

  const synthesizeSentence = useCallback(
    async (index: number): Promise<string | null> => {
      const state = useAppStore.getState().sentenceQueue;
      if (state.sentenceAudioCache[index]) return state.sentenceAudioCache[index];

      // Return existing in-flight promise instead of launching a duplicate request
      const existing = pendingRef.current.get(index);
      if (existing) return existing;

      const controller = new AbortController();
      registerAbortController(index, controller);

      const promise = (async () => {
        try {
          const res = await fetch(`${apiUrl}/api/tts/synthesize-with-timing`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(ttsSettings.openaiApiKey
                ? { "X-OpenAI-Key": ttsSettings.openaiApiKey }
                : {}),
              ...(ttsSettings.minimaxApiKey
                ? { "X-MiniMax-Key": ttsSettings.minimaxApiKey }
                : {}),
              ...(ttsSettings.minimaxGroupId
                ? { "X-MiniMax-Group-Id": ttsSettings.minimaxGroupId }
                : {}),
            },
            body: JSON.stringify({
              text: useAppStore.getState().sentenceQueue.sentences[index],
              preferred_provider: ttsSettings.preferredProvider,
              audio_format: ttsSettings.audioFormat,
              gemini_voice: ttsSettings.geminiVoice,
              gemini_language: ttsSettings.geminiLanguage,
              openai_voice: ttsSettings.openaiVoice,
              openai_model: ttsSettings.openaiModel,
              minimax_voice_id: ttsSettings.minimaxVoiceId,
              speed: ttsSettings.speed,
              pitch: ttsSettings.pitch,
            }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
          const data = await res.json();

          const audioB64 = data.audio_b64 ?? data.audio_base64;
          const audioBytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
          const mimeType = ttsSettings.audioFormat === "wav" ? "audio/wav" : "audio/mpeg";
          const blob = new Blob([audioBytes], { type: mimeType });
          const blobUrl = URL.createObjectURL(blob);
          cacheSentenceAudio(index, blobUrl);

          if (data.word_timings) {
            setCurrentSentenceWordTimings(data.word_timings);
          }
          return blobUrl;
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return null; // Seek cancelled this prefetch — silently discard
          }
          console.error(`Sentence ${index} synthesis failed:`, err);
          return null;
        } finally {
          pendingRef.current.delete(index);
        }
      })();

      pendingRef.current.set(index, promise);
      return promise;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiUrl, ttsSettings, registerAbortController, cacheSentenceAudio, setCurrentSentenceWordTimings]
  );

  const playSentence = useCallback(
    async (index: number) => {
      const url = await synthesizeSentence(index);
      if (!url || !audioRef.current) return;

      audioRef.current.src = url;
      audioRef.current.play().catch(() => {});
      setCurrentSentenceIndex(index);
      setPlaying(true);

      // Sync progress to Supabase (debounced 1s; no-op for guests)
      const totalSentences = useAppStore.getState().sentenceQueue.sentences.length;
      const isFinished = index >= totalSentences - 1;
      syncProgress(chapterUrl, index, -1, isFinished);

      // Prefetch the next two sentences (2-sentence lookahead reduces inter-sentence gaps)
      const next = index + 1;
      if (next < totalSentences) {
        synthesizeSentence(next); // fire-and-forget; AbortController handles cancellation
      }
      const next2 = index + 2;
      if (next2 < totalSentences) {
        synthesizeSentence(next2); // fire-and-forget; second lookahead
      }

      // Evict sentence from 2 before current (retain current-1, current, current+1)
      const toEvict = index - 2;
      if (toEvict >= 0) evictSentenceAudio(toEvict);
    },
    [synthesizeSentence, setCurrentSentenceIndex, setPlaying, evictSentenceAudio, syncProgress, chapterUrl]
  );

  const seekToSentence = useCallback(
    async (index: number) => {
      abortAllPrefetches(); // cancel all in-flight fetches immediately
      pendingRef.current.clear(); // discard stale in-flight promises
      await playSentence(index);
    },
    [abortAllPrefetches, playSentence]
  );

  const synthesize = useCallback(async () => {
    setPlayerLoading(true);
    setPlaying(false);
    setHighlightedWordIndex(-1);
    markedFinishedRef.current = isChapterFinished(chapterUrl);

    // Revoke old blob
    if (audioBlobUrl) {
      URL.revokeObjectURL(audioBlobUrl);
      setAudioBlobUrl(null);
    }

    try {
      const body = {
        text: text.slice(0, 7500),
        preferred_provider: ttsSettings.preferredProvider,
        audio_format: ttsSettings.audioFormat,
        gemini_voice: ttsSettings.geminiVoice,
        gemini_language: ttsSettings.geminiLanguage,
        openai_voice: ttsSettings.openaiVoice,
        openai_model: ttsSettings.openaiModel,
        minimax_voice_id: ttsSettings.minimaxVoiceId,
        speed: ttsSettings.speed,
        pitch: ttsSettings.pitch,
      };

      const res = await fetch("/api/tts/synthesize-with-timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const providerUsed = (data.provider_used ?? "gemini") as TTSProvider;
      const fallbackUsed = !!data.fallback_used;
      const fallbackReason = data.fallback_reason ?? "";

      setProviderUsed(providerUsed, fallbackUsed, fallbackReason);

      if (fallbackUsed && fallbackReason) {
        toast.warn(
          `Dùng ${PROVIDER_LABELS[providerUsed]} (dự phòng): ${fallbackReason.split(":")[0]}`,
          { autoClose: 5000 }
        );
      }

      // Store word timings
      const timings: WordTiming[] = data.word_timings ?? [];
      setWordTimings(timings);

      // Decode base64 audio → blob URL
      const audioBytes = Uint8Array.from(atob(data.audio_b64), (c) => c.charCodeAt(0));
      const mimeType = data.audio_format === "wav" ? "audio/wav" : "audio/mpeg";
      const blob = new Blob([audioBytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      setAudioBlobUrl(url);

      // Play immediately
      setTimeout(() => {
        audioRef.current?.play().catch(() => {});
        setPlaying(true);
      }, 100);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Lỗi tổng hợp giọng đọc";
      toast.error(`Lỗi TTS: ${msg}`);
    } finally {
      setPlayerLoading(false);
    }
  }, [
    text,
    chapterUrl,
    ttsSettings,
    audioBlobUrl,
    setPlaying,
    setPlayerLoading,
    setProviderUsed,
    setWordTimings,
    setHighlightedWordIndex,
    isChapterFinished,
  ]);

  const handlePlayPause = () => {
    // Sentence-queue mode: route through per-sentence synthesis to respect provider byte limits
    if (sentences.length > 0) {
      if (playerState.isPlaying) {
        audioRef.current?.pause();
        setPlaying(false);
      } else if (currentSentenceIndex >= 0) {
        // Resume paused sentence
        audioRef.current?.play().catch(() => {});
        setPlaying(true);
      } else {
        // First play — start from saved resume point or sentence 0
        playSentence(resumeFromIndex || 0);
      }
      return;
    }

    // Full-chapter fallback (used only when sentence splitting hasn't loaded yet)
    if (!audioBlobUrl) {
      synthesize();
      return;
    }
    if (playerState.isPlaying) {
      audioRef.current?.pause();
      setPlaying(false);
    } else {
      audioRef.current?.play().catch(() => {});
      setPlaying(true);
    }
  };

  const handleStop = () => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setPlaying(false);
    setProgress(0);
    setHighlightedWordIndex(-1);
    setCurrentSentenceIndex(-1); // allow Play to restart from sentence 0
  };

  const handleTimeUpdate = () => {
    const el = audioRef.current;
    if (!el || !el.duration) return;

    const currentMs = el.currentTime * 1000;

    // Update progress bar
    setProgress((el.currentTime / el.duration) * 100);

    // Update highlighted word from timing data
    const timings = wordTimings;
    if (timings.length > 0) {
      // Binary-search for the current word
      let lo = 0;
      let hi = timings.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (timings[mid].start_ms <= currentMs) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      setHighlightedWordIndex(idx);

      // Mark chapter finished at threshold
      if (!markedFinishedRef.current && timings.length > 0) {
        const highlightedCount = idx + 1;
        const ratio = highlightedCount / timings.length;
        if (ratio >= COMPLETION_THRESHOLD) {
          markedFinishedRef.current = true;
          markChapterFinished(chapterUrl);
        }
      }
    } else {
      // No timing data — use a time-proportion estimate
      const ratio = el.currentTime / el.duration;
      // Estimate word index from current time ratio
      // We don't have word boundaries, so just mark at threshold
      if (!markedFinishedRef.current && ratio >= COMPLETION_THRESHOLD) {
        markedFinishedRef.current = true;
        markChapterFinished(chapterUrl);
      }
    }
  };

  const handleSentenceEnded = useCallback(() => {
    const { sentences: currentSentences, currentSentenceIndex: curIdx } =
      useAppStore.getState().sentenceQueue;
    const nextIndex = curIdx + 1;
    const isLastSentence = curIdx >= currentSentences.length - 1;

    if (isLastSentence) {
      // Chapter complete — fall through to handleEnded logic
      return;
    }

    playSentence(nextIndex);
  }, [playSentence]);

  const handleEnded = useCallback(() => {
    // If we're in sentence mode and there's a next sentence, let handleSentenceEnded manage it
    const { sentences: currentSentences, currentSentenceIndex: curIdx } =
      useAppStore.getState().sentenceQueue;
    const isInSentenceMode = currentSentences.length > 0 && curIdx >= 0;
    const isLastSentence = curIdx >= currentSentences.length - 1;

    if (isInSentenceMode && !isLastSentence) {
      handleSentenceEnded();
      return;
    }

    // Original handleEnded logic
    setPlaying(false);
    setProgress(0);
    // Mark all words highlighted on complete playback
    if (wordTimings.length > 0) {
      setHighlightedWordIndex(wordTimings.length - 1);
    }
    // Mark chapter finished if not already
    if (!markedFinishedRef.current) {
      markedFinishedRef.current = true;
      markChapterFinished(chapterUrl);
    }
    // Auto-advance fires here — only when audio truly ends
    onEnded?.();
  }, [
    handleSentenceEnded,
    setPlaying,
    wordTimings,
    setHighlightedWordIndex,
    markChapterFinished,
    chapterUrl,
    onEnded,
  ]);

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    el.currentTime = (x / rect.width) * el.duration;
  };

  const { providerUsed, fallbackUsed, isLoading } = playerState;

  return (
    <div
      className="relative px-4 py-3 flex flex-col gap-2"
      style={{ background: '#0d0d24', borderBottom: '1px solid rgba(124,58,237,0.25)' }}
    >
      {/* Resume toast */}
      {resumeFromIndex > 0 && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 mx-4 flex items-center justify-between rounded-xl px-4 py-2 text-sm backdrop-blur"
          style={{ background: 'rgba(109,40,217,0.85)', color: '#e2e8f0', border: '1px solid rgba(124,58,237,0.4)' }}
        >
          <span>Tiếp tục từ câu {resumeFromIndex + 1}?</span>
          <div className="flex gap-2">
            <button
              onClick={() => { seekToSentence(resumeFromIndex); setResumeFromIndex(0) }}
              className="rounded-lg px-3 py-1 text-xs font-medium transition-colors"
              style={{ background: '#7c3aed', color: '#fff', boxShadow: '0 0 8px rgba(124,58,237,0.5)' }}
            >
              Tiếp tục
            </button>
            <button
              onClick={() => setResumeFromIndex(0)}
              className="text-xs transition-colors"
              style={{ color: '#6d6d9a' }}
            >
              Bỏ qua
            </button>
          </div>
        </div>
      )}

      {/* Audio element (hidden) */}
      <audio
        ref={audioRef}
        src={audioBlobUrl ?? undefined}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        onError={() => toast.error("Lỗi phát âm thanh")}
      />

      <div className="flex items-center gap-3">
        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Re-synthesize */}
          <button
            onClick={() => synthesize()}
            disabled={isLoading}
            title="Tổng hợp lại"
            className="p-1.5 rounded transition-colors disabled:opacity-40"
            style={{ color: '#a78bfa' }}
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>

          {/* Play / Pause */}
          <button
            onClick={handlePlayPause}
            disabled={isLoading}
            className="flex items-center justify-center w-10 h-10 rounded-full transition-colors"
            style={
              isLoading
                ? { background: 'rgba(124,58,237,0.2)', color: '#6d6d9a', cursor: 'wait' }
                : { background: '#7c3aed', color: '#fff', boxShadow: '0 0 12px rgba(124,58,237,0.5)' }
            }
            title={playerState.isPlaying ? "Dừng" : "Phát"}
          >
            {isLoading ? (
              <Loader2 size={18} className="animate-spin" style={{ color: '#a78bfa' }} />
            ) : playerState.isPlaying ? (
              <Pause size={18} />
            ) : (
              <Play size={18} />
            )}
          </button>

          {/* Stop */}
          <button
            onClick={handleStop}
            className="p-1.5 rounded transition-colors"
            style={{ color: '#a78bfa' }}
            title="Dừng hẳn"
          >
            <Square size={14} />
          </button>
        </div>

        {/* Progress bar */}
        <div
          className="flex-1 h-2 rounded-full cursor-pointer"
          style={{ background: 'rgba(124,58,237,0.15)' }}
          onClick={seekTo}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${progress}%`, background: '#a78bfa' }}
          />
        </div>

        {/* Sentence counter */}
        {sentences.length > 0 && (
          <span className="text-xs font-mono" style={{ color: '#6d6d9a' }}>
            S.{Math.max(1, currentSentenceIndex + 1)}/{sentences.length}
          </span>
        )}

        {/* Auto-advance toggle */}
        <label
          className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
          style={{ color: playerState.autoAdvance ? '#a78bfa' : '#6d6d9a' }}
        >
          <input
            type="checkbox"
            checked={playerState.autoAdvance}
            onChange={(e) => setAutoAdvance(e.target.checked)}
            className="accent-violet-500"
          />
          Tự chuyển
        </label>
      </div>

      {/* Audio visualizer */}
      <AudioVisualizer audioElement={audioRef.current} isPlaying={playerState.isPlaying} />

      {/* Provider badge */}
      {providerUsed && (
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <Volume2 size={12} style={{ color: PROVIDER_COLORS[providerUsed] }} />
          <span style={{ color: PROVIDER_COLORS[providerUsed] }}>
            {PROVIDER_LABELS[providerUsed]}
          </span>
          {fallbackUsed && (
            <span className="flex items-center gap-1" style={{ color: '#fbbf24' }}>
              <AlertTriangle size={11} /> dự phòng
            </span>
          )}
        </div>
      )}
    </div>
  );
}
