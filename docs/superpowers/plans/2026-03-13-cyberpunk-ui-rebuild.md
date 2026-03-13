# Cyberpunk Neon UI Rebuild + Edge TTS Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild AudioTruyen's entire UI in a Cyberpunk Neon aesthetic, add Edge TTS (free, no API key), make the player panel vertically resizable, remove Google login, and add a truyenplus.vn-only notice.

**Architecture:** Full rewrite of every component—keeping all business logic intact, replacing only markup/styles—plus extracting the player into a standalone `PlayerPanel.tsx` so `MainLayout` can control its height via a vertical drag handle. The backend gains an `edge` TTS provider using the `edge-tts` Python library.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Tailwind v4 / Zustand (frontend); FastAPI / Python 3.11 / `edge-tts` (backend); Canvas API for AudioVisualizer.

---

## Chunk 1: Backend — Edge TTS

### Task 1: Install edge-tts and create the service

**Files:**
- Create: `backend/services/tts_edge.py`
- Modify: `backend/requirements.txt`

- [ ] **Step 1: Add dependency**

Open `backend/requirements.txt` and add on its own line:
```
edge-tts>=6.1.9
```

- [ ] **Step 2: Install**

```bash
cd backend && .venv/Scripts/activate && pip install edge-tts
```
Expected: `Successfully installed edge-tts-x.x.x`

- [ ] **Step 3: Create `backend/services/tts_edge.py`**

```python
"""Edge TTS service — uses Microsoft Edge's free TTS API via edge-tts library.
Voice: vi-VN-NamMinhNeural (Vietnamese male, no API key required, no char limit).

Important: _run_provider_chain() in the router is a synchronous function called from
async FastAPI routes. Calling asyncio.run() directly from such code raises
RuntimeError ("This event loop is already running"). We work around this by
running the async coroutine in a fresh ThreadPoolExecutor thread, which gets its
own clean event loop. This is the standard pattern for calling async libs from
sync code that runs inside an existing asyncio event loop.
"""
import asyncio
import concurrent.futures
import io
import logging

import edge_tts

logger = logging.getLogger(__name__)

EDGE_VOICE = "vi-VN-NamMinhNeural"


class EdgeTTSError(Exception):
    """Raised when Edge TTS synthesis fails."""


async def _synthesize_async(text: str, rate: str, volume: str) -> bytes:
    """Coroutine that streams Edge TTS audio into memory and returns bytes."""
    communicate = edge_tts.Communicate(text, EDGE_VOICE, rate=rate, volume=volume)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    audio = buf.getvalue()
    if not audio:
        raise EdgeTTSError("Edge TTS returned empty audio")
    return audio


def _run_coro_in_thread(coro) -> bytes:
    """Run an async coroutine in a fresh thread with its own event loop.
    Safe to call from within a running asyncio event loop (e.g. FastAPI handlers).
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(asyncio.run, coro)
        return future.result()


def synthesize(text: str, speed: float = 1.0) -> bytes:
    """Synthesize Vietnamese text via Edge TTS. Returns raw MP3 bytes.

    Args:
        text: Text to synthesize (no practical length limit).
        speed: Playback speed 0.5–2.0. Converted to Edge TTS rate string (+/-%).
    Returns:
        MP3 bytes.
    Raises:
        EdgeTTSError: On synthesis failure.
    """
    rate_pct = int((speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    try:
        return _run_coro_in_thread(_synthesize_async(text, rate=rate_str, volume="+0%"))
    except EdgeTTSError:
        raise
    except edge_tts.exceptions.NoAudioReceived as e:
        raise EdgeTTSError(f"No audio received from Edge TTS: {e}") from e
    except Exception as e:
        raise EdgeTTSError(f"Edge TTS synthesis failed: {e}") from e
```

- [ ] **Step 4: Verify import works**

```bash
cd backend && python -c "from services.tts_edge import synthesize; print('OK')"
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add backend/services/tts_edge.py backend/requirements.txt
git commit -m "feat(tts): add Edge TTS service (vi-VN-NamMinhNeural, free, no char limit)"
```

---

### Task 2: Wire Edge TTS into the router

**Files:**
- Modify: `backend/routers/tts.py`

- [ ] **Step 1: Add import and enum value**

