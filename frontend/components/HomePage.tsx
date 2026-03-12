"use client";

import { Plus, Headphones, BookOpen, Sparkles } from "lucide-react";
import { useAppStore } from "@/lib/store";
import NovelCard from "./NovelCard";
import type { SavedNovel } from "@/lib/types";

export default function HomePage() {
  const { savedNovels, removeNovel, openNovel, setView } = useAppStore();

  const handleOpen = (novel: SavedNovel) => openNovel(novel);
  const handleDelete = (id: string) => removeNovel(id);
  const handleAddNew = () => setView("reader");

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="border-b border-gray-800/60 bg-gray-950/80 backdrop-blur-xl sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <Headphones size={18} className="text-white" />
            </div>
            <div>
              <span className="font-bold text-white text-lg tracking-tight">AudioTruyen</span>
              <span className="ml-2 text-xs text-gray-500">Thư viện của bạn</span>
            </div>
          </div>

          <button
            onClick={handleAddNew}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-all duration-200 shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/40 hover:-translate-y-0.5 active:translate-y-0"
          >
            <Plus size={16} />
            Thêm truyện
          </button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-10">
        {savedNovels.length === 0 ? (
          /* ── Empty state ── */
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            {/* Floating orbs decoration */}
            <div className="relative mb-10">
              <div className="w-32 h-32 rounded-full bg-indigo-900/40 flex items-center justify-center border border-indigo-800/50 shadow-2xl shadow-indigo-500/10">
                <BookOpen size={48} className="text-indigo-400" />
              </div>
              <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-purple-600/60 blur-sm animate-pulse" />
              <div className="absolute -bottom-3 -left-3 w-6 h-6 rounded-full bg-indigo-500/50 blur-sm animate-pulse [animation-delay:0.5s]" />
            </div>

            <h2 className="text-2xl font-bold text-white mb-3">Thư viện trống</h2>
            <p className="text-gray-500 text-base max-w-sm mb-8 leading-relaxed">
              Thêm truyện đầu tiên của bạn để bắt đầu. Dán link từ truyenplus.vn và thưởng thức!
            </p>

            <button
              onClick={handleAddNew}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold text-base transition-all duration-200 shadow-xl shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:-translate-y-1 active:translate-y-0"
            >
              <Sparkles size={18} />
              Thêm truyện đầu tiên
            </button>
          </div>
        ) : (
          <>
            {/* ── Section header ── */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-white">Đang đọc</h2>
                <p className="text-sm text-gray-500 mt-0.5">{savedNovels.length} truyện trong thư viện</p>
              </div>
            </div>

            {/* ── Novel grid ── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {/* Add new card */}
              <button
                onClick={handleAddNew}
                className="group rounded-2xl border-2 border-dashed border-gray-700 hover:border-indigo-500/60 bg-gray-900/50 hover:bg-indigo-950/30 transition-all duration-300 flex flex-col items-center justify-center min-h-[280px] gap-3 hover:-translate-y-1"
              >
                <div className="w-12 h-12 rounded-2xl bg-gray-800 group-hover:bg-indigo-900/60 flex items-center justify-center transition-all duration-300 group-hover:scale-110">
                  <Plus size={24} className="text-gray-500 group-hover:text-indigo-400 transition-colors" />
                </div>
                <span className="text-sm text-gray-500 group-hover:text-indigo-400 font-medium transition-colors">
                  Thêm truyện
                </span>
              </button>

              {/* Novel cards */}
              {savedNovels.map((novel) => (
                <NovelCard
                  key={novel.id}
                  novel={novel}
                  onOpen={handleOpen}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="border-t border-gray-800/40 py-4 text-center">
        <p className="text-xs text-gray-700">AudioTruyen — Nghe truyện mọi lúc mọi nơi</p>
      </footer>
    </div>
  );
}
