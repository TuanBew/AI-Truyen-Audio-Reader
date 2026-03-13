'use client'

import { useState, useEffect } from 'react'
import { Settings, Headphones } from 'lucide-react'
import { useAuth } from '@/lib/hooks/useAuth'
import { useAppStore } from '@/lib/store'
import ChapterSidebar from './ChapterSidebar'
import ReaderPanel from './ReaderPanel'
import PlayerPanel from './PlayerPanel'
import SettingsPanel from './SettingsPanel'
import HomePage from './HomePage'
import AuthModal from './AuthModal'
import UserMenu from './UserMenu'
import ResizableDivider from './ResizableDivider'
import ResizableHDivider from './ResizableHDivider'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 440
const PLAYER_MIN = 90
const PLAYER_MAX = 340

export default function MainLayout() {
  const { view, setView, settingsPanelOpen, toggleSettingsPanel } = useAppStore()

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return 260
    const parsed = parseInt(localStorage.getItem('sidebar-width') ?? '', 10)
    return isNaN(parsed) ? 260 : parsed
  })

  const [playerHeight, setPlayerHeight] = useState(() => {
    if (typeof window === 'undefined') return 160
    const parsed = parseInt(localStorage.getItem('player-height') ?? '', 10)
    return isNaN(parsed) ? 160 : parsed
  })

  useEffect(() => { localStorage.setItem('sidebar-width', String(sidebarWidth)) }, [sidebarWidth])
  useEffect(() => { localStorage.setItem('player-height', String(playerHeight)) }, [playerHeight])

  useAuth()
  const authState = useAppStore((s) => s.authState)
  const [authModalOpen, setAuthModalOpen] = useState(false)

  if (view === 'home') return <HomePage />

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#0c0c1e' }}>
      {/* ── Chapter Sidebar ──────────────────────────────── */}
      <aside
        className="flex-shrink-0 flex flex-col overflow-hidden"
        style={{
          width: sidebarWidth,
          background: '#10102a',
          borderRight: '1px solid rgba(124,58,237,0.25)',
        }}
      >
        <ChapterSidebar />
      </aside>

      <ResizableDivider
        onResize={(dx) => setSidebarWidth((w) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w + dx)))}
      />

      {/* ── Main content area ─────────────────────────── */}
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Top bar */}
        <header
          className="h-12 flex items-center justify-between px-4 flex-shrink-0"
          style={{ background: '#0e0e28', borderBottom: '1px solid rgba(124,58,237,0.25)' }}
        >
          <button
            onClick={() => setView('home')}
            className="flex items-center gap-2 transition-colors group"
            style={{ color: '#a78bfa' }}
            title="Về trang chủ"
          >
            <Headphones size={20} />
            <span
              className="font-semibold text-sm tracking-wide group-hover:underline underline-offset-2"
              style={{ textShadow: '0 0 8px #7c3aed' }}
            >
              ◈ AudioTruyen
            </span>
          </button>

          <div className="flex items-center gap-2">
            {authState.supabaseUserId ? (
              <UserMenu email={authState.supabaseEmail ?? ''} syncStatus={authState.syncStatus} />
            ) : (
              <button
                onClick={() => setAuthModalOpen(true)}
                className="rounded-lg px-4 py-1.5 text-sm font-medium text-white transition"
                style={{ background: '#7c3aed', boxShadow: '0 0 12px rgba(124,58,237,0.4)' }}
              >
                Đăng nhập
              </button>
            )}
            <button
              onClick={toggleSettingsPanel}
              className="p-1.5 rounded transition-colors"
              style={{ color: '#a78bfa' }}
              title="Cài đặt"
            >
              <Settings size={18} />
            </button>
          </div>
        </header>

        {/* Reader + vertical resize + Player */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden">
            <ReaderPanel />
          </div>

          <ResizableHDivider
            onResize={(dy) =>
              setPlayerHeight((h) => Math.min(PLAYER_MAX, Math.max(PLAYER_MIN, h - dy)))
            }
          />

          <div className="flex-shrink-0 overflow-hidden" style={{ height: playerHeight }}>
            <PlayerPanel />
          </div>
        </div>
      </main>

      {/* ── Settings Drawer ─────────────────────────────── */}
      {settingsPanelOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={toggleSettingsPanel} />
          <div
            className="w-96 overflow-y-auto shadow-2xl"
            style={{ background: '#0e0e28', borderLeft: '1px solid rgba(124,58,237,0.3)' }}
          >
            <SettingsPanel />
          </div>
        </div>
      )}

      <AuthModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      {/* Neon bottom border — fixed so it spans the full viewport width regardless of flex layout */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: '1px',
          zIndex: 9999,
          pointerEvents: 'none',
          background: 'linear-gradient(90deg, transparent, rgba(0,255,255,0.2), rgba(124,58,237,0.3), rgba(0,255,255,0.2), transparent)',
        }}
      />
    </div>
  )
}