In `backend/routers/tts.py`, find the import line:
```python
from services import tts_gemini, tts_openai, tts_minimax, tts_gtranslate
```
Replace with:
```python
from services import tts_gemini, tts_openai, tts_minimax, tts_gtranslate
from services.tts_edge import synthesize as edge_synthesize, EdgeTTSError
```

- [ ] **Step 2: Add `edge` to `TTSProvider` enum**

Find:
```python
class TTSProvider(str, Enum):
    gemini = "gemini"
    openai = "openai"
    minimax = "minimax"
    xtts = "xtts"
    gtranslate = "gtranslate"
```
Replace with:
```python
class TTSProvider(str, Enum):
    gemini = "gemini"
    openai = "openai"
    minimax = "minimax"
    xtts = "xtts"
    edge = "edge"
    gtranslate = "gtranslate"
```

- [ ] **Step 3: Add `edge` to `all_providers` list**

Find:
```python
    all_providers = [
        TTSProvider.gemini,
        TTSProvider.openai,
        TTSProvider.minimax,
        TTSProvider.xtts,
        TTSProvider.gtranslate,
    ]
```
Replace with:
```python
    all_providers = [
        TTSProvider.gemini,
        TTSProvider.openai,
        TTSProvider.minimax,
        TTSProvider.xtts,
        TTSProvider.edge,
        TTSProvider.gtranslate,
    ]
```

- [ ] **Step 4: Add Edge branch inside the `for` loop**

Find the `elif provider == TTSProvider.gtranslate:` block:
```python
            elif provider == TTSProvider.gtranslate:
                audio_bytes = tts_gtranslate.synthesize_long(
                    text=body.text,
                    lang=body.gemini_language[:2],
                )
```
Add the Edge branch **before** it:
```python
            elif provider == TTSProvider.edge:
                audio_bytes = edge_synthesize(
                    text=body.text,
                    speed=body.speed,
                )

            elif provider == TTSProvider.gtranslate:
                audio_bytes = tts_gtranslate.synthesize_long(
                    text=body.text,
                    lang=body.gemini_language[:2],
                )
```

- [ ] **Step 5: Register `EdgeTTSError` in the error-handling `except` block**

Find the second except clause:
```python
        except (
            tts_gemini.GeminiTTSError,
            tts_openai.OpenAITTSError,
            tts_minimax.MiniMaxTTSError,
            tts_gtranslate.GTTranslateTTSError,
            XTTSTTSError,
        ) as e:
```
Replace with:
```python
        except (
            tts_gemini.GeminiTTSError,
            tts_openai.OpenAITTSError,
            tts_minimax.MiniMaxTTSError,
            tts_gtranslate.GTTranslateTTSError,
            XTTSTTSError,
            EdgeTTSError,
        ) as e:
```

- [ ] **Step 6: Smoke-test via dev server**

Start backend: `uvicorn main:app --reload --port 8000`

Send a test request:
```bash
curl -s -X POST http://localhost:8000/api/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"Xin chào","preferred_provider":"edge"}' \
  --output /tmp/test_edge.mp3 -w "%{http_code}"
```
Expected: `200` and `/tmp/test_edge.mp3` is a valid MP3 file (~2–5 KB).

- [ ] **Step 7: Commit**

```bash
git add backend/routers/tts.py
git commit -m "feat(tts): wire Edge TTS into provider chain as 5th option"
```

---

## Chunk 2: Frontend quick fixes

### Task 3: Remove Google login from AuthModal

**Files:**
- Modify: `frontend/components/AuthModal.tsx`

- [ ] **Step 1: Remove `handleGoogleAuth` function and the Google button**

Open `frontend/components/AuthModal.tsx`. Delete the following three blocks (search by content, not line numbers):

**Delete the `handleGoogleAuth` function** — find and remove:
```typescript
  const handleGoogleAuth = async () => {
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }
```

**Delete the Google button JSX** — find and remove:
```tsx
        <button
          onClick={handleGoogleAuth}
          disabled={loading}
          className="mb-4 flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            ...
          </svg>
          Tiếp tục với Google
        </button>
```
(The entire button including the SVG inside it.)

**Delete the divider** — find and remove:
```tsx
        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/10" /></div>
          <div className="relative flex justify-center"><span className="bg-[#0d1117] px-3 text-xs text-gray-500">hoặc</span></div>
        </div>
```

The modal body should start directly with the tab switcher after the header.

The final `return` block inside the `if (!isOpen) return null` should look like:

