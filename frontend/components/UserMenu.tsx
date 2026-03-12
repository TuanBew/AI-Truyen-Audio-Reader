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
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/10">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
          {initial}
        </span>
        <span className="text-xs text-gray-400" title={`Sync: ${syncStatus}`}>
          {syncIcons[syncStatus] ?? '○'}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-white/10 bg-[#0d1117] p-1 shadow-2xl">
          <div className="px-3 py-2">
            <p className="truncate text-xs font-medium text-white">{email || 'Người dùng'}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {syncStatus === 'synced' ? '☁ Đã đồng bộ' :
               syncStatus === 'syncing' ? '↻ Đang đồng bộ...' :
               syncStatus === 'offline' ? '✗ Không thể kết nối' : '○ Chưa đồng bộ'}
            </p>
          </div>
          <div className="mt-1 border-t border-white/10 pt-1">
            <button onClick={() => { supabase.auth.signOut(); setOpen(false) }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition hover:bg-white/5 hover:text-white">
              Đăng xuất
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
