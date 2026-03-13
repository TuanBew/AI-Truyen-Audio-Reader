"use client";

import { useRef, useEffect, useCallback, useMemo, Fragment } from "react";
import { Loader2, ChevronLeft, ChevronRight, BookOpen } from "lucide-react";
import { toast } from "react-toastify";
import { useAppStore } from "@/lib/store";

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

interface SentenceSegment {
  text: string
  index: number
  paraBreak: boolean
}

function buildSentenceSegments(content: string, sentences: string[]): SentenceSegment[] {
  if (!sentences.length) return []
  const paragraphs = content.replace(/\r\n/g, '\n').split('\n').filter((p) => p.trim())
  const result: SentenceSegment[] = []
  let sentIdx = 0
  let searchFrom = 0

  for (const para of paragraphs) {
    const paraStart = content.indexOf(para, searchFrom)
    if (paraStart === -1) continue
    let isFirstInPara = true
    let paraOffset = paraStart

    while (sentIdx < sentences.length) {
      const sent = sentences[sentIdx].trim()
      const pos = content.indexOf(sent, paraOffset)
      if (pos === -1 || pos > paraStart + para.length) break
      result.push({ text: sentences[sentIdx], index: sentIdx, paraBreak: isFirstInPara })
      paraOffset = pos + sent.length
      searchFrom = paraOffset
      sentIdx++
      isFirstInPara = false
    }
  }

  // Append unmatched sentences (handles edge cases)
  while (sentIdx < sentences.length) {
    result.push({ text: sentences[sentIdx], index: sentIdx, paraBreak: false })
    sentIdx++
  }

  return result
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

  const { highlightedWordIndex } = playerState;

  const { sentences, currentSentenceIndex: activeSentenceIdx } = useAppStore(
    (s) => s.sentenceQueue
  )

  const sentenceSegments = useMemo(
    () =>
      currentChapter?.content
        ? buildSentenceSegments(currentChapter.content, sentences)
        : [],
    [currentChapter?.content, sentences]
  )

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

  // Auto-scroll to active sentence
  useEffect(() => {
    if (activeSentenceIdx < 0) return
    document.getElementById(`sent-${activeSentenceIdx}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeSentenceIdx])

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
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8" style={{ background: '#0c0c1e', color: '#6d6d9a' }}>
        <BookOpen size={48} className="opacity-40" />
        <div className="text-center">
          <p className="text-lg font-medium" style={{ color: '#6d6d9a' }}>Chưa có truyện nào được tải</p>
          <p className="text-sm mt-1">Nhập URL truyện vào ô bên trái và nhấn 🔍</p>
        </div>
      </div>
    );
  }

  if (loadingChapter) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: '#0c0c1e', color: '#6d6d9a' }}>
        <Loader2 size={32} className="animate-spin mr-3" />
        <span>Đang tải chương…</span>
      </div>
    );
  }

  if (!currentChapter) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: '#0c0c1e', color: '#6d6d9a' }}>
        <p>← Chọn chương để bắt đầu đọc</p>
      </div>
    );
  }

  // Split content into word tokens with paragraph markers
  const wordTokens = splitToWords(currentChapter.content);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: '#0c0c1e' }}>
      {/* Chapter header */}
      <div
        className="px-6 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(124,58,237,0.2)' }}
      >
        <p className="text-xs mb-1" style={{ color: '#6d6d9a' }}>{currentChapter.novel_title}</p>
        <h1 className="text-xl font-bold leading-snug" style={{ color: '#e2e8f0' }}>
          {currentChapter.chapter_title}
        </h1>
      </div>

      {/* Chapter text — sentence-level when TTS loaded, word-level fallback */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-8 py-6 w-full">
        <div className="mx-auto max-w-[72ch] text-[1.25rem] leading-[1.85] font-sans tracking-wide"
          style={{ color: '#c7c7e0' }}>
          {sentenceSegments.length > 0 ? (
            sentenceSegments.map((seg) => (
              <Fragment key={seg.index}>
                {seg.paraBreak && seg.index > 0 && <div className="mt-[1em]" />}
                <span
                  id={`sent-${seg.index}`}
                  className="transition-colors duration-200"
                  style={seg.index === activeSentenceIdx
                    ? { background: 'rgba(167,139,250,0.15)', color: '#e2e8f0', borderRadius: '2px', padding: '0 2px' }
                    : undefined}
                >
                  {seg.text}{' '}
                </span>
              </Fragment>
            ))
          ) : (
            <p>
              {wordTokens.map((token) => {
                const isCurrent = token.globalIndex === highlightedWordIndex;
                return (
                  <span key={token.globalIndex}>
                    {token.paraBreakBefore && <br className="mb-3 block" />}
                    <span
                      ref={isCurrent ? highlightedRef : undefined}
                      className="transition-colors duration-100"
                      style={isCurrent
                        ? { color: '#fbbf24', textDecoration: 'underline', textDecorationColor: 'rgba(251,191,36,0.5)' }
                        : undefined}
                    >
                      {token.word}
                    </span>{" "}
                  </span>
                );
              })}
            </p>
          )}
        </div>
      </div>

      {/* Prev / Next navigation */}
      <div
        className="flex-shrink-0 px-6 py-3 flex justify-between items-center"
        style={{ borderTop: '1px solid rgba(124,58,237,0.2)', background: '#0e0e28' }}
      >
        <button
          onClick={() => navigateTo(currentChapter.prev_url)}
          disabled={!currentChapter.prev_url}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: '#1a1a3e', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
        >
          <ChevronLeft size={16} /> Chương trước
        </button>
        <span className="text-xs" style={{ color: '#4a4a7a' }}>
          {currentChapter.chapter_number ? `Chương ${currentChapter.chapter_number}` : ''}
        </span>
        <button
          onClick={() => navigateTo(currentChapter.next_url)}
          disabled={!currentChapter.next_url}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: '#1a1a3e', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
        >
          Chương sau <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