```tsx
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-violet-800/40 bg-[#0d0d24] p-6 shadow-2xl shadow-violet-900/30">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-violet-100">
            {tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </h2>
          <button onClick={onClose} className="text-violet-400 hover:text-white transition-colors">✕</button>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-violet-950/50 p-1">
          {(['signin', 'signup'] as Tab[]).map((t) => (
            <button key={t} onClick={() => { setTab(t); setError(null); setSuccess(null) }}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-violet-600 text-white shadow shadow-violet-500/30' : 'text-violet-400 hover:text-white'}`}>
              {t === 'signin' ? 'Đăng nhập' : 'Đăng ký'}
            </button>
          ))}
        </div>

        <form onSubmit={handleEmailAuth} className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full rounded-xl border border-violet-800/40 bg-violet-950/30 px-4 py-2.5 text-sm text-violet-100 placeholder-violet-600 outline-none focus:border-violet-500 focus:shadow focus:shadow-violet-500/20" />
          <input type="password" placeholder="Mật khẩu" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
            className="w-full rounded-xl border border-violet-800/40 bg-violet-950/30 px-4 py-2.5 text-sm text-violet-100 placeholder-violet-600 outline-none focus:border-violet-500 focus:shadow focus:shadow-violet-500/20" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          {success && <p className="text-xs text-cyan-400">{success}</p>}
          <button type="submit" disabled={loading}
            className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 shadow shadow-violet-500/30 disabled:opacity-50">
            {loading ? 'Đang xử lý...' : tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-violet-600">
          Đăng nhập để đồng bộ vị trí đọc giữa các thiết bị
        </p>
      </div>
    </div>
  )
```

Also remove the unused `handleGoogleAuth` — the `supabase` import can stay since email auth still uses it.

- [ ] **Step 2: Commit**

```bash
git add frontend/components/AuthModal.tsx
git commit -m "feat(auth): remove Google login, restyle modal in cyberpunk neon"
```

---

### Task 4: Add truyenplus.vn banner to ChapterSidebar

**Files:**
- Modify: `frontend/components/ChapterSidebar.tsx`

- [ ] **Step 1: Add the persistent info banner**

In `ChapterSidebar.tsx`, find the URL input block (starts with `{/* URL Input */}`). Add a banner **before** the URL input div:

```tsx
      {/* truyenplus.vn-only notice */}
      <div className="mx-3 mb-2 rounded-lg border border-cyan-800/40 bg-cyan-950/20 px-3 py-2 flex items-start gap-2">
        <span className="text-cyan-400 text-xs mt-0.5 flex-shrink-0">ℹ</span>
        <p className="text-xs text-cyan-300/70 leading-relaxed">
          Chỉ hỗ trợ URL từ{' '}
          <span className="text-cyan-400 font-medium">truyenplus.vn</span>
        </p>
      </div>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/ChapterSidebar.tsx
git commit -m "feat(ui): add persistent truyenplus.vn-only info banner in sidebar"
```

---

### Task 5: Add "edge" to frontend TTSProvider type and ttsSettings

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/lib/store.ts`

- [ ] **Step 1: Add `edge` to the union type**

In `frontend/lib/types.ts`, find:
```typescript
export type TTSProvider = "gemini" | "openai" | "minimax" | "xtts" | "gtranslate";
```
Replace with:
```typescript
export type TTSProvider = "gemini" | "openai" | "minimax" | "xtts" | "edge" | "gtranslate";
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npm run build 2>&1 | tail -5
```
Expected: no type errors related to TTSProvider.

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/types.ts
git commit -m "feat(types): add 'edge' to TTSProvider union type"
```

---

## Chunk 3: New Pixel/Retro Cyberpunk AudioVisualizer

### Task 6: Rewrite AudioVisualizer with pixel neon style

**Files:**
- Modify: `frontend/components/AudioVisualizer.tsx`

Keep the same props interface `{ audioElement, isPlaying }` and all WebAudio API wiring. Only the `draw()` render function changes.

- [ ] **Step 1: Rewrite the component**

Replace the entire file with:

```tsx
'use client'

import { useEffect, useRef } from 'react'

interface Props {
  audioElement: HTMLAudioElement | null
  isPlaying: boolean
}

const BAR_COUNT = 28
const FFT_SIZE = 64       // 32 frequency bins
const BIN_START = 2       // skip DC + sub-bass

