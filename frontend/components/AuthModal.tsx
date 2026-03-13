'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

interface Props {
  isOpen: boolean
  onClose: () => void
}

type Tab = 'signin' | 'signup'

export default function AuthModal({ isOpen, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Reset form state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setEmail('')
      setPassword('')
      setError(null)
      setSuccess(null)
      setTab('signin')
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      if (tab === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onClose()
      } else {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setSuccess('Kiểm tra email để xác nhận tài khoản!')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Đã xảy ra lỗi')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-violet-800/40 bg-[#0d0d24] p-6 shadow-2xl" style={{ boxShadow: '0 0 40px rgba(124,58,237,0.2)' }}>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: '#a78bfa' }}>
            {tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </h2>
          <button onClick={onClose} className="transition-colors" style={{ color: '#6d6d9a' }}>✕</button>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg p-1" style={{ background: 'rgba(124,58,237,0.1)' }}>
          {(['signin', 'signup'] as Tab[]).map((t) => (
            <button key={t} onClick={() => { setTab(t); setError(null); setSuccess(null) }}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-violet-600 text-white' : 'text-violet-400 hover:text-white'}`}>
              {t === 'signin' ? 'Đăng nhập' : 'Đăng ký'}
            </button>
          ))}
        </div>

        <form onSubmit={handleEmailAuth} className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full rounded-xl border border-violet-800/40 bg-violet-950/20 px-4 py-2.5 text-sm text-violet-100 placeholder-violet-700 outline-none focus:border-violet-500" />
          <input type="password" placeholder="Mật khẩu" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
            className="w-full rounded-xl border border-violet-800/40 bg-violet-950/20 px-4 py-2.5 text-sm text-violet-100 placeholder-violet-700 outline-none focus:border-violet-500" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          {success && <p className="text-xs text-cyan-400">{success}</p>}
          <button type="submit" disabled={loading}
            className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50" style={{ boxShadow: '0 0 16px rgba(124,58,237,0.3)' }}>
            {loading ? 'Đang xử lý...' : tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs" style={{ color: '#4a4a7a' }}>
          Đăng nhập để đồng bộ vị trí đọc giữa các thiết bị
        </p>
      </div>
    </div>
  )
}
