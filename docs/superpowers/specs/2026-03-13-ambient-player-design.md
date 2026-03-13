# Ambient Player & UI Polish Design

**Date:** 2026-03-13
**Status:** Approved

---

## Goal

Three improvements to AudioTruyen:

1. **Visualizer fix** — bars are currently too short due to a halving quantization bug; fix amplitude scaling so bars reach realistic heights.
2. **Bottom border** — add a subtle neon gradient line at the very bottom of the app shell to visually separate the app from the OS taskbar.
3. **Ambient sound player** — a lofi/chill background music player embedded in PlayerPanel, with bundled default tracks, drag-and-drop MP3 upload (persisted in IndexedDB), and two loop modes (Loop All / Loop One).

---

## Architecture

### 1. Visualizer Fix (`frontend/components/AudioVisualizer.tsx`)

**Root cause:** The formula `Math.round(value * (H-4) / 2) * 2` divides by 2 then multiplies by 2 — ostensibly to quantize to even pixels — but this halves the effective amplitude. Speech/TTS audio also rarely pushes frequency bins above ~128/255, so bars peak at ~45% of canvas height in practice.

**Fix:** In `AudioVisualizer.tsx`, find the exact line:
```ts
const barHeight = Math.max(2, Math.round(value * (H - 4) / 2) * 2)
```
Replace it with:
```ts
const barHeight = Math.max(2, Math.min(H - 2, Math.round(value * (H - 2) * 1.8)))
```
- `1.8×` amplification makes typical speech audio fill 70–90% of the canvas.
- `Math.min(H - 2, ...)` prevents overflow.
- No structural changes; only the one formula line changes.

---

### 2. Bottom Border (`frontend/components/MainLayout.tsx`)

Add a single `<div>` as the last child of the outer `flex h-screen` wrapper:

```tsx
<div style={{
  height: '1px',
  flexShrink: 0,
  background: 'linear-gradient(90deg, transparent, rgba(0,255,255,0.2), rgba(124,58,237,0.3), rgba(0,255,255,0.2), transparent)'
}} />
```

This is purely cosmetic — one line, no new component.

---

### 3. Ambient Sound Player

#### TypeScript Types

`AmbientTrack` type (defined in `frontend/lib/ambientTracks.ts`):
```ts
export interface AmbientTrack {
  id: string       // unique identifier
  name: string     // display name
  src: string      // URL: '/ambient/city-rain.mp3' for defaults, object URL for user tracks
  isUser?: boolean // true for user-uploaded tracks
}
```

#### Data Model

**Default tracks** — 5 royalty-free lofi MP3s bundled in `frontend/public/ambient/`:

| id | name | file |
|----|------|------|
| `city-rain` | City Rain Lofi | `/ambient/city-rain.mp3` |
| `coffee-shop` | Coffee Shop | `/ambient/coffee-shop.mp3` |
| `midnight-study` | Midnight Study | `/ambient/midnight-study.mp3` |
| `lo-chill` | Lo Chill | `/ambient/lo-chill.mp3` |
| `forest-beats` | Forest Beats | `/ambient/forest-beats.mp3` |

**User tracks** — stored in IndexedDB under database `audiotruyen-ambient`, object store `tracks`. Each record: `{ id: string, name: string, buffer: ArrayBuffer }`. On mount, tracks are read from IndexedDB and object URLs created via `URL.createObjectURL(new Blob([buffer], { type: 'audio/mpeg' }))`. The `ArrayBuffer` from IndexedDB is used only to create the object URL and is not held in React state — only the resulting `AmbientTrack` (id, name, src) is stored in component state. Object URLs are revoked on unmount.

**User track ID generation:** Use `crypto.randomUUID()` (available in all modern browsers). This avoids collisions with the 5 fixed default IDs (`city-rain`, `coffee-shop`, `midnight-study`, `lo-chill`, `forest-beats`) and with other user uploads.

