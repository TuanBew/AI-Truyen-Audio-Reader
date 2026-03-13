'use client'

import { useState } from 'react'
import { Plus, Headphones, BookOpen, Zap, LogIn, LogOut } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { supabase } from '@/lib/supabase'
import NovelCard from './NovelCard'
import AuthModal from './AuthModal'
import type { SavedNovel } from '@/lib/types'

// Neon particle positions — deterministic to avoid hydration mismatch
const PARTICLES = [
  { top: '8%', left: '12%', size: 120, color: '#7c3aed', delay: '0s', dur: '6s' },
  { top: '15%', left: '75%', size: 80, color: '#00ffff', delay: '1s', dur: '8s' },
  { top: '55%', left: '5%', size: 60, color: '#ff66ff', delay: '2s', dur: '7s' },
  { top: '70%', left: '85%', size: 100, color: '#7c3aed', delay: '0.5s', dur: '9s' },
  { top: '85%', left: '40%', size: 50, color: '#00ffff', delay: '3s', dur: '6s' },
  { top: '30%', left: '90%', size: 70, color: '#ff66ff', delay: '1.5s', dur: '7.5s' },
  { top: '45%', left: '50%', size: 40, color: '#a78bfa', delay: '2.5s', dur: '8.5s' },
]

export default function HomePage() {
  const { savedNovels, removeNovel, openNovel, setView } = useAppStore()
  const authState = useAppStore((s) => s.authState)
  const [authModalOpen, setAuthModalOpen] = useState(false)

  const handleOpen = (novel: SavedNovel) => openNovel(novel)
  const handleDelete = (id: string) => removeNovel(id)
  const handleAddNew = () => setView('reader')

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden" style={{ background: '#0c0c1e' }}>
      {/* ── Animated neon background particles ────────── */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
        {PARTICLES.map((p, i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              top: p.top,
              left: p.left,
              width: p.size,
              height: p.size,
              background: p.color,
              opacity: 0,
              filter: 'blur(60px)',
              animation: `neon-float-slow ${p.dur} ${p.delay} ease-in-out infinite`,
            }}
          />
        ))}
      </div>

      {/* ── Header ─────────────────────────────────────── */}
      <header
        className="sticky top-0 z-10 backdrop-blur-xl"
        style={{ background: 'rgba(12,12,30,0.85)', borderBottom: '1px solid rgba(124,58,237,0.2)' }}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: '#7c3aed', boxShadow: '0 0 16px rgba(124,58,237,0.5)' }}
            >
              <Headphones size={18} className="text-white" />
            </div>
            <div>
              <span
                className="font-bold text-lg tracking-tight"
                style={{
                  color: '#a78bfa',
                  animation: 'neon-pulse-glow 3s ease-in-out infinite',
                }}
              >
                ◈ AudioTruyen
              </span>
              <span className="ml-2 text-xs" style={{ color: '#4a4a7a' }}>Thư viện của bạn</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {authState.supabaseUserId ? (
              <button
                onClick={() => supabase.auth.signOut()}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium transition-all"
                style={{
                  background: 'rgba(124,58,237,0.08)',
                  border: '1px solid rgba(124,58,237,0.35)',
                  color: '#a78bfa',
                }}
                title={`Đăng xuất (${authState.supabaseEmail})`}
              >
                <LogOut size={14} />
                <span className="hidden sm:inline truncate max-w-[120px]">{authState.supabaseEmail}</span>
              </button>
            ) : (
              <button
                onClick={() => setAuthModalOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium text-white transition-all hover:-translate-y-0.5"
                style={{ background: 'rgba(124,58,237,0.6)', border: '1px solid rgba(124,58,237,0.4)' }}
              >
                <LogIn size={14} />
                Đăng nhập
              </button>
            )}
            <button
              onClick={handleAddNew}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium transition-all hover:-translate-y-0.5 active:translate-y-0"
              style={{ background: '#7c3aed', boxShadow: '0 0 16px rgba(124,58,237,0.4)' }}
            >
              <Plus size={16} />
              Thêm truyện
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────── */}
      <main className="relative z-10 flex-1 max-w-7xl mx-auto w-full px-6 py-10">
        {savedNovels.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <div className="relative mb-10">
              <div
                className="w-32 h-32 rounded-full flex items-center justify-center"
                style={{
                  background: 'rgba(124,58,237,0.1)',
                  border: '1px solid rgba(124,58,237,0.3)',
                  boxShadow: '0 0 40px rgba(124,58,237,0.2), inset 0 0 40px rgba(124,58,237,0.05)',
                }}
              >
                <BookOpen size={48} style={{ color: '#a78bfa' }} />
              </div>
              <div
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full"
                style={{ background: '#00ffff', filter: 'blur(4px)', animation: 'neon-float 3s ease-in-out infinite' }}
              />
              <div
                className="absolute -bottom-2 -left-2 w-3 h-3 rounded-full"
                style={{ background: '#ff66ff', filter: 'blur(3px)', animation: 'neon-float 4s 1s ease-in-out infinite' }}
              />
            </div>

            <h2 className="text-2xl font-bold mb-3" style={{ color: '#e2e8f0' }}>Thư viện trống</h2>
            <p className="text-base max-w-sm mb-8 leading-relaxed" style={{ color: '#6d6d9a' }}>
              Thêm truyện đầu tiên. Dán link từ{' '}
              <span style={{ color: '#00ffff' }}>truyenplus.vn</span>{' '}
              và thưởng thức!
            </p>

            <button
              onClick={handleAddNew}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl text-white font-semibold text-base transition-all hover:-translate-y-1 active:translate-y-0"
              style={{
                background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                boxShadow: '0 0 30px rgba(124,58,237,0.4)',
              }}
            >
              <Zap size={18} />
              Thêm truyện đầu tiên
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold" style={{ color: '#e2e8f0' }}>Đang đọc</h2>
                <p className="text-sm mt-0.5" style={{ color: '#4a4a7a' }}>{savedNovels.length} truyện</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {/* Add new card */}
              <button
                onClick={handleAddNew}
                className="group rounded-2xl flex flex-col items-center justify-center min-h-[280px] gap-3 transition-all hover:-translate-y-1"
                style={{
                  border: '2px dashed rgba(124,58,237,0.3)',
                  background: 'rgba(124,58,237,0.03)',
                }}
              >
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center transition-all group-hover:scale-110"
                  style={{ background: 'rgba(124,58,237,0.15)' }}
                >
                  <Plus size={24} style={{ color: '#a78bfa' }} />
                </div>
                <span className="text-sm font-medium" style={{ color: '#6d6d9a' }}>Thêm truyện</span>
              </button>

              {savedNovels.map((novel) => (
                <NovelCard key={novel.id} novel={novel} onOpen={handleOpen} onDelete={handleDelete} />
              ))}
            </div>
          </>
        )}
      </main>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="relative z-10 py-4 text-center" style={{ borderTop: '1px solid rgba(124,58,237,0.1)' }}>
        <p className="text-xs" style={{ color: '#2a2a4a' }}>◈ AudioTruyen — Nghe truyện mọi lúc mọi nơi</p>
      </footer>

      <AuthModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} />
    </div>
  )
}
