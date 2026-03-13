# Ambient Player & UI Polish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the visualizer amplitude, add a neon bottom border, and build a lofi ambient sound player embedded in PlayerPanel with IndexedDB-persisted user tracks and loop modes.

**Architecture:** Three isolated changes: (1) a one-line formula fix in AudioVisualizer, (2) a cosmetic div in MainLayout, (3) a new ambient player consisting of a data file (`ambientTracks.ts`), a Zustand slice in `store.ts`, a custom hook (`useAmbientPlayer.ts`), and a UI component (`AmbientPlayer.tsx`) mounted in a restructured `PlayerPanel`.

**Tech Stack:** Next.js 16, React 19, TypeScript, Zustand + persist middleware, IndexedDB (native browser API), HTMLAudioElement (native), Tailwind CSS v4, Lucide React icons.

**Spec:** `docs/superpowers/specs/2026-03-13-ambient-player-design.md`

---

## Chunk 1: Quick Fixes

### Task 1: Fix AudioVisualizer bar height formula

**Files:**
- Modify: `frontend/components/AudioVisualizer.tsx:87`

The current formula halves bar height due to a quantize-then-halve bug. Replace with a 1.8× amplified formula.

- [ ] **Step 1: Open `frontend/components/AudioVisualizer.tsx` and find line 87:**

```ts
const barHeight = Math.max(2, Math.round(value * (H - 4) / 2) * 2) // quantize to even pixels
```

- [ ] **Step 2: Replace that exact line with:**

```ts
const barHeight = Math.max(2, Math.min(H - 2, Math.round(value * (H - 2) * 1.8)))
```

The comment can be removed — the new formula is self-explanatory. `1.8×` amplification makes typical speech audio fill 70–90% of canvas height; `Math.min(H - 2, ...)` prevents overflow.

- [ ] **Step 3: Verify TypeScript compiles cleanly:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit:**

```bash
git add frontend/components/AudioVisualizer.tsx
git commit -m "fix(visualizer): amplify bar height 1.8x to fix under-height bars"
```

---

### Task 2: Add bottom neon border to MainLayout

**Files:**
- Modify: `frontend/components/MainLayout.tsx`

Add a decorative 1px gradient line pinned to the very bottom of the viewport.

> **Layout note:** The outer `<div className="flex h-screen">` is a **row-direction** flex container (sidebar + main side-by-side). A `<div>` inserted as a flex child there would render as a vertical stripe, not a horizontal line. The correct approach is `position: fixed` to pin the border to the bottom of the viewport independently of the flex layout.

- [ ] **Step 1: Open `frontend/components/MainLayout.tsx`. Find line 141 — the closing `</div>` tag of the outer `flex h-screen` wrapper and the `)` that closes the return statement:**

```tsx
      <AuthModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} />
    </div>
  )
```

> Exact search string: `<AuthModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} />` followed by `    </div>` and `  )`. This block appears only once in the file.

- [ ] **Step 2: Insert the fixed-position border `<div>` between `<AuthModal .../>` and `</div>`. Replace that block with:**

```tsx
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
```

- [ ] **Step 3: Verify TypeScript compiles:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit:**

```bash
git add frontend/components/MainLayout.tsx
git commit -m "feat(ui): add fixed-position neon gradient bottom border"
```

---

## Chunk 2: Data Layer

### Task 3: Create `ambientTracks.ts` with type and default tracks

**Files:**
- Create: `frontend/lib/ambientTracks.ts`

This file is the single source of truth for the `AmbientTrack` type and the 5 bundled default tracks.

- [ ] **Step 1: Create `frontend/lib/ambientTracks.ts`:**

```ts
export interface AmbientTrack {
  id: string        // unique identifier — kebab-case for defaults, UUID for user tracks
  name: string      // display name shown in dropdown
  src: string       // URL: '/ambient/city-rain.mp3' for defaults, object URL for user tracks
  isUser?: boolean  // true for user-uploaded tracks
}

export const DEFAULT_TRACKS: AmbientTrack[] = [
  { id: 'city-rain',      name: 'City Rain Lofi',   src: '/ambient/city-rain.mp3' },
  { id: 'coffee-shop',    name: 'Coffee Shop',       src: '/ambient/coffee-shop.mp3' },
  { id: 'midnight-study', name: 'Midnight Study',    src: '/ambient/midnight-study.mp3' },
  { id: 'lo-chill',       name: 'Lo Chill',          src: '/ambient/lo-chill.mp3' },
  { id: 'forest-beats',   name: 'Forest Beats',      src: '/ambient/forest-beats.mp3' },
]
```

