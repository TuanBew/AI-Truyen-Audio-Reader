'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Props {
  email: string
  syncStatus: string
}

const syncIcons: Record<string, string> = {
  idle: '○', syncing: '↻', synced: '✓', offline: '✗',
}

export default function UserMenu({ email, syncStatus }: Props) {
  const [open, setOpen] = useState(false)
  // Fallback to '?' for OAuth providers that don't return an email
  const initial = email.charAt(0).toUpperCase() || '?'

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm transition"
        style={{
          background: 'rgba(124,58,237,0.08)',
          border: '1px solid rgba(124,58,237,0.35)',
          color: '#a78bfa',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 10px rgba(124,58,237,0.3)'
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'
        }}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
          {initial}
        </span>
        <span
          className="text-xs"
          title={`Sync: ${syncStatus}`}
          style={{
            color: syncStatus === 'synced' ? '#00ffff' :
                   syncStatus === 'syncing' || syncStatus === 'offline' ? '#fbbf24' :
                   '#6d6d9a',
          }}
        >
          {syncIcons[syncStatus] ?? '○'}
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl p-1"
          style={{
            background: '#0e0e28',
            border: '1px solid rgba(124,58,237,0.3)',
            boxShadow: '0 0 20px rgba(0,0,0,0.5)',
          }}
        >
          <div className="px-3 py-2">
            <p className="truncate text-xs font-medium" style={{ color: '#a78bfa' }}>
              {email || 'Người dùng'}
            </p>
            <p
              className="mt-0.5 text-xs"
              style={{
                color: syncStatus === 'synced' ? '#00ffff' :
                       syncStatus === 'syncing' || syncStatus === 'offline' ? '#fbbf24' :
                       '#6d6d9a',
              }}
            >
              {syncStatus === 'synced' ? '☁ Đã đồng bộ' :
               syncStatus === 'syncing' ? '↻ Đang đồng bộ...' :
               syncStatus === 'offline' ? '✗ Không thể kết nối' : '○ Chưa đồng bộ'}
            </p>
          </div>
          <div className="mt-1 pt-1" style={{ borderTop: '1px solid rgba(124,58,237,0.2)' }}>
            <button
              onClick={() => { supabase.auth.signOut(); setOpen(false) }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm transition"
              style={{ color: '#a78bfa' }}
              onMouseEnter={e => {
                const btn = e.currentTarget as HTMLButtonElement
                btn.style.color = '#ff66ff'
                btn.style.textShadow = '0 0 8px rgba(255,102,255,0.5)'
                btn.style.background = 'rgba(255,102,255,0.08)'
              }}
              onMouseLeave={e => {
                const btn = e.currentTarget as HTMLButtonElement
                btn.style.color = '#a78bfa'
                btn.style.textShadow = 'none'
                btn.style.background = 'transparent'
              }}
            >
              Đăng xuất
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