// Neon color cycle per bar: violet → cyan → pink → repeat
const NEON_COLORS = ['#a78bfa', '#00ffff', '#ff66ff']
const IDLE_COLOR = 'rgba(124, 58, 237, 0.2)'

export default function AudioVisualizer({ audioElement, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const connectedElementRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!audioElement || !canvasRef.current) return

    if (!contextRef.current) {
      contextRef.current = new AudioContext()
    }
    const ctx = contextRef.current

    if (sourceRef.current && connectedElementRef.current !== audioElement) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }

    if (!sourceRef.current) {
      try {
        sourceRef.current = ctx.createMediaElementSource(audioElement)
        connectedElementRef.current = audioElement
        analyserRef.current = ctx.createAnalyser()
        analyserRef.current.fftSize = FFT_SIZE
        analyserRef.current.smoothingTimeConstant = 0.75
        sourceRef.current.connect(analyserRef.current)
        analyserRef.current.connect(ctx.destination)
      } catch (e) {
        console.warn('AudioVisualizer: could not connect audio element', e)
      }
    }

    const analyser = analyserRef.current
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const canvas = canvasRef.current
    const canvasCtx = canvas.getContext('2d')!
    const W = canvas.width
    const H = canvas.height
    const gap = 2
    const barW = Math.floor(W / BAR_COUNT) - gap

    const draw = () => {
      analyser.getByteFrequencyData(dataArray)
      const avg = dataArray.slice(BIN_START, BIN_START + BAR_COUNT).reduce((s, v) => s + v, 0) / (BAR_COUNT * 255)

      canvasCtx.clearRect(0, 0, W, H)

      if (!isPlaying || avg < 0.01) {
        // Idle: 2-pixel flatline dots with idle color
        let x = 0
        for (let i = 0; i < BAR_COUNT; i++) {
          canvasCtx.fillStyle = IDLE_COLOR
          canvasCtx.fillRect(x, H - 2, barW, 2)
          x += barW + gap
        }
        animFrameRef.current = requestAnimationFrame(draw)
        return
      }

      // Active: pixel-art bars with neon glow
      let x = 0
      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = BIN_START + i
        const value = dataArray[binIndex] / 255
        const barHeight = Math.max(2, Math.round(value * (H - 4) / 2) * 2) // quantize to even pixels
        const y = H - barHeight
        const color = NEON_COLORS[i % NEON_COLORS.length]

        // Glow
        canvasCtx.shadowBlur = value > 0.5 ? 8 : 4
        canvasCtx.shadowColor = color

        // Pixel bar (no rounding — crisp pixel look)
        canvasCtx.fillStyle = color
        canvasCtx.fillRect(x, y, barW, barHeight)

        // Bright cap pixel on top
        canvasCtx.fillStyle = '#ffffff'
        canvasCtx.globalAlpha = 0.6
        canvasCtx.fillRect(x, y, barW, 2)
        canvasCtx.globalAlpha = 1

        canvasCtx.shadowBlur = 0
        x += barW + gap
      }

      animFrameRef.current = requestAnimationFrame(draw)
    }

    if (ctx.state === 'suspended') ctx.resume()
    draw()

    return () => cancelAnimationFrame(animFrameRef.current)
  }, [audioElement, isPlaying])

  return (
    <canvas
      ref={canvasRef}
      width={BAR_COUNT * 11}
      height={40}
      className="w-full"
      style={{ imageRendering: 'pixelated' }}
      aria-hidden="true"
    />
  )
}
```

- [ ] **Step 2: Dev-test visually**

Start frontend (`npm run dev`), open a chapter, play audio — bars should show neon violet/cyan/pink with crisp pixel edges and glow. Idle state: dim flatline.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/AudioVisualizer.tsx
git commit -m "feat(ui): retro pixel neon AudioVisualizer with glow and crisp bars"
```

---

## Chunk 4: Layout Restructure — Vertical Resize + PlayerPanel

### Task 7: Create ResizableHDivider (vertical/row resize handle)

**Files:**
- Create: `frontend/components/ResizableHDivider.tsx`

Note: The existing `ResizableDivider.tsx` handles col-resize (horizontal drag to change width). This new component handles row-resize (vertical drag to change height).

- [ ] **Step 1: Create the component**

