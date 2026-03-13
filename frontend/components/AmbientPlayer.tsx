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
    uploading,
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
        disabled={uploading}
        style={btnStyle(uploading)}
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