**Zustand slice** (`ambientState`, persisted to localStorage):
```ts
interface AmbientState {
  currentTrackId: string | null   // id of active track
  volume: number                  // 0–1, default 0.4
  loopMode: 'all' | 'one'         // 'all' = advance to next, 'one' = repeat same
  isPlaying: boolean              // NOT persisted — see note below
  // Actions:
  setAmbientTrack: (id: string | null) => void
  setAmbientVolume: (volume: number) => void
  setAmbientLoopMode: (mode: 'all' | 'one') => void
  setAmbientPlaying: (playing: boolean) => void
}
```

> **Important:** `isPlaying` must be **excluded from `partialize`** in the Zustand `persist` config (always rehydrate as `false`). Persisting `isPlaying: true` would cause `audio.play()` to be called on page load, triggering a browser autoplay-policy block.

The `partialize` addition for the ambient slice (add to the existing `partialize` object in `store.ts`):
```ts
// Inside the partialize callback, add:
ambientState: {
  currentTrackId: state.ambientState.currentTrackId,
  volume: state.ambientState.volume,
  loopMode: state.ambientState.loopMode,
  // isPlaying intentionally excluded
},
```

#### New Files

| File | Purpose |
|------|---------|
| `frontend/lib/ambientTracks.ts` | Defines `AmbientTrack` interface; exports `DEFAULT_TRACKS: AmbientTrack[]` — the static list with id/name/src. |
| `frontend/lib/hooks/useAmbientPlayer.ts` | Custom hook encapsulating the `HTMLAudioElement`, IndexedDB read/write, track list (default + user), play/pause/prev/next, loop logic, and volume. Returns everything `AmbientPlayer.tsx` needs. |
| `frontend/components/AmbientPlayer.tsx` | UI row rendered inside PlayerPanel. |

#### Modified Files

| File | Change |
|------|--------|
| `frontend/lib/store.ts` | Add `ambientState` slice with actions `setAmbientTrack`, `setAmbientVolume`, `setAmbientLoopMode`, `setAmbientPlaying`. Persist `currentTrackId`, `volume`, `loopMode` only — exclude `isPlaying` from `partialize`. |
| `frontend/components/PlayerPanel.tsx` | Mount `<AmbientPlayer />` **outside** the `if (!currentChapter) return null` guard so it is always visible. See restructuring note below. |
| `frontend/components/MainLayout.tsx` | Add bottom border `<div>`. |
| `frontend/components/AudioVisualizer.tsx` | Fix bar height formula (see above). |

#### PlayerPanel Restructuring

`PlayerPanel.tsx` currently has an early return `if (!currentChapter) return null` before the JSX. `AmbientPlayer` must be visible even when no chapter is loaded. The fix:

```tsx
export default function PlayerPanel() {
  const currentChapter = useAppStore(s => s.currentChapter)

  return (
    <div className="...player-panel-wrapper...">
      {currentChapter && (
        <>
          <TTSPlayer />
          <RecordingControls />
        </>
      )}
      <AmbientPlayer />   {/* always rendered */}
    </div>
  )
}
```

The outer wrapper div must always render; only TTSPlayer and RecordingControls are gated on `currentChapter`.

#### `useAmbientPlayer` Hook