```tsx
'use client'

import { useCallback } from 'react'

interface Props {
  onResize: (dy: number) => void
}

export default function ResizableHDivider({ onResize }: Props) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => onResize(ev.movementY)
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onResize])

  return (
    <div
      onMouseDown={handleMouseDown}
      className="h-1 flex-shrink-0 cursor-row-resize bg-violet-900/40 hover:bg-violet-500 active:bg-violet-400 transition-colors select-none"
      title="Kéo để thay đổi kích thước"
    />
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/ResizableHDivider.tsx
git commit -m "feat(ui): add ResizableHDivider for vertical panel resize"
```

---

### Task 8: Create PlayerPanel.tsx (extract player from ReaderPanel)

**Files:**
- Create: `frontend/components/PlayerPanel.tsx`

This component owns TTSPlayer + RecordingControls, reads `currentChapter` from store, and handles auto-advance. After this task, `ReaderPanel` will no longer render TTSPlayer.

- [ ] **Step 1: Create the component**

```tsx
'use client'

import { useCallback } from 'react'
import { useAppStore } from '@/lib/store'
import { toast } from 'react-toastify'
import TTSPlayer from './TTSPlayer'
import RecordingControls from './RecordingControls'

export default function PlayerPanel() {
  const {
    currentChapter,
    setCurrentChapterUrl,
    setCurrentChapter,
    setLoadingChapter,
    activeNovelId,
    updateNovelProgress,
    playerState,
  } = useAppStore()

  const { autoAdvance } = playerState

  const navigateTo = useCallback(
    async (url: string | null | undefined) => {
      if (!url) return
      setCurrentChapterUrl(url)
      setLoadingChapter(true)
      try {
        const res = await fetch(`/api/scrape/chapter?url=${encodeURIComponent(url)}`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.detail || `HTTP ${res.status}`)
        }
        const data = await res.json()
        setCurrentChapter(data)
        if (activeNovelId) {
          updateNovelProgress(activeNovelId, url, data.chapter_title ?? '')
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Lỗi không xác định'
        toast.error(`Không tải được chương: ${msg}`)
        setCurrentChapterUrl(null)
      } finally {
        setLoadingChapter(false)
      }
    },
    [setCurrentChapterUrl, setLoadingChapter, setCurrentChapter, activeNovelId, updateNovelProgress]
  )

  if (!currentChapter) return null

  return (
    <div className="flex flex-col h-full bg-[#0d0d24] border-t border-violet-900/40 overflow-hidden">
      <TTSPlayer
        text={currentChapter.content}
        chapterTitle={currentChapter.chapter_title}
        chapterUrl={currentChapter.source_url}
        onEnded={() => {
          if (autoAdvance && currentChapter.next_url) {
            setTimeout(() => navigateTo(currentChapter.next_url!), 800)
          }
        }}
      />
      <RecordingControls
        text={currentChapter.content}
        chapterTitle={currentChapter.chapter_title}
      />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/PlayerPanel.tsx
git commit -m "feat(ui): extract PlayerPanel from ReaderPanel for vertical resize support"
```

---

### Task 9: Update MainLayout with vertical resize and cyberpunk neon

**Files:**
- Modify: `frontend/components/MainLayout.tsx`

This task: (a) adds `playerHeight` state with localStorage persistence, (b) renders `PlayerPanel` as a sibling below `ReaderPanel` with `ResizableHDivider` between them, (c) applies cyberpunk neon styling to the shell.

- [ ] **Step 1: Rewrite MainLayout**

Replace the entire file with:

```tsx
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
    </div>
  )
}
```

- [ ] **Step 2: Update ReaderPanel to remove TTSPlayer/RecordingControls**

In `frontend/components/ReaderPanel.tsx`:

Remove these imports:
```tsx
import TTSPlayer from "./TTSPlayer";
import RecordingControls from "./RecordingControls";
```