- [ ] **Step 2: Place 5 royalty-free lofi MP3 files in `frontend/public/ambient/`:**

Download free lofi tracks from Pixabay Audio (https://pixabay.com/music/search/lofi/) or any royalty-free source. Name them exactly:
- `city-rain.mp3`
- `coffee-shop.mp3`
- `midnight-study.mp3`
- `lo-chill.mp3`
- `forest-beats.mp3`

Place all 5 files in `frontend/public/ambient/`. They must be valid MP3 files — empty files will silently fail.

- [ ] **Step 3: Verify TypeScript compiles:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit:**

```bash
git add frontend/lib/ambientTracks.ts frontend/public/ambient/
git commit -m "feat(ambient): add AmbientTrack type and bundled default tracks"
```

---

### Task 4: Add `ambientState` Zustand slice to `store.ts`

**Files:**
- Modify: `frontend/lib/store.ts`

Adds the four-field state object and four action setters. `isPlaying` is excluded from `partialize` to avoid browser autoplay-policy blocks on reload.

- [ ] **Step 1: In `frontend/lib/store.ts`, add the ambient slice interface to `AppStore`. Find the closing `}` of the `AppStore` interface (currently around line 100) and add before it:**

```ts
  // Ambient player
  ambientState: {
    currentTrackId: string | null
    volume: number
    loopMode: 'all' | 'one'
    isPlaying: boolean
  }
  setAmbientTrack: (id: string | null) => void
  setAmbientVolume: (volume: number) => void
  setAmbientLoopMode: (mode: 'all' | 'one') => void
  setAmbientPlaying: (playing: boolean) => void
```

- [ ] **Step 2: Add the initial state in the `create` callback. Find the line `settingsPanelOpen: false,` (around line 137) and add after it:**

```ts
      ambientState: {
        currentTrackId: null,
        volume: 0.4,
        loopMode: 'all',
        isPlaying: false,
      },
```

- [ ] **Step 3: Add the action implementations. Find the `toggleSettingsPanel` action (around line 269) and add the ambient actions after it:**

```ts
      // ── Ambient player ────────────────────────────────────
      setAmbientTrack: (id) =>
        set((s) => ({ ambientState: { ...s.ambientState, currentTrackId: id } })),
      setAmbientVolume: (volume) =>
        set((s) => ({ ambientState: { ...s.ambientState, volume } })),
      setAmbientLoopMode: (loopMode) =>
        set((s) => ({ ambientState: { ...s.ambientState, loopMode } })),
      setAmbientPlaying: (isPlaying) =>
        set((s) => ({ ambientState: { ...s.ambientState, isPlaying } })),
```

- [ ] **Step 4: Add the ambient state to `partialize`. Find the closing `})` of the `partialize` object (around line 372) and add `ambientState` before the closing `})`:**

```ts
        ambientState: {
          currentTrackId: state.ambientState.currentTrackId,
          volume: state.ambientState.volume,
          loopMode: state.ambientState.loopMode,
          // isPlaying intentionally excluded — avoids browser autoplay-policy block on reload
        },
```

The full `partialize` callback after your edit should look like:

```ts
      partialize: (state) => ({
        view: state.view,
        activeNovelId: state.activeNovelId,
        savedNovels: state.savedNovels,
        finishedChapterUrls: state.finishedChapterUrls,
        ttsSettings: state.ttsSettings,
        recordingState: {
          saveDirectory: state.recordingState.saveDirectory,
          audioFormat: state.recordingState.audioFormat,
          savedFiles: [],
          isRecording: false,
        },
        currentChapterUrl: state.currentChapterUrl,
        currentSentenceIndex: state.currentSentenceIndex,
        ambientState: {
          currentTrackId: state.ambientState.currentTrackId,
          volume: state.ambientState.volume,
          loopMode: state.ambientState.loopMode,
          // isPlaying intentionally excluded — avoids browser autoplay-policy block on reload
        },
      }),
```

- [ ] **Step 5: Verify TypeScript compiles:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. If TypeScript complains about `ambientState` partial type in `partialize`, you may need a type cast — but this should not occur since Zustand's `partialize` accepts `Partial<AppStore>`.

- [ ] **Step 6: Commit:**

```bash
git add frontend/lib/store.ts
git commit -m "feat(store): add ambientState Zustand slice with persist (isPlaying excluded)"
```

---

## Chunk 3: Business Logic

### Task 5: Create `useAmbientPlayer` hook

**Files:**
- Create: `frontend/lib/hooks/useAmbientPlayer.ts`

This hook owns the `HTMLAudioElement`, all IndexedDB I/O, and all playback logic. Components interact with it exclusively via its returned controls object — no audio logic leaks into components.

- [ ] **Step 1: Create `frontend/lib/hooks/useAmbientPlayer.ts` with the full implementation:**

```ts
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { DEFAULT_TRACKS, type AmbientTrack } from '@/lib/ambientTracks'

// ── IndexedDB helpers ──────────────────────────────────────────────────────

const DB_NAME = 'audiotruyen-ambient'
const DB_VERSION = 1
const STORE_NAME = 'tracks'
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB

interface IDBTrackRecord {
  id: string
  name: string
  buffer: ArrayBuffer
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function getAllTracks(db: IDBDatabase): Promise<IDBTrackRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as IDBTrackRecord[])
    req.onerror = () => reject(req.error)
  })
}

function putTrack(db: IDBDatabase, record: IDBTrackRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).put(record)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// ── Hook public interface ──────────────────────────────────────────────────

export interface AmbientPlayerControls {
  tracks: AmbientTrack[]
  currentTrackId: string | null
  isPlaying: boolean
  volume: number
  loopMode: 'all' | 'one'
  play: (trackId: string) => void
  toggle: () => void
  next: () => void
  prev: () => void
  setVolume: (v: number) => void
  setLoopMode: (mode: 'all' | 'one') => void
  addTrack: (file: File) => Promise<void>
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useAmbientPlayer(): AmbientPlayerControls {
  const {
    ambientState,
    setAmbientTrack,
    setAmbientVolume,
    setAmbientLoopMode,
    setAmbientPlaying,
  } = useAppStore()
  const { currentTrackId, volume, loopMode, isPlaying } = ambientState

  // Stable refs — never re-created, safe to use in event handlers
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const dbRef = useRef<IDBDatabase | null>(null)
  const objectUrlsRef = useRef<string[]>([])   // for cleanup on unmount

  // Mutable refs so the onended handler always has fresh values
  const tracksRef = useRef<AmbientTrack[]>(DEFAULT_TRACKS)
  const loopModeRef = useRef<'all' | 'one'>(loopMode)
  const currentTrackIdRef = useRef<string | null>(currentTrackId)

  const [tracks, setTracks] = useState<AmbientTrack[]>(DEFAULT_TRACKS)

  // Keep mutable refs in sync with state
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  useEffect(() => { loopModeRef.current = loopMode }, [loopMode])
  useEffect(() => { currentTrackIdRef.current = currentTrackId }, [currentTrackId])

  // ── Mount: create Audio element, load IndexedDB tracks ──────────────────

  useEffect(() => {
    const audio = new Audio()
    audio.volume = volume
    audioRef.current = audio
    let cancelled = false

    const init = async () => {
      try {
        const db = await openDB()
        if (cancelled) return
        dbRef.current = db

        const records = await getAllTracks(db)
        if (cancelled) return

        const userTracks: AmbientTrack[] = records.map((r) => {
          const url = URL.createObjectURL(new Blob([r.buffer], { type: 'audio/mpeg' }))
          objectUrlsRef.current.push(url)
          return { id: r.id, name: r.name, src: url, isUser: true }
        })

        const merged = [...DEFAULT_TRACKS, ...userTracks]
        setTracks(merged)
        tracksRef.current = merged

        // Validate persisted currentTrackId — reset if track no longer exists
        const persistedId = useAppStore.getState().ambientState.currentTrackId
        if (persistedId && !merged.find((t) => t.id === persistedId)) {
          setAmbientTrack(null)
        }
      } catch (e) {
        console.warn('useAmbientPlayer: IndexedDB init failed', e)
      }
    }

    init()

    return () => {
      cancelled = true
      audio.pause()
      audioRef.current = null
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current = []
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync volume to audio element ─────────────────────────────────────────

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  // ── onended handler — reads from refs to avoid stale closures ───────────

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handleEnded = () => {
      const mode = loopModeRef.current
      if (mode === 'one') {
        audio.currentTime = 0
        audio.play().catch(() => {})
        return
      }
      // Loop All: advance to next, wrapping from last to first
      const list = tracksRef.current
      const tid = currentTrackIdRef.current
      const idx = list.findIndex((t) => t.id === tid)
      const nextIdx = (idx + 1) % list.length
      const nextTrack = list[nextIdx]
      if (!nextTrack) return
      audio.src = nextTrack.src
      audio.play().catch(() => {})
      useAppStore.getState().setAmbientTrack(nextTrack.id)
      useAppStore.getState().setAmbientPlaying(true)
    }

    audio.addEventListener('ended', handleEnded)
    return () => audio.removeEventListener('ended', handleEnded)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Playback controls ────────────────────────────────────────────────────

  const play = useCallback((trackId: string) => {
    const track = tracksRef.current.find((t) => t.id === trackId)
    if (!track || !audioRef.current) return
    audioRef.current.src = track.src
    audioRef.current.play().catch(() => {})
    setAmbientTrack(trackId)
    setAmbientPlaying(true)
  }, [setAmbientTrack, setAmbientPlaying])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      // If no src is loaded yet, load the current track first
      if (!audio.src && currentTrackIdRef.current) {
        const track = tracksRef.current.find((t) => t.id === currentTrackIdRef.current)
        if (track) audio.src = track.src
      }
      audio.play().catch(() => {})
      setAmbientPlaying(true)
    } else {
      audio.pause()
      setAmbientPlaying(false)
    }
  }, [setAmbientPlaying])

  const next = useCallback(() => {
    if (loopModeRef.current === 'one') return
    const list = tracksRef.current
    const idx = list.findIndex((t) => t.id === currentTrackIdRef.current)
    const nextIdx = (idx + 1) % list.length
    const nextTrack = list[nextIdx]
    if (!nextTrack || !audioRef.current) return
    audioRef.current.src = nextTrack.src
    audioRef.current.play().catch(() => {})
    setAmbientTrack(nextTrack.id)
    setAmbientPlaying(true)
  }, [setAmbientTrack, setAmbientPlaying])

  const prev = useCallback(() => {
    if (loopModeRef.current === 'one') return
    const list = tracksRef.current
    const idx = list.findIndex((t) => t.id === currentTrackIdRef.current)
    // At index 0, wrap to last track
    const prevIdx = idx <= 0 ? list.length - 1 : idx - 1
    const prevTrack = list[prevIdx]
    if (!prevTrack || !audioRef.current) return
    audioRef.current.src = prevTrack.src
    audioRef.current.play().catch(() => {})
    setAmbientTrack(prevTrack.id)
    setAmbientPlaying(true)
  }, [setAmbientTrack, setAmbientPlaying])

  const setVolume = useCallback((v: number) => {
    setAmbientVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [setAmbientVolume])

  const setLoopMode = useCallback((mode: 'all' | 'one') => {
    setAmbientLoopMode(mode)
  }, [setAmbientLoopMode])

  const addTrack = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      console.warn(`useAmbientPlayer: file too large (${file.size} bytes), max is ${MAX_FILE_BYTES}`)
      return
    }

    const buffer = await file.arrayBuffer()
    const id = crypto.randomUUID()
    const name = file.name.replace(/\.[^.]+$/, '') // strip extension

    const db = dbRef.current
    if (!db) {
      console.warn('useAmbientPlayer: IndexedDB not ready')
      return
    }

    await putTrack(db, { id, name, buffer })

    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/mpeg' }))
    objectUrlsRef.current.push(url)

    const newTrack: AmbientTrack = { id, name, src: url, isUser: true }
    setTracks((prev) => [...prev, newTrack])

    // Auto-select and play the new track
    if (audioRef.current) {
      audioRef.current.src = url
      audioRef.current.play().catch(() => {})
    }
    setAmbientTrack(id)
    setAmbientPlaying(true)
  }, [setAmbientTrack, setAmbientPlaying])

  return {
    tracks,
    currentTrackId,
    isPlaying,
    volume,
    loopMode,
    play,
    toggle,
    next,
    prev,
    setVolume,
    setLoopMode,
    addTrack,
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. Common issues to watch for:
- `useAppStore.getState()` inside event handler — this is valid, Zustand exposes `.getState()` on the store.
- `crypto.randomUUID()` — available in all modern browsers (TypeScript `lib: ["dom"]` covers it).

- [ ] **Step 3: Commit:**

```bash
git add frontend/lib/hooks/useAmbientPlayer.ts
git commit -m "feat(ambient): implement useAmbientPlayer hook (IndexedDB, playback, loop modes)"
```

---

## Chunk 4: UI + Integration

### Task 6: Create `AmbientPlayer.tsx` component

**Files:**
- Create: `frontend/components/AmbientPlayer.tsx`

A compact single-row UI. Uses Lucide icons already installed in this project (`Music`, `SkipBack`, `SkipForward`, `Play`, `Pause`, `Repeat`, `Repeat1`, `Plus`).

- [ ] **Step 1: Verify the required Lucide icons are available:**

```bash
cd frontend && node -e "const { Music, SkipBack, SkipForward, Play, Pause, Repeat, Repeat1, Plus } = require('lucide-react'); console.log('ok')"
```

Expected: `ok`. If any icon is missing, all are available since `lucide-react` is installed as a package — individual icon imports always work.

- [ ] **Step 2: Create `frontend/components/AmbientPlayer.tsx`:**

```tsx
'use client'

import { useRef } from 'react'
import { Music, SkipBack, SkipForward, Play, Pause, Repeat, Repeat1, Plus } from 'lucide-react'
import { useAmbientPlayer } from '@/lib/hooks/useAmbientPlayer'

export default function AmbientPlayer() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    tracks,
    currentTrackId,
    isPlaying,
    volume,
    loopMode,
    play,
    toggle,
    next,
    prev,
    setVolume,
    setLoopMode,
    addTrack,
  } = useAmbientPlayer()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    await addTrack(file)
    e.target.value = '' // reset so same file can be re-selected
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    await addTrack(file)
  }

  const btnStyle = (disabled?: boolean) => ({
    color: disabled ? 'rgba(0,255,255,0.3)' : '#00ffff',
    background: 'none',
    border: 'none',
    padding: '0 2px',
    cursor: disabled ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
  })

  return (
    <div
      className="flex items-center gap-2 px-3 flex-shrink-0"
      style={{
        background: 'rgba(0,255,255,0.04)',
        borderTop: '1px solid rgba(0,255,255,0.15)',
        minHeight: '38px',
        flexWrap: 'nowrap',
        overflow: 'hidden',
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* ♪ icon */}
      <Music size={12} style={{ color: '#00ffff88', flexShrink: 0 }} />

      {/* Track dropdown */}
      <select
        value={currentTrackId ?? ''}
        onChange={(e) => e.target.value && play(e.target.value)}
        style={{
          background: 'transparent',
          color: '#00ffff',
          border: '1px solid rgba(0,255,255,0.2)',
          borderRadius: '3px',
          fontSize: '11px',
          padding: '1px 4px',
          flex: '1 1 0',
          minWidth: 0,
          maxWidth: '150px',
        }}
      >
        {currentTrackId === null && (
          <option value="" style={{ background: '#0c0c1e' }}>
            — select track —
          </option>
        )}
        {tracks.map((t) => (
          <option key={t.id} value={t.id} style={{ background: '#0c0c1e', color: '#00ffff' }}>
            {t.name}
          </option>
        ))}
      </select>

      {/* Prev */}
      <button
        onClick={prev}
        disabled={loopMode === 'one'}
        style={btnStyle(loopMode === 'one')}
        title="Previous"
      >
        <SkipBack size={12} />
      </button>

      {/* Play/Pause */}
      <button
        onClick={toggle}
        disabled={!currentTrackId}
        style={btnStyle(!currentTrackId)}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause size={13} /> : <Play size={13} />}
      </button>

      {/* Next */}
      <button
        onClick={next}
        disabled={loopMode === 'one'}
        style={btnStyle(loopMode === 'one')}
        title="Next"
      >
        <SkipForward size={12} />
      </button>

      {/* Loop mode toggle */}
      <button
        onClick={() => setLoopMode(loopMode === 'all' ? 'one' : 'all')}
        style={btnStyle(false)}
        title={loopMode === 'all' ? 'Loop All — click for Loop One' : 'Loop One — click for Loop All'}
      >
        {loopMode === 'all' ? <Repeat size={12} /> : <Repeat1 size={12} />}
      </button>

      {/* Volume slider */}
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => setVolume(parseFloat(e.target.value))}
        style={{ width: '56px', accentColor: '#00ffff', flexShrink: 0 }}
        title={`Volume: ${Math.round(volume * 100)}%`}
      />

      {/* Add button */}
      <button
        onClick={() => fileInputRef.current?.click()}
        style={btnStyle(false)}
        title="Add MP3"
      >
        <Plus size={12} />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,audio/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit:**

