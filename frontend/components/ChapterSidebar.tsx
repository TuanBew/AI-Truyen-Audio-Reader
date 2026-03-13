"use client";

import { useState, useRef, useCallback } from "react";
import {
  Search, BookOpen, ChevronLeft, Loader2, AlertCircle
} from "lucide-react";
import { toast } from "react-toastify";
import { useAppStore } from "@/lib/store";
import type { TocData, ChapterMeta } from "@/lib/types";

export default function ChapterSidebar() {
  const {
    novelUrl, setNovelUrl,
    toc, setToc,
    loadingToc, setLoadingToc,
    currentChapterUrl, setCurrentChapterUrl,
    currentChapter, setCurrentChapter, setLoadingChapter,
    activeNovelId, saveNovel, updateNovelProgress,
    setView,
    isChapterFinished,
  } = useAppStore();

  const [inputUrl, setInputUrl] = useState(novelUrl || "");
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const fetchToc = useCallback(async () => {
    const url = inputUrl.trim();
    if (!url) return;
    if (!url.includes("truyenplus.vn")) {
      toast.error("Chỉ hỗ trợ URL từ truyenplus.vn");
      return;
    }

    setLoadingToc(true);
    setError(null);
    setToc(null);
    setNovelUrl(url);

    try {
      const res = await fetch(`/api/scrape/toc?url=${encodeURIComponent(url)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const data: TocData = await res.json();
      setToc(data);

      // ── Persist to library ──────────────────────────────────────
      saveNovel(data, null);

      toast.success(`Đã lưu ${data.total_chapters} chương: ${data.novel_title}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Lỗi không xác định";
      setError(msg);
      toast.error(`Không tải được danh sách chương: ${msg}`);
    } finally {
      setLoadingToc(false);
    }
  }, [inputUrl, setLoadingToc, setToc, setNovelUrl, saveNovel]);

  const loadChapter = useCallback(async (chapterUrl: string, chapterTitle: string) => {
    if (currentChapterUrl === chapterUrl && currentChapter !== null) return;
    setCurrentChapterUrl(chapterUrl);
    setLoadingChapter(true);

    try {
      const res = await fetch(`/api/scrape/chapter?url=${encodeURIComponent(chapterUrl)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCurrentChapter(data);

      // ── Update reading progress ──────────────────────────────────
      if (activeNovelId) {
        updateNovelProgress(activeNovelId, chapterUrl, chapterTitle);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Lỗi không xác định";
      toast.error(`Không tải được chương: ${msg}`);
      setCurrentChapterUrl(null);
    } finally {
      setLoadingChapter(false);
    }
  }, [currentChapterUrl, currentChapter, setCurrentChapterUrl, setLoadingChapter, setCurrentChapter, activeNovelId, updateNovelProgress]);

  return (
    <div className="flex flex-col h-full">
      {/* Back to library */}
      <div className="px-3 pt-3 pb-1">
        <button
          onClick={() => setView('home')}
          className="flex items-center gap-1.5 text-xs transition-colors group"
          style={{ color: '#6d6d9a' }}
        >
          <ChevronLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
          <span className="group-hover:text-violet-400 transition-colors">Thư viện</span>
        </button>
      </div>

      {/* truyenplus.vn-only notice */}
      <div className="mx-3 mb-2 rounded-lg px-3 py-2 flex items-start gap-2"
        style={{ background: 'rgba(0,255,255,0.05)', border: '1px solid rgba(0,255,255,0.15)' }}>
        <span className="text-xs mt-0.5 flex-shrink-0" style={{ color: '#00ffff' }}>ℹ</span>
        <p className="text-xs leading-relaxed" style={{ color: 'rgba(0,255,255,0.6)' }}>
          Chỉ hỗ trợ <span style={{ color: '#00ffff' }} className="font-medium">truyenplus.vn</span>
        </p>
      </div>

      {/* URL Input */}
      <div className="p-3" style={{ borderBottom: '1px solid rgba(124,58,237,0.2)' }}>
        <div className="flex gap-2">
          <input
            type="url"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchToc()}
            placeholder="https://truyenplus.vn/truyen/..."
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none transition-all"
            style={{
              background: '#12122a',
              border: '1px solid rgba(124,58,237,0.3)',
              color: '#c7c7e0',
            }}
          />
          <button
            onClick={fetchToc}
            disabled={loadingToc}
            className="p-2 rounded-lg transition-colors disabled:opacity-50"
            style={{ background: '#7c3aed', color: 'white', boxShadow: '0 0 8px rgba(124,58,237,0.4)' }}
            title="Tải danh sách chương"
          >
            {loadingToc ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          </button>
        </div>
      </div>

      {/* Novel title / status */}
      <div className="px-3 py-2" style={{ borderBottom: '1px solid rgba(124,58,237,0.2)' }}>
        {toc ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-0.5 flex items-center gap-1"
              style={{ color: '#a78bfa' }}>
              <BookOpen size={11} /> Đang đọc
            </p>
            <p className="text-sm font-medium truncate" style={{ color: '#e2e8f0' }} title={toc.novel_title}>
              {toc.novel_title}
            </p>
            <p className="text-xs" style={{ color: '#6d6d9a' }}>{toc.total_chapters} chương</p>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: '#f87171' }}>
            <AlertCircle size={14} />
            <span className="truncate">{error}</span>
          </div>
        ) : (
          <p className="text-xs italic" style={{ color: '#4a4a7a' }}>Nhập URL truyện để bắt đầu…</p>
        )}
      </div>

      {/* Chapter list */}
      <div className="flex-1 overflow-y-auto">
        {loadingToc && (
          <div className="flex items-center justify-center py-12" style={{ color: '#6d6d9a' }}>
            <Loader2 size={20} className="animate-spin mr-2" />
            <span className="text-sm">Đang tải…</span>
          </div>
        )}
        {toc && !loadingToc && (
          <ul className="py-1">
            {toc.chapters.map((ch: ChapterMeta, i: number) => {
              const isActive = currentChapterUrl === ch.url
              return (
                <li key={ch.url}>
                  <button
                    ref={isActive ? activeRef : undefined}
                    onClick={() => loadChapter(ch.url, ch.title)}
                    className="w-full text-left px-3 py-2.5 text-sm transition-colors flex items-start gap-2 group"
                    style={{
                      background: isActive ? 'rgba(124,58,237,0.15)' : 'transparent',
                      borderLeft: `2px solid ${isActive ? '#a78bfa' : 'transparent'}`,
                      color: isActive ? '#a78bfa' : '#8888b0',
                    }}
                  >
                    <span className="text-xs mt-0.5 w-7 flex-shrink-0 font-mono"
                      style={{ color: isActive ? '#7c3aed' : '#4a4a7a' }}>
                      {ch.number ?? i + 1}
                    </span>
                    <span className="truncate leading-snug flex-1">{ch.title}</span>
                    {isChapterFinished(ch.url) && (
                      <span className="flex-shrink-0 text-xs" style={{ color: '#00ffff' }} title="Đã nghe">✓</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
