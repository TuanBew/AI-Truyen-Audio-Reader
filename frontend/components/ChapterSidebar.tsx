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
          onClick={() => setView("home")}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-400 transition-colors group"
        >
          <ChevronLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
          Thư viện
        </button>
      </div>

      {/* URL Input */}
      <div className="p-3 border-b border-gray-800">
        <div className="flex gap-2">
          <input
            type="url"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchToc()}
            placeholder="https://truyenplus.vn/truyen/..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            onClick={fetchToc}
            disabled={loadingToc}
            className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white"
            title="Tải danh sách chương"
          >
            {loadingToc ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          </button>
        </div>
      </div>

      {/* Novel title / status */}
      <div className="px-3 py-2 border-b border-gray-800">
        {toc ? (
          <div>
            <p className="text-xs text-indigo-400 font-semibold uppercase tracking-wider mb-0.5">
              <BookOpen size={12} className="inline mr-1" />
              Đang đọc
            </p>
            <p className="text-sm font-medium text-white truncate" title={toc.novel_title}>
              {toc.novel_title}
            </p>
            <p className="text-xs text-gray-500">{toc.total_chapters} chương</p>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-red-400 text-xs">
            <AlertCircle size={14} />
            <span className="truncate">{error}</span>
          </div>
        ) : (
          <p className="text-xs text-gray-500 italic">Nhập URL truyện để bắt đầu…</p>
        )}
      </div>

      {/* Chapter list */}
      <div className="flex-1 overflow-y-auto">
        {loadingToc && (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 size={24} className="animate-spin mr-2" />
            <span className="text-sm">Đang tải danh sách chương…</span>
          </div>
        )}
        {toc && !loadingToc && (
          <ul className="py-1">
            {toc.chapters.map((ch: ChapterMeta, i: number) => {
              const isActive = currentChapterUrl === ch.url;
              return (
                <li key={ch.url}>
                  <button
                    ref={isActive ? activeRef : undefined}
                    onClick={() => loadChapter(ch.url, ch.title)}
                    className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-start gap-2 group ${
                      isActive
                        ? "bg-indigo-600/20 text-indigo-300 border-l-2 border-indigo-500"
                        : "text-gray-300 hover:bg-gray-800 hover:text-white border-l-2 border-transparent"
                    }`}
                  >
                    <span className="text-xs text-gray-600 mt-0.5 w-7 flex-shrink-0 font-mono group-hover:text-gray-400">
                      {ch.number ?? i + 1}
                    </span>
                    <span className="truncate leading-snug flex-1">{ch.title}</span>
                    {isChapterFinished(ch.url) && (
                      <span className="text-green-400 flex-shrink-0" title="Đã nghe">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