```bash
git add frontend/components/AmbientPlayer.tsx
git commit -m "feat(ambient): add AmbientPlayer UI component"
```

---

### Task 7: Restructure `PlayerPanel.tsx` to mount `AmbientPlayer`

**Files:**
- Modify: `frontend/components/PlayerPanel.tsx`
- Modify: `frontend/components/MainLayout.tsx:19` (update `PLAYER_MIN`)

The current `PlayerPanel` returns `null` when no chapter is loaded — this would hide `AmbientPlayer`. Restructure to always render a wrapper, gate `TTSPlayer`+`RecordingControls` on `currentChapter`, and always render `AmbientPlayer`.

Also bump `PLAYER_MIN` from `90` to `130` in `MainLayout.tsx` — the ambient row adds ~38px to the panel, so the minimum must accommodate it.

- [ ] **Step 1: Open `frontend/components/PlayerPanel.tsx` and replace the entire file contents with:**

```tsx
'use client'

import { useCallback } from 'react'
import { useAppStore } from '@/lib/store'
import { toast } from 'react-toastify'
import TTSPlayer from './TTSPlayer'
import RecordingControls from './RecordingControls'
import AmbientPlayer from './AmbientPlayer'

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

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: '#0d0d24', borderTop: '1px solid rgba(124,58,237,0.25)' }}
    >
      {currentChapter && (
        <>
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
        </>
      )}
      <AmbientPlayer />
    </div>
  )
}
```

