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
- Remove `speed` and `pitch` from the `useEffect` cache-invalidation deps array in `TTSPlayer.tsx` (they will never change so the effect is a no-op for those deps)
- Keep `speed` and `pitch` in `TTSSettings` type and store defaults (backend still accepts them; they just stay at `1.0`/`0.0`)

---

## Change 2 — Fix "Tổng hợp lại" → "Phát lại từ đầu"

**What:** The ↺ button currently calls `synthesize()`, which synthesizes the entire chapter as one audio blob. This sets `audioBlobUrl` while `sentenceQueue` is still populated, leaving the player in an inconsistent split state — the audio element has a new src but the sentence queue still holds old state.

**New behavior:** The button replays the chapter from sentence 0.

**Implementation in `TTSPlayer.tsx`:**
```
handleReplay():
  1. abortAllPrefetches()
  2. pendingRef.current.clear()
  3. clearSentenceAudioCache()
  4. setCurrentSentenceIndex(-1)   ← allows playSentence(0) to re-enter
  5. playSentence(0)
```

- Remove the `synthesize()` full-chapter function entirely (it is only called from this button)
- Remove `audioBlobUrl` state and its associated cleanup effect (no longer needed)
- Update button `title` to "Phát lại từ đầu"
- Keep the ↺ (`RefreshCw`) icon

---

## Change 3 — Fix Ambient Track Upload

**Problem:** `addTrack()` in `useAmbientPlayer.ts` fails silently in two cases:
1. `dbRef.current` is null (IndexedDB not yet ready) — logs a `console.warn` only
2. Blob MIME type is hardcoded to `audio/mpeg` regardless of the uploaded file's actual type

**Fix:**
- Replace `console.warn` with `toast.error('Không thể lưu nhạc nền: IndexedDB chưa sẵn sàng')`
- Use `file.type || 'audio/mpeg'` for the blob construction
- Wrap the entire `addTrack` body in a try/catch, showing `toast.error` on any failure
- Add a `[uploading, setUploading]` state to `AmbientPlayer.tsx` — disable the `+` button and show a spinner while upload is in progress

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

**Bar fill:** `(currentSentenceIndex / Math.max(sentences.length - 1, 1)) * 100%`
instead of `(el.currentTime / el.duration) * 100%`

**Hover tooltip:** A small `<span>` positioned at cursor X showing "Câu N" where N is the target sentence number (1-indexed). Shown via `onMouseMove`, hidden on `onMouseLeave`.

**Audio-time progress within a sentence:** Removed from this bar (the user never needed sub-sentence seeking). The bar now represents chapter-level position.

### 4C — Clickable Sentence Counter

**Current:** `S.16/51` is a static `<span>`
**New:** Clicking toggles to an inline `<input type="number">` overlay

Behavior:
- Click on "S.16/51" → input appears, pre-filled with `16`, selected
- Type a number (1–51), press Enter → `seekToSentence(n - 1)` (converts 1-indexed UX to 0-indexed store), input closes
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
