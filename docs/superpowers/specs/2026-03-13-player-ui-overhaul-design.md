# Player UI Overhaul — Design Spec

**Date:** 2026-03-13
**Status:** Approved

---

## Goal

Four focused changes to the AudioTruyen player UI:
1. Remove speed/pitch sliders (they don't work with sentence-cached audio)
2. Fix the "Tổng hợp lại" button (currently breaks the player; should replay the chapter)
3. Fix ambient track file upload (silent failures, no user feedback)
4. Add sentence navigation: prev/next buttons, sentence-aware scrubber, clickable counter

---

## Architecture

All changes are confined to the frontend. No backend changes required.

**Single source of truth for sentence position:**
`sentenceQueue.currentSentenceIndex` (Zustand store) drives all three navigation UI elements. When any element calls `seekToSentence(n)`, the store updates and all three re-render in sync. Per-chapter progress persists via `chapterProgress[chapterUrl]` (already implemented).

**Files changed:**
- `frontend/components/SettingsPanel.tsx`
- `frontend/components/TTSPlayer.tsx`
- `frontend/lib/hooks/useAmbientPlayer.ts`

---

## Change 1 — Remove Speed/Pitch Sliders

**What:** Delete the "Tốc độ & Cao độ" section from `SettingsPanel.tsx`.

**Why:** Sliders update `ttsSettings.speed/pitch`, but sentence audio is cached as blobs at synthesis time. Changing speed invalidates the entire cache, causing an audible re-synthesis delay on every slide. The feature is more confusing than useful.

**Implementation:**
- Remove the `<section>` containing the speed and pitch `<input type="range">` elements from `SettingsPanel.tsx`
- Remove **only** `ttsSettings.speed` and `ttsSettings.pitch` from the cache-invalidation `useEffect` deps array in `TTSPlayer.tsx`. Keep the other four deps (`preferredProvider`, `geminiVoice`, `openaiVoice`, `minimaxVoiceId`) — those still affect synthesis output and must still invalidate the cache.
- Keep `speed` and `pitch` in `TTSSettings` type and store defaults (backend still accepts them; they just stay at `1.0`/`0.0`)

---

## Change 2 — Fix "Tổng hợp lại" → "Phát lại từ đầu"

**What:** The ↺ button currently calls `synthesize()`, which synthesizes the entire chapter as one audio blob. This sets `audioBlobUrl` while `sentenceQueue` is still populated, leaving the player in an inconsistent split state — the audio element has a new src but the sentence queue still holds old state.

**New behavior:** The button replays the chapter from sentence 0.

**Implementation in `TTSPlayer.tsx`:**
```
handleReplay():
  1. audioRef.current?.pause()
  2. audioRef.current.src = ''        ← prevents stale ended-event firing
  3. abortAllPrefetches()
  4. pendingRef.current.clear()
  5. clearSentenceAudioCache()        ← safe now: src already cleared
  6. setCurrentSentenceIndex(-1)
  7. playSentence(0)
```

**Removing `synthesize()` and `audioBlobUrl`:**
- `synthesize()` is called only from the ↺ button — can be removed entirely.
- `audioBlobUrl` state feeds `<audio src={audioBlobUrl ?? undefined}>`. After removal, `src` is managed imperatively by `playSentence` only. The audio element's `src` attribute in JSX should be removed (just use `ref={audioRef}` with no `src` prop).
- `handlePlayPause` has a fallback: `if (!audioBlobUrl) { synthesize(); return; }` for when `sentences.length === 0`. **Remove that entire fallback branch.** Instead, disable the Play button while `sentences.length === 0` (sentences haven't loaded yet). Show `<Loader2>` spinner on the Play button when `sentences.length === 0 && !playerState.isLoading` — same visual as the existing loading state.

- Update button `title` to "Phát lại từ đầu"
- Keep the ↺ (`RefreshCw`) icon

---

## Change 3 — Fix Ambient Track Upload

**Problem:** `addTrack()` in `useAmbientPlayer.ts` fails silently in two cases:
1. `dbRef.current` is null (IndexedDB not yet ready) — logs a `console.warn` only
2. Blob MIME type is hardcoded to `audio/mpeg` regardless of the uploaded file's actual type

**Fix:**
- Replace `console.warn` with `toast.error(...)` when IndexedDB is not ready
- Use `file.type || 'audio/mpeg'` for the blob construction in `addTrack`
- Also add `mimeType` field to `IDBTrackRecord` interface and persist it in `putTrack`. Use stored mimeType when reconstructing blob URLs during the mount-time load from IndexedDB. This fixes the persistent MIME issue for non-MP3 files across sessions.
- Wrap the entire `addTrack` body in a try/catch, calling `toast.error` on any failure
- Add `uploading: boolean` to the `AmbientPlayerControls` interface returned by `useAmbientPlayer`. Manage it with `useState` inside the hook (`[uploading, setUploading]`), set before the try block, cleared in `finally`. Return it from the hook. `AmbientPlayer.tsx` reads `uploading` from the hook and uses it to disable the `+` button.

**Data flow (unchanged):**
`file → arrayBuffer → putTrack(IndexedDB) → createObjectURL → audio.src → play → setTracks`

---

## Change 4 — Sentence Navigation

All three navigation elements are driven by one action: `seekToSentence(index)`.
All three read from `sentenceQueue.currentSentenceIndex` — they are always in sync.
`seekToSentence` → `playSentence` → `setCurrentSentenceIndex` → writes `chapterProgress[url]` — per-chapter state preserved.

### 4A — Prev/Next Buttons

Two buttons added to the player control row, flanking the existing Play/Pause button:

```
[↺] [◀] [▶▶] [□]  ───────progress bar───────  S.16/51  [Tự chuyện]
```

- `◀` — `seekToSentence(currentSentenceIndex - 1)`, disabled when `currentSentenceIndex <= 0`
- `▶▶` — `seekToSentence(currentSentenceIndex + 1)`, disabled when `currentSentenceIndex >= sentences.length - 1`
- Use `SkipBack` / `SkipForward` from lucide-react (already imported in `AmbientPlayer`)

### 4B — Sentence-Aware Scrubber

Replace the existing audio-time progress bar click handler with a sentence-jump handler.

**Current:** `onClick` → `seekTo(e)` → seeks audio `currentTime` within current sentence
**New:** `onClick` → `handleScrubberClick(e)` → `seekToSentence(Math.floor(clickX / barWidth * sentences.length))`

**Bar fill:** `sentences.length <= 1 ? 100 : (currentSentenceIndex / (sentences.length - 1)) * 100`
instead of `(el.currentTime / el.duration) * 100%`

**Click handler:** `targetIdx = Math.min(sentences.length - 1, Math.floor(clickX / barWidth * sentences.length))` — clamped to avoid out-of-bounds.

**Hover tooltip:** A small `<span>` positioned at cursor X showing "Câu N" where N is the target sentence number (1-indexed). Shown via `onMouseMove`, hidden on `onMouseLeave`.

**Audio-time progress within a sentence:** Removed from this bar. The bar now represents chapter-level sentence position.

### 4C — Clickable Sentence Counter

**Current:** `S.16/51` is a static `<span>`
**New:** Clicking toggles to an inline `<input type="number">` overlay

Behavior:
- Click on "S.16/51" → input appears, pre-filled with `16`, selected
- Type a number (1–51), press Enter → `seekToSentence(Math.max(0, Math.min(sentences.length - 1, n - 1)))` — clamped, converts 1-indexed UX to 0-indexed store — input closes
- Press Escape or blur → input closes without jumping
- Input is clamped: values < 1 become 1, values > total become total
- State: `[editing, setEditing]` + `[inputVal, setInputVal]` local to TTSPlayer

---

## Sync Guarantee

All four of these are true simultaneously:
- `◀`/`▶▶` disabled states ← `currentSentenceIndex`
- Scrubber fill width ← `currentSentenceIndex / sentences.length`
- Scrubber tooltip ← mouse X position (local state)
- Counter text ("S.16/51") ← `currentSentenceIndex`
- Input value ← `currentSentenceIndex + 1`

One `seekToSentence(n)` call → store update → all re-render. No local desync possible.

---

## Out of Scope

- Backend changes
- Word-level highlighting (kept as-is)
- Ambient player track list management (delete, reorder)
- Mobile layout
