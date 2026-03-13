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

  const handleGoogleAuth = async () => {
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    // Note: on success, the browser redirects — setLoading(false) below is
    // only reached on error (e.g. popup blocked, provider misconfigured).
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0d1117] p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        <button
          onClick={handleGoogleAuth}
          disabled={loading}
          className="mb-4 flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"/>
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
          </svg>
          Tiếp tục với Google
        </button>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/10" /></div>
          <div className="relative flex justify-center"><span className="bg-[#0d1117] px-3 text-xs text-gray-500">hoặc</span></div>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-white/5 p-1">
          {(['signin', 'signup'] as Tab[]).map((t) => (
            <button key={t} onClick={() => { setTab(t); setError(null); setSuccess(null) }}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-violet-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              {t === 'signin' ? 'Đăng nhập' : 'Đăng ký'}
            </button>
          ))}
        </div>

        <form onSubmit={handleEmailAuth} className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-violet-500" />
          <input type="password" placeholder="Mật khẩu" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-violet-500" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          {success && <p className="text-xs text-green-400">{success}</p>}
          <button type="submit" disabled={loading}
            className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
            {loading ? 'Đang xử lý...' : tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-500">
          Đăng nhập để đồng bộ vị trí đọc giữa các thiết bị
        </p>
      </div>
    </div>
  )
}
