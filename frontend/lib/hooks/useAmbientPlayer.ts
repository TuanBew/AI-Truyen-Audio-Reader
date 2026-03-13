'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'react-toastify'
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
  mimeType: string
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
  uploading: boolean
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
  const [uploading, setUploading] = useState(false)

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
          const url = URL.createObjectURL(new Blob([r.buffer], { type: r.mimeType || 'audio/mpeg' }))
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
    // At index 0 (or -1 if no track selected), wrap to last track
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
      toast.error(`File quá lớn (tối đa ${MAX_FILE_BYTES / 1024 / 1024} MB)`)
      return
    }

    const db = dbRef.current
    if (!db) {
      toast.error('Cơ sở dữ liệu âm thanh chưa sẵn sàng — thử lại sau')
      return
    }

    setUploading(true)
    try {
      const buffer = await file.arrayBuffer()
      const id = crypto.randomUUID()
      const name = file.name.replace(/\.[^.]+$/, '') // strip extension
      const mimeType = file.type || 'audio/mpeg'

      await putTrack(db, { id, name, buffer, mimeType })

      const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload thất bại'
      toast.error(`Không thể thêm bài nhạc: ${msg}`)
    } finally {
      setUploading(false)
    }
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
    uploading,
  }
}
