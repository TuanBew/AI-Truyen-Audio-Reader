"use client";

import { BookOpen, Trash2, PlayCircle } from "lucide-react";
import type { SavedNovel } from "@/lib/types";

interface NovelCardProps {
  novel: SavedNovel;
  onOpen: (novel: SavedNovel) => void;
  onDelete: (id: string) => void;
}

/** Generate a stable gradient from novel ID */
function gradientFromId(id: string): string {
  const gradients = [
    "from-violet-900 via-purple-800 to-indigo-900",
    "from-rose-900 via-pink-800 to-purple-900",
    "from-cyan-900 via-teal-800 to-emerald-900",
    "from-amber-900 via-orange-800 to-red-900",
    "from-blue-900 via-indigo-800 to-violet-900",
    "from-emerald-900 via-green-800 to-teal-900",
    "from-fuchsia-900 via-purple-800 to-pink-900",
    "from-slate-800 via-gray-700 to-zinc-800",
  ];
  const idx = id.charCodeAt(0) % gradients.length;
  return gradients[idx];
}

export default function NovelCard({ novel, onOpen, onDelete }: NovelCardProps) {
  const gradient = gradientFromId(novel.id);
  const progress = novel.lastChapterUrl ? Math.min(
    ((novel.toc.chapters.findIndex(c => c.url === novel.lastChapterUrl) + 1) / novel.totalChapters) * 100,
    100
  ) : 0;

  return (
    <div
      className="group relative rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1 cursor-pointer"
      style={{
        background: '#12122a',
        border: '1px solid rgba(124,58,237,0.3)',
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 20px rgba(124,58,237,0.2)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
    >
      {/* Cover / gradient area */}
      <div
        className={`relative h-48 bg-gradient-to-br ${gradient} flex items-end p-4`}
        onClick={() => onOpen(novel)}
      >
        {/* Decorative pattern */}
        <div className="absolute inset-0 opacity-10"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='1' fill-rule='evenodd'%3E%3Ccircle cx='8' cy='8' r='1.5'/%3E%3Ccircle cx='28' cy='28' r='1.5'/%3E%3C/g%3E%3C/svg%3E\")" }}
        />

        {/* Overlay on hover */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-300 flex items-center justify-center">
          <PlayCircle
            size={56}
            className="text-white/0 group-hover:text-white/90 transition-all duration-300 drop-shadow-xl scale-75 group-hover:scale-100"
          />
        </div>

        {/* Chapter count badge */}
        <span className="relative z-10 text-xs font-medium bg-black/40 backdrop-blur-sm text-white/80 px-2 py-1 rounded-full flex items-center gap-1">
          <BookOpen size={11} />
          {novel.totalChapters} chương
        </span>
      </div>

      {/* Info */}
      <div className="p-4" onClick={() => onOpen(novel)}>
        <h3
          className="font-semibold text-sm leading-snug line-clamp-2 mb-1 transition-colors"
          style={{ color: '#e2e8f0' }}
        >
          {novel.title}
        </h3>

        {novel.lastChapterTitle ? (
          <p className="text-xs truncate mb-3" style={{ color: '#00ffff' }}>
            Đang đọc: {novel.lastChapterTitle}
          </p>
        ) : (
          <p className="text-xs mb-3" style={{ color: '#6d6d9a' }}>Chưa bắt đầu đọc</p>
        )}

        {/* Progress bar */}
        {novel.lastChapterUrl && (
          <div className="mb-3">
            <div className="flex justify-between text-xs mb-1" style={{ color: '#6d6d9a' }}>
              <span>Tiến độ</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(124,58,237,0.15)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${progress}%`, background: 'linear-gradient(to right, #7c3aed, #a78bfa)' }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Delete button (appears on hover) */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(novel.id); }}
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 transition-all duration-200 opacity-0 group-hover:opacity-100 backdrop-blur-sm"
        style={{ color: '#6d6d9a' }}
        onMouseEnter={e => (e.currentTarget.style.color = '#ff66ff')}
        onMouseLeave={e => (e.currentTarget.style.color = '#6d6d9a')}
        title="Xóa khỏi thư viện"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