Remove the `autoAdvance` destructure from `playerState` (it's no longer used here).

Keep the `navigateTo` callback — it is still needed for Prev/Next chapter navigation in this component. (Auto-advance `onEnded` is handled separately in `PlayerPanel`.)

Remove the player `<div>` block (lines 221–236):
```tsx
      {/* TTS Player + Recording Controls */}
      <div className="flex-shrink-0 border-b border-gray-800 bg-gray-900">
        <TTSPlayer ... />
        <RecordingControls ... />
      </div>
```

Remove `autoAdvance` from the `onEnded` callback (it no longer exists here).

The complete `ReaderPanel` return (all sentence-rendering and word-level logic preserved verbatim; only container/nav colors updated):

```tsx
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: '#0c0c1e' }}>
      {/* Chapter header */}
      <div
        className="px-6 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(124,58,237,0.2)' }}
      >
        <p className="text-xs mb-1" style={{ color: '#6d6d9a' }}>{currentChapter.novel_title}</p>
        <h1 className="text-xl font-bold leading-snug" style={{ color: '#e2e8f0' }}>
          {currentChapter.chapter_title}
        </h1>
      </div>

      {/* Chapter text — sentence-level when TTS loaded, word-level fallback */}
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto px-8 py-6 w-full"
      >
        <div className="mx-auto max-w-[72ch] text-[1.25rem] leading-[1.85] font-sans tracking-wide"
          style={{ color: '#c7c7e0' }}>
          {sentenceSegments.length > 0 ? (
            sentenceSegments.map((seg) => (
              <Fragment key={seg.index}>
                {seg.paraBreak && seg.index > 0 && <div className="mt-[1em]" />}
                <span
                  id={`sent-${seg.index}`}
                  className={
                    seg.index === activeSentenceIdx
                      ? 'rounded px-0.5 transition-colors duration-200'
                      : 'transition-colors duration-200'
                  }
                  style={seg.index === activeSentenceIdx
                    ? { background: 'rgba(167,139,250,0.15)', color: '#e2e8f0' }
                    : undefined}
                >
                  {seg.text}{' '}
                </span>
              </Fragment>
            ))
          ) : (
            <p>
              {wordTokens.map((token) => {
                const isCurrent = token.globalIndex === highlightedWordIndex;
                return (
                  <span key={token.globalIndex}>
                    {token.paraBreakBefore && <br className="mb-3 block" />}
                    <span
                      ref={isCurrent ? highlightedRef : undefined}
                      className="transition-colors duration-100"
                      style={isCurrent
                        ? { color: '#fbbf24', textDecoration: 'underline', textDecorationColor: 'rgba(251,191,36,0.5)' }
                        : undefined}
                    >
                      {token.word}
                    </span>{' '}
                  </span>
                );
              })}
            </p>
          )}
        </div>
      </div>

      {/* Prev / Next navigation */}
      <div
        className="flex-shrink-0 px-6 py-3 flex justify-between items-center"
        style={{ borderTop: '1px solid rgba(124,58,237,0.2)', background: '#0e0e28' }}
      >
        <button
          onClick={() => navigateTo(currentChapter.prev_url)}
          disabled={!currentChapter.prev_url}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: '#1a1a3e', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
        >
          <ChevronLeft size={16} /> Chương trước
        </button>
        <span className="text-xs" style={{ color: '#4a4a7a' }}>
          {currentChapter.chapter_number ? `Chương ${currentChapter.chapter_number}` : ''}
        </span>
        <button
          onClick={() => navigateTo(currentChapter.next_url)}
          disabled={!currentChapter.next_url}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: '#1a1a3e', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
        >
          Chương sau <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
```

Important: Keep the `navigateTo` callback in `ReaderPanel` for Prev/Next navigation (it's separate from the auto-advance in `PlayerPanel`). Keep all existing hooks and logic (`splitToWords`, `buildSentenceSegments`, `contentRef`, `highlightedRef`, auto-scroll `useEffect`, auto-resume `useEffect`) completely unchanged.

- [ ] **Step 3: Dev-test layout**

`npm run dev` → open a chapter → verify:
- Sidebar resizes horizontally
- Player panel resizes vertically by dragging the divider line
- Player height persists across page refresh
- Reader shows chapter text in neon style

- [ ] **Step 4: Commit**

```bash
git add frontend/components/MainLayout.tsx frontend/components/ReaderPanel.tsx
git commit -m "feat(layout): vertical player resize + cyberpunk neon MainLayout"
```

---

## Chunk 5: Cyberpunk Neon Component Rebuilds

### Task 10: Rebuild ChapterSidebar in cyberpunk neon

**Files:**
- Modify: `frontend/components/ChapterSidebar.tsx`

Keep all fetch/state logic. Replace only JSX markup and Tailwind classes.

- [ ] **Step 1: Replace the JSX return**

The `return` block should be:

```tsx
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/ChapterSidebar.tsx
git commit -m "feat(ui): cyberpunk neon ChapterSidebar with truyenplus banner"
```

---

### Task 11: Restyle TTSPlayer in cyberpunk neon

**Files:**
- Modify: `frontend/components/TTSPlayer.tsx`

TTSPlayer has complex state logic. Change only the returned JSX styling (colors, borders, buttons) — keep all state, audio, and sentence-queue logic untouched. Focus on the final `return` block.

- [ ] **Step 1: Find the return statement in TTSPlayer.tsx and restyle**

The player render should adopt the neon palette:
- Container: `background: #0d0d24`, `border-bottom: 1px solid rgba(124,58,237,0.25)`
- Play/Pause button: violet background with `box-shadow: 0 0 12px rgba(124,58,237,0.5)`
- Seek bar track: `background: rgba(124,58,237,0.2)`, filled: `background: #a78bfa`
- Provider badge: `color: #00ffff` when active, monospace font
- Speed/controls: violet text
- All borders use `rgba(124,58,237,0.25)`

Read the TTSPlayer return block carefully and update only colors/borders/shadows — do not touch any event handlers, state variables, or logic. The AudioVisualizer is already updated.

Key style targets:
```
Outer wrapper:      bg-[#0d0d24]
Play button:        bg-violet-600 shadow shadow-violet-500/40
Progress track:     bg-violet-950/50
Progress fill:      bg-violet-400
Time display:       text-violet-400 font-mono text-xs
Provider badge:     text-cyan-400 font-mono text-xs
Skip buttons:       text-violet-400 hover:text-white
Speed display:      text-violet-300
```

- [ ] **Step 2: Add "edge" as a selectable provider option in SettingsPanel**

This is handled in Task 13 (SettingsPanel). No changes needed in TTSPlayer itself.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/TTSPlayer.tsx
git commit -m "feat(ui): cyberpunk neon TTSPlayer styling"
```

---

### Task 12: Rebuild SettingsPanel in cyberpunk neon + add Edge TTS option

**Files:**
- Modify: `frontend/components/SettingsPanel.tsx`

- [ ] **Step 1: Read SettingsPanel.tsx**

Read the file to understand its current provider-selector and settings structure before editing.

- [ ] **Step 2: Add Edge TTS to the provider selector**

Find wherever `TTSProvider` options are listed (likely an array like `['gemini', 'openai', 'minimax', 'xtts', 'gtranslate']`). Add `'edge'` to it.

Add an Edge TTS config section (shown when `preferredProvider === 'edge'`):
```tsx
{ttsSettings.preferredProvider === 'edge' && (
  <div className="mt-3 rounded-lg p-3" style={{ background: 'rgba(0,255,255,0.05)', border: '1px solid rgba(0,255,255,0.2)' }}>
    <p className="text-xs" style={{ color: '#00ffff' }}>
      ✓ Edge TTS — <span style={{ color: 'rgba(0,255,255,0.7)' }}>vi-VN-NamMinhNeural</span>
    </p>
    <p className="text-xs mt-1" style={{ color: '#4a4a7a' }}>
      Miễn phí · Không cần API key · Không giới hạn ký tự
    </p>
  </div>
)}
```

- [ ] **Step 3: Restyle the entire SettingsPanel in cyberpunk neon**

Replace gray-900/gray-800/indigo-* colors with the neon palette throughout:
- Panel background: `#0e0e28`
- Section headers: `color: #a78bfa`
- Labels: `color: #8888b0`
- Input backgrounds: `#12122a`
- Input borders: `rgba(124,58,237,0.3)`
- Accent/active: `#7c3aed` with `box-shadow: 0 0 8px rgba(124,58,237,0.4)`
- Sliders: accent color `#a78bfa`

- [ ] **Step 4: Commit**

```bash
git add frontend/components/SettingsPanel.tsx
git commit -m "feat(ui): cyberpunk neon SettingsPanel + Edge TTS provider option"
```

---

### Task 13: Restyle NovelCard and UserMenu

**Files:**
- Modify: `frontend/components/NovelCard.tsx`
- Modify: `frontend/components/UserMenu.tsx`

- [ ] **Step 1: Read both files**

Read `NovelCard.tsx` and `UserMenu.tsx` before editing.

- [ ] **Step 2: Restyle NovelCard**

Replace gray-* and indigo-* with neon palette:
- Card border: `rgba(124,58,237,0.3)` with hover glow `box-shadow: 0 0 20px rgba(124,58,237,0.2)`
- Card background: `#12122a`
- Title: `color: #e2e8f0`
- Progress/meta: `color: #6d6d9a`
- Active indicator: `color: #00ffff` (cyan checkmark)
- Delete button: `color: #ff66ff` on hover

- [ ] **Step 3: Restyle UserMenu**

Replace with neon palette:
- Dropdown: `background: #0e0e28`, border `rgba(124,58,237,0.3)`
- Email: `color: #a78bfa`
- Sync status: cyan when synced, amber when syncing
- Sign out button: `color: #ff66ff`

- [ ] **Step 4: Commit**

```bash
git add frontend/components/NovelCard.tsx frontend/components/UserMenu.tsx
git commit -m "feat(ui): cyberpunk neon NovelCard and UserMenu"
```

---

## Chunk 6: HomePage Rebuild — Dashboard + Animated Background

### Task 14: Rebuild HomePage with neon dashboard and animated background

**Files:**
- Modify: `frontend/components/HomePage.tsx`
- Modify: `frontend/app/globals.css`

- [ ] **Step 1: Add neon animation keyframes to globals.css**

Add to `frontend/app/globals.css`:
```css
/* Neon particle float animation */
@keyframes neon-float {
  0%, 100% { transform: translateY(0) scale(1); opacity: 0.6; }
  50% { transform: translateY(-20px) scale(1.05); opacity: 1; }
}
@keyframes neon-float-slow {
  0%, 100% { transform: translateY(0) translateX(0); opacity: 0.4; }
  33% { transform: translateY(-15px) translateX(8px); opacity: 0.7; }
  66% { transform: translateY(10px) translateX(-5px); opacity: 0.5; }
}
@keyframes neon-pulse-glow {
  0%, 100% { text-shadow: 0 0 8px #7c3aed, 0 0 20px #7c3aed44; }
  50% { text-shadow: 0 0 16px #a78bfa, 0 0 40px #7c3aed88, 0 0 60px #7c3aed44; }
}
@keyframes scanline {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100vh); }
}
```

- [ ] **Step 2: Rewrite HomePage.tsx**

Replace the entire file with:

```tsx
'use client'

import { Plus, Headphones, BookOpen, Zap } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import NovelCard from './NovelCard'
import type { SavedNovel } from '@/lib/types'

// Neon particle positions (deterministic to avoid hydration mismatch)
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
          {/* Logo */}
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

          <button
            onClick={handleAddNew}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium transition-all hover:-translate-y-0.5 active:translate-y-0"
            style={{ background: '#7c3aed', boxShadow: '0 0 16px rgba(124,58,237,0.4)' }}
          >
            <Plus size={16} />
            Thêm truyện
          </button>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────── */}
      <main className="relative z-10 flex-1 max-w-7xl mx-auto w-full px-6 py-10">
        {savedNovels.length === 0 ? (
          /* ── Empty state ── */
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            {/* Glowing icon */}
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
              {/* Orbiting dots */}
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
    </div>
  )
}
```

- [ ] **Step 3: Verify animation runs**

`npm run dev` → homepage should show softly floating neon blobs in the background, glowing logo text, violet/cyan/pink palette throughout.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/HomePage.tsx frontend/app/globals.css
git commit -m "feat(ui): cyberpunk neon HomePage with animated particle background"
```

---

## Chunk 7: Final integration and verification

### Task 15: End-to-end integration test

- [ ] **Step 1: Start both servers**

```bash
# Terminal 1
cd backend && uvicorn main:app --reload --port 8000

# Terminal 2
cd frontend && npm run dev
```

- [ ] **Step 2: Test Edge TTS**

In SettingsPanel, select "edge" as preferred provider. Play a sentence. Verify:
- Audio plays with Vietnamese male voice
- Provider badge shows "edge"
- No API key required

- [ ] **Step 3: Test vertical resize**

Drag the horizontal divider between reader and player panel. Verify:
- Player panel grows/shrinks
- Height persists across page refresh

- [ ] **Step 4: Test Google login removed**

Open auth modal → only email/password form, no Google button.

- [ ] **Step 5: Test truyenplus.vn banner**

Enter a non-truyenplus URL → toast error appears. Banner always visible in sidebar.

- [ ] **Step 6: Test AudioVisualizer**

Play audio → pixel bars animate with neon violet/cyan/pink, crisp edges, glow effect. Stop → flatline idle state.

- [ ] **Step 7: Final commit + push**

```bash
git add -A
git commit -m "chore: cyberpunk neon UI rebuild complete — all components updated"
git push origin feat/production-upgrade
```