Responsibilities:
- Manages a single `HTMLAudioElement` ref (not re-created on re-render).
- On mount: reads all records from IndexedDB (`getAll()`), creates an object URL for each (`URL.createObjectURL(new Blob([record.buffer]))`), discards the `ArrayBuffer` immediately (do not store it in state), builds `AmbientTrack[]` for user tracks, merges with `DEFAULT_TRACKS`.
- On unmount: revokes all object URLs created for user tracks.
- `play(trackId)` — sets `audio.src`, calls `audio.play()`, updates Zustand `currentTrackId` and `isPlaying: true`.
- `toggle()` — if playing, calls `audio.pause()` and sets `isPlaying: false`; if paused, calls `audio.play()` and sets `isPlaying: true`.
- `next()` / `prev()` — advance/rewind in merged track list; both are no-ops when `loopMode === 'one'`. When `loopMode === 'all'`: `next()` at the last track wraps to index 0; `prev()` at index 0 wraps to the last track.
- **Stale `currentTrackId` on mount:** After loading tracks from IndexedDB, if `currentTrackId` from persisted Zustand does not match any track in the merged list (e.g., user cleared IndexedDB), reset `currentTrackId` to `null` (no track selected, player idle).
- `audio.onended` handler:
  - If `loopMode === 'all'`: call `next()`. When already at the last track, `next()` wraps around to index 0 and plays from the start.
  - If `loopMode === 'one'`: set `audio.currentTime = 0` then call `audio.play()` to replay the same track.
- `addTrack(file: File)` — reads file as `ArrayBuffer` via `FileReader`, generates a UUID with `crypto.randomUUID()` as `id`, uses `file.name` (without extension) as display name, writes `{ id, name, buffer }` to IndexedDB via `put()`, creates an object URL from the buffer, discards the buffer, appends the new `AmbientTrack` to the track list, sets it as current.
- Volume changes write to `audio.volume` immediately and update Zustand `volume`.
- File size limit: reject files larger than 50 MB with a `console.warn` (no UI error needed — YAGNI).

#### `AmbientPlayer.tsx` UI

Single row with neon cyan accent (`#00ffff`), visually distinct from the violet TTS player:

```
[♪]  [City Rain Lofi ▾]  [◀]  [▶/⏸]  [▶]  [🔁/↺]  [────vol────]  [+ Add]
```

- `♪` icon — static, decorative
- Track name — `<select>` dropdown styled to match the neon theme, showing all tracks (default + user-uploaded)
- `◀` / `▶` — prev/next; both disabled when `loopMode === 'one'`
- `▶/⏸` — play/pause toggle
- `🔁` (Loop All) / `↺` (Loop One) — click to toggle between modes
- Volume slider — `<input type="range" min={0} max={1} step={0.01}>`
- `+ Add` — `<input type="file" accept=".mp3,audio/*" />` hidden behind a styled button; also accepts drag-and-drop onto the row (`onDragOver` + `onDrop` handlers)

Styling: `background: rgba(0,255,255,0.04)`, `border-top: 1px solid rgba(0,255,255,0.15)`, text in `#00ffff` / `#00ffff88`.

#### IndexedDB Schema

```
Database: audiotruyen-ambient  (version 1)
Object store: tracks
  keyPath: id (string UUID, from crypto.randomUUID())
  Fields: { id, name, buffer: ArrayBuffer }
```

Operations: `getAll()` on mount, `put()` on upload, no delete UI (YAGNI).

---

## What Is NOT in Scope

- Backend upload endpoint — all audio handled client-side.
- Equalizer / audio effects on ambient track.
- Delete uploaded tracks from UI (can clear IndexedDB manually).
- Shuffle mode.
- Waveform visualizer for the ambient player.

---

## Testing Checklist

- [ ] Visualizer bars reach realistic height during TTS playback
- [ ] Bottom border renders at the very bottom of the app window
- [ ] Default tracks load and play via the track dropdown
- [ ] Play/pause toggles correctly
- [ ] Next/prev advances through the track list
- [ ] Loop All: last track advances to first; Loop One: same track repeats
- [ ] Drag-and-drop MP3 onto the row → track appears in dropdown, plays
- [ ] File picker button → same result as drag-and-drop
- [ ] Uploaded tracks persist after page refresh
- [ ] Volume slider changes volume immediately
- [ ] Ambient state (track, volume, loop mode) persists in localStorage; `isPlaying` rehydrates as `false`
- [ ] Ambient audio plays simultaneously with TTS without interference
- [ ] AmbientPlayer row visible even when no chapter is loaded