- [ ] **Step 2: Update `PLAYER_MIN` in `frontend/components/MainLayout.tsx`. Find line 19:**

```ts
const PLAYER_MIN = 90
```

Replace with:

```ts
const PLAYER_MIN = 130
```

This ensures the resizable panel cannot be dragged below 130px, which comfortably fits the ambient player row (~38px) with room for controls to remain usable.

- [ ] **Step 3: Verify TypeScript compiles cleanly:**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run the Next.js build to verify no runtime issues:**

```bash
cd frontend && npm run build
```

Expected: build succeeds with no errors (warnings about `react-hooks/exhaustive-deps` in `useAmbientPlayer` are acceptable — they are intentional by design, noted with `// eslint-disable-line`).

- [ ] **Step 5: Commit:**

```bash
git add frontend/components/PlayerPanel.tsx frontend/components/MainLayout.tsx
git commit -m "feat(ambient): mount AmbientPlayer in PlayerPanel, bump PLAYER_MIN to 130"
```

---

## Final Verification Checklist

Start the dev server (`cd frontend && npm run dev`) and manually verify:

- [ ] Visualizer bars reach realistic height (70–90% of canvas) during TTS playback
- [ ] Bottom neon border is visible at the very bottom of the app window
- [ ] AmbientPlayer row is visible even when no chapter is loaded
- [ ] Default tracks appear in the dropdown and play
- [ ] Play/pause toggle works correctly
- [ ] Next/prev advances through tracks (Loop All mode)
- [ ] Loop All: last track auto-advances to first on end; next/prev wraps
- [ ] Loop One: same track repeats on end; next/prev buttons are disabled (greyed out)
- [ ] Toggling loop mode switches between Repeat (🔁) and Repeat1 (↺) icons
- [ ] Volume slider changes playback volume immediately
- [ ] Drag-and-drop an MP3 onto the AmbientPlayer row → track appears in dropdown, plays
- [ ] File picker button (`+`) → same result as drag-and-drop
- [ ] Uploaded tracks persist after page refresh (IndexedDB survives reload)
- [ ] Ambient state (track, volume, loop mode) persists in localStorage; `isPlaying` rehydrates as `false` (player idle on reload)
- [ ] Ambient audio plays simultaneously with TTS without interference
- [ ] Panel cannot be dragged smaller than ~130px (PLAYER_MIN enforced)
