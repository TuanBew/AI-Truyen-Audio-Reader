"use client";

import { useRef, useEffect, useCallback } from "react";
import { Loader2, ChevronLeft, ChevronRight, BookOpen } from "lucide-react";
import { toast } from "react-toastify";
import { useAppStore } from "@/lib/store";
import TTSPlayer from "./TTSPlayer";
import RecordingControls from "./RecordingControls";

/**
 * Split chapter content into a flat array of words, preserving paragraph boundaries.
 * Returns: [{ word: string; paraBreakBefore: boolean; globalIndex: number }]
 */
function splitToWords(content: string) {
  const paragraphs = content.split(/\n\n+/);
  const result: { word: string; paraBreakBefore: boolean; globalIndex: number }[] = [];
  let globalIndex = 0;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const words = paragraphs[pi].match(/\S+/g) ?? [];
    for (let wi = 0; wi < words.length; wi++) {
      result.push({
        word: words[wi],
        paraBreakBefore: wi === 0 && pi > 0,
        globalIndex: globalIndex++,
      });
    }
  }
  return result;
}

export default function ReaderPanel() {
  const {
    currentChapter,
    loadingChapter,
    toc,
    currentChapterUrl,
    setCurrentChapter,
    setCurrentChapterUrl,
    setLoadingChapter,
    setWordTimings,
    setHighlightedWordIndex,
    setToc,
    activeNovelId,
    updateNovelProgress,
    playerState,
  } = useAppStore();

  const { highlightedWordIndex, autoAdvance } = playerState;

  const contentRef = useRef<HTMLDivElement>(null);
  const highlightedRef = useRef<HTMLSpanElement | null>(null);

  // Scroll to top when chapter changes
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setWordTimings([]);
    setHighlightedWordIndex(-1);
  }, [currentChapter?.source_url, setWordTimings, setHighlightedWordIndex]);

  // Auto-scroll to highlighted word
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [highlightedWordIndex]);

  // Auto-resume: if a chapter was active before reload, silently re-fetch it
  useEffect(() => {
    const state = useAppStore.getState()
    const { activeNovelId: storedNovelId, currentChapterUrl: storedUrl, savedNovels, currentChapter: storedChapter } = state
    if (!storedNovelId || !storedUrl) return
    if (storedChapter) return  // already loaded in this session

    const novel = savedNovels.find((n) => n.id === storedNovelId)
    if (!novel) return

    setToc(novel.toc)
    setLoadingChapter(true)
    fetch(`/api/scrape/chapter?url=${encodeURIComponent(storedUrl)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => { setCurrentChapter(data) })
      .catch((err) => {
        toast.error(`Không thể khôi phục chương: ${err}`)
        setCurrentChapterUrl(null)
      })
      .finally(() => setLoadingChapter(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = useCallback(
    async (url: string | null | undefined) => {
      if (!url) return;
      setCurrentChapterUrl(url);
      setLoadingChapter(true);
      try {
        const res = await fetch(`/api/scrape/chapter?url=${encodeURIComponent(url)}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setCurrentChapter(data);
        if (activeNovelId) {
          updateNovelProgress(activeNovelId, url, data.chapter_title ?? "");
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Lỗi không xác định";
        toast.error(`Không tải được chương: ${msg}`);
        setCurrentChapterUrl(null);
      } finally {
        setLoadingChapter(false);
      }
    },
    [setCurrentChapterUrl, setLoadingChapter, setCurrentChapter, activeNovelId, updateNovelProgress]
  );

  // ── Empty / loading states ──────────────────────────────────────────────

  if (!toc && !currentChapter && !loadingChapter) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-600 gap-4 p-8">
        <BookOpen size={48} className="opacity-40" />
        <div className="text-center">
          <p className="text-lg font-medium text-gray-500">Chưa có truyện nào được tải</p>
          <p className="text-sm mt-1">Nhập URL truyện vào ô bên trái và nhấn 🔍</p>
        </div>
      </div>
    );
  }

  if (loadingChapter) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <Loader2 size={32} className="animate-spin mr-3" />
        <span>Đang tải chương…</span>
      </div>
    );
  }

  if (!currentChapter) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <p>← Chọn chương để bắt đầu đọc</p>
      </div>
    );
  }

  // Split content into word tokens with paragraph markers
  const wordTokens = splitToWords(currentChapter.content);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Chapter header */}
      <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
        <p className="text-xs text-gray-500 mb-1">{currentChapter.novel_title}</p>
        <h1 className="text-xl font-bold text-white leading-snug">
          {currentChapter.chapter_title}
        </h1>
      </div>

      {/* TTS Player + Recording Controls */}
      <div className="flex-shrink-0 border-b border-gray-800 bg-gray-900">
        <TTSPlayer
          text={currentChapter.content}
          chapterTitle={currentChapter.chapter_title}
          chapterUrl={currentChapter.source_url}
          onEnded={() => {
            if (autoAdvance && currentChapter.next_url) {
              navigateTo(currentChapter.next_url);
            }
          }}
        />
        <RecordingControls
          text={currentChapter.content}
          chapterTitle={currentChapter.chapter_title}
        />
      </div>

      {/* Chapter text with word-level highlighting */}
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto px-8 py-6 w-full"
      >
        <div className="mx-auto max-w-[72ch] text-[1.25rem] leading-[1.85] text-gray-100 [&>p]:mb-[1.5em] font-sans tracking-wide">
          <p>
            {wordTokens.map((token) => {
              const isCurrent = token.globalIndex === highlightedWordIndex;
              return (
                <span key={token.globalIndex}>
                  {/* Paragraph break — render space + newline equivalent */}
                  {token.paraBreakBefore && <br className="mb-3 block" />}
                  <span
                    ref={isCurrent ? highlightedRef : undefined}
                    className={`transition-colors duration-100 ${
                      isCurrent
                        ? "text-amber-300 underline decoration-amber-400/50 decoration-2"
                        : ""
                    }`}
                  >
                    {token.word}
                  </span>{" "}
                </span>
              );
            })}
          </p>
        </div>
      </div>

      {/* Prev / Next navigation */}
      <div className="flex-shrink-0 border-t border-gray-800 px-6 py-3 flex justify-between items-center bg-gray-900">
        <button
          onClick={() => navigateTo(currentChapter.prev_url)}
          disabled={!currentChapter.prev_url}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm text-gray-300 hover:text-white"
        >
          <ChevronLeft size={16} />
          Chương trước
        </button>
        <span className="text-xs text-gray-600">
          {currentChapter.chapter_number ? `Chương ${currentChapter.chapter_number}` : ""}
        </span>
        <button
          onClick={() => navigateTo(currentChapter.next_url)}
          disabled={!currentChapter.next_url}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm text-gray-300 hover:text-white"
        >
          Chương sau
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
