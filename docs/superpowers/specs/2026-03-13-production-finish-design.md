# AudioTruyen Production Finish — Design Spec
**Date:** 2026-03-13
**Branch:** feat/production-upgrade
**Approach:** B — Coherent state redesign

---

## Problem Statement

Eight issues block production readiness:
1. Novel and chapter state lost on page reload (TOC, chapter content, sentence position)
2. No real-time sentence highlighting during TTS playback
3. Chapter completion trigger broken (word-timing path never fires for sentence-mode playback)
4. Auto-advance does not load the next chapter
5. Progress not saved to Supabase on sentence advance (only on manual seek)
6. No Google OAuth in AuthModal
7. AudioVisualizer animates continuously even when audio is stopped
8. SettingsPanel: non-active provider config hidden; sliders lack visual context; panels not resizable

---

## Architecture

### Files Changed

| File | Change |
|---|---|
| `frontend/lib/store.ts` | Add top-level persisted `currentSentenceIndex: number`; extend `setCurrentSentenceIndex` to also write the persisted field; keep `sentenceQueue` fully excluded from `partialize` |
| `frontend/lib/hooks/useSyncProgress.ts` | Fix call signature; debounced upsert on every sentence advance; use correct DB column `is_finished` |
| `frontend/components/ReaderPanel.tsx` | Sentence-segment rendering + highlighting + auto-scroll + auto-advance; auto-resume trigger on mount |
| `frontend/components/TTSPlayer.tsx` | Fix `handleEnded` for last-sentence completion; keep `setPlaying(false)` and `setHighlightedWordIndex` |
| `frontend/components/AuthModal.tsx` | Google OAuth button with error handling |
| `frontend/components/AudioVisualizer.tsx` | Gate draw loop inside existing effect; do NOT change dependency array |
| `frontend/components/SettingsPanel.tsx` | Inline active-provider config for all 5 providers; slider end labels |
| `frontend/components/MainLayout.tsx` | `ResizableDivider` between sidebar↔reader; widths in `useState` + `localStorage` |
| `frontend/components/ResizableDivider.tsx` | New: drag-to-resize handle with full mousemove cleanup on unmount |

No backend changes required.

---

## Section 1: State & Persistence

### Zustand Store Changes (`store.ts`)

**Currently persisted:** `view`, `activeNovelId`, `savedNovels`, `finishedChapterUrls`, `ttsSettings`, `recordingState`
**Currently transient:** `toc`, `currentChapter`, `currentChapterUrl`, `sentenceQueue`

**Key constraint:** `sentenceQueue` contains `sentenceAbortControllers: Record<number, AbortController>` — `AbortController` is not JSON-serializable. `sentenceQueue` MUST remain fully excluded from `partialize`. Only a scalar is extracted.

**Changes (all in `store.ts`):**

**1. Add `currentSentenceIndex` and `currentChapterUrl` to initial state as top-level fields** (they currently exist only inside nested slices):
```typescript
// In the initial state object:
currentSentenceIndex: -1,   // NEW top-level field (persisted)
// currentChapterUrl already exists — confirm it is top-level, not nested
```

**2. Add both to `partialize`:**
```typescript
partialize: (state) => ({
  view: state.view,
  activeNovelId: state.activeNovelId,
  savedNovels: state.savedNovels,
  finishedChapterUrls: state.finishedChapterUrls,
  ttsSettings: state.ttsSettings,
  recordingState: { ... },
  currentChapterUrl: state.currentChapterUrl,   // ADD
  currentSentenceIndex: state.currentSentenceIndex,  // ADD
}),
```

**3. Extend `setCurrentSentenceIndex` to dual-write** (both the new persisted top-level field and the existing `sentenceQueue.currentSentenceIndex`):
```typescript
setCurrentSentenceIndex: (index: number) =>
  set((state) => ({
    currentSentenceIndex: index,  // persisted top-level
    sentenceQueue: { ...state.sentenceQueue, currentSentenceIndex: index },  // in-session
  })),
```
All existing call sites (`playSentence`, `handleStop`, `seekToSentence`) automatically persist via this single action change — no call site migration needed.

- `toc` is **not** duplicated — recovered from `savedNovels` on rehydrate:
  ```typescript
  const novel = savedNovels.find(n => n.id === activeNovelId)  // savedNovels is SavedNovel[]
  const toc = novel?.toc ?? null
  ```

### Auto-resume on Reload (`ReaderPanel` `useEffect` on mount)

```typescript
useEffect(() => {
  const { activeNovelId, currentChapterUrl, currentSentenceIndex, savedNovels } =
    useAppStore.getState()
  if (!activeNovelId || !currentChapterUrl) return

  const novel = savedNovels.find(n => n.id === activeNovelId)
  if (!novel) return

  setToc(novel.toc)
  setLoadingChapter(true)

  fetch(`${apiUrl}/api/scrape/chapter?url=${encodeURIComponent(currentChapterUrl)}`)
    .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
    .then(data => {
      setCurrentChapter(data)
      // sentenceQueue.currentSentenceIndex restored in TTSPlayer from persisted store field
    })
    .catch(err => {
      toast.error(`Không thể khôi phục chương: ${err}`)
      // Reset so user can navigate normally
      setCurrentChapterUrl(null)
    })
    .finally(() => setLoadingChapter(false))
}, []) // runs once on mount only
```

**Error path:** On fetch failure, `currentChapterUrl` is cleared and a toast is shown. The sidebar URL input is still populated so user can re-load manually.

**Render during re-fetch:** `loadingChapter: true` → ReaderPanel shows its existing loading spinner, not the empty state.

---

## Section 2: Real-time Sentence Highlighting

### Sentence Segment Builder

```typescript
interface SentenceSegment {
  text: string
  index: number      // index into sentenceQueue.sentences
  paraBreak: boolean // true if this sentence starts a new paragraph
}

function buildSentenceSegments(content: string, sentences: string[]): SentenceSegment[] {
  const paragraphs = content.split('\n').filter(p => p.trim())
  const result: SentenceSegment[] = []
  let sentIdx = 0
  let searchFrom = 0  // track position in content to avoid false indexOf matches

  for (const para of paragraphs) {
    const paraStart = content.indexOf(para, searchFrom)
    let isFirstInPara = true
    let paraOffset = paraStart

    while (sentIdx < sentences.length) {
      const sent = sentences[sentIdx].trim()
      const pos = content.indexOf(sent, paraOffset)
      // Stop if sentence is outside this paragraph
      if (pos === -1 || pos > paraStart + para.length) break

      result.push({ text: sentences[sentIdx], index: sentIdx, paraBreak: isFirstInPara })
      paraOffset = pos + sent.length
      searchFrom = paraOffset
      sentIdx++
      isFirstInPara = false
    }
  }

  // Any remaining unmatched sentences appended without paraBreak
  while (sentIdx < sentences.length) {
    result.push({ text: sentences[sentIdx], index: sentIdx, paraBreak: false })
    sentIdx++
  }

  return result
}
```

The `searchFrom` cursor prevents false matches when a short sentence appears multiple times in the chapter.

### Rendering

```tsx
// In ReaderPanel, replace word-by-word render when sentences are available:
{sentenceSegments.length > 0 ? (
  sentenceSegments.map((seg) => (
    <Fragment key={seg.index}>  {/* key on Fragment, not on span */}
      {seg.paraBreak && <div className="mt-[1em]" />}
      <span
        id={`sent-${seg.index}`}
        className={seg.index === currentSentenceIndex
          ? "bg-amber-400/20 text-amber-100 rounded px-0.5 transition-colors duration-200"
          : ""}
      >
        {seg.text}{" "}
      </span>
    </Fragment>
  ))
) : (
  // Existing word-by-word render (fallback when sentences not loaded)
  ...
)}
```

### Auto-scroll

```typescript
const highlightRef = useRef<HTMLSpanElement | null>(null)

useEffect(() => {
  if (currentSentenceIndex < 0) return
  document.getElementById(`sent-${currentSentenceIndex}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}, [currentSentenceIndex])
```

---

## Section 3: Chapter Completion & Auto-advance

### Fix `handleEnded` in TTSPlayer

The current `handleEnded` already has correct logic for `isLastSentence`. The fix is additive only — ensure `setPlaying(false)` and `setHighlightedWordIndex` are NOT removed:

```typescript
// Existing code to KEEP:
setPlaying(false)
setProgress(0)
if (wordTimings.length > 0) {
  setHighlightedWordIndex(wordTimings.length - 1)
}

// Add: sentence-mode completion (replaces the existing 90%-word-timing heuristic)
const isInSentenceMode = sentences.length > 0 && currentSentenceIndex >= 0
const isLastSentence = currentSentenceIndex >= sentences.length - 1
if (isInSentenceMode && isLastSentence && !markedFinishedRef.current) {
  markedFinishedRef.current = true
  markChapterFinished(chapterUrl)
}

// Existing: auto-advance fires here
onEnded?.()
```

### Auto-advance in `ReaderPanel`

```typescript
const handleChapterEnded = useCallback(() => {
  if (!playerState.autoAdvance || !currentChapter?.next_url) return
  setTimeout(() => {
    loadChapter(currentChapter.next_url, currentChapter.next_title ?? 'Chương sau')
  }, 800)
}, [playerState.autoAdvance, currentChapter, loadChapter])

// Pass to TTSPlayer:
<TTSPlayer ... onEnded={handleChapterEnded} />
```

---

## Section 4: Supabase Progress Sync

### `useSyncProgress` Changes

**Current hook signature:**
```typescript
(chapterUrl: string, sentenceIndex: number, wordIndex: number, isFinished: boolean)
```
**Current DB column:** `is_finished` (not `finished`)

**Fix — call site in TTSPlayer after `setCurrentSentenceIndex(index)`:**
```typescript
const isFinished = index >= sentences.length - 1
syncProgress(chapterUrl, index, -1, isFinished)  // wordIndex unused in sentence mode → -1
```

**Fix — debounce inside `useSyncProgress`:**
```typescript
// Replace the current on-seek-only call with a debounced version
const debouncedSync = useMemo(
  () => debounce(async (chapterUrl, sentenceIndex, wordIndex, isFinished) => {
    if (!userId) return
    await supabase.from('reading_progress').upsert({
      user_id: userId,
      chapter_url: chapterUrl,
      sentence_index: sentenceIndex,
      is_finished: isFinished,
      updated_at: new Date().toISOString(),
    })
  }, 1000),   // matches existing useSyncProgress debounce delay
  [userId]
)
```

**Schema addition needed** (run once in Supabase SQL editor):
```sql
ALTER TABLE reading_progress
  ADD COLUMN IF NOT EXISTS is_finished boolean DEFAULT false;
```

---

## Section 5: Google OAuth

### `AuthModal.tsx` Addition

```typescript
const handleGoogleLogin = async () => {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) throw error
  } catch (e: unknown) {
    toast.error(`Google login thất bại: ${e instanceof Error ? e.message : 'Lỗi không xác định'}`)
  }
}
```

**UI:** Google button rendered above the email/password form with an "hoặc" (or) divider.

**Prerequisite (manual step):** Google OAuth provider must be enabled in the Supabase dashboard (Authentication → Providers → Google → enable, add Google Client ID + Secret from Google Cloud Console). If not configured, the button shows a toast error. This is a one-time dashboard config, not a code change.

---

## Section 6: AudioVisualizer Fix

### Current Problem

`AudioVisualizer.tsx` uses `requestAnimationFrame` inside a `draw()` loop. The loop runs unconditionally because the existing `useEffect` starts it on mount and never cancels based on `isPlaying`.

### Fix — Gate the draw loop, NOT the effect dependency array

Do **not** change the `useEffect` dependency array (it depends on `audioElement` to set up `MediaElementAudioSourceNode` — changing deps would cause reconnection errors). Instead, gate the `draw()` loop itself:

```typescript
// Inside the existing draw() function:
const draw = () => {
  if (!isPlayingRef.current) {
    // Render idle bars (flat, low amplitude)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < barCount; i++) {
      ctx.fillStyle = 'rgba(139, 92, 246, 0.3)'  // indigo-500 at 30% opacity
      ctx.fillRect(x, canvas.height * 0.85, barWidth - 1, canvas.height * 0.03)
      x += barWidth + gap
    }
    rafRef.current = requestAnimationFrame(draw)
    return
  }
  // ... existing live bar rendering ...
}
```

Use a `isPlayingRef = useRef(isPlaying)` updated in a separate `useEffect([isPlaying])` to avoid stale closure issues inside the rAF loop.

---

## Section 7: SettingsPanel Redesign

### Active-Provider Inline Config (all 5 providers)

Each provider radio row conditionally renders its config section when `ttsSettings.preferredProvider === p.value`. This replaces the current `CollapsibleSection` pattern for provider-specific fields.

**All 5 providers and their inline fields:**
- **Gemini:** voice dropdown + `GeminiCredentialsUploader` (existing component)
- **OpenAI:** API key input + voice dropdown
- **MiniMax:** API key input + Group ID input + voice dropdown
- **XTTS:** endpoint URL input
- **Google Translate:** no fields (show "Không cần cấu hình" note)

### Slider End Labels

```tsx
<div className="flex justify-between text-xs text-gray-600 mt-0.5">
  <span>0.5×</span>
  <span>2.0×</span>
</div>
```

---

## Section 8: Resizable Panels

### `ResizableDivider` Component

```typescript
// frontend/components/ResizableDivider.tsx
export default function ResizableDivider({ onResize }: { onResize: (dx: number) => void }) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => onResize(ev.movementX)
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1 cursor-col-resize bg-gray-800 hover:bg-indigo-500 transition-colors flex-shrink-0 select-none"
    />
  )
}
```

The `mouseup` listener is always cleaned up — both on release and implicitly on component unmount via the closure (the `onUp` reference is stable per drag session).

### Integration in `MainLayout`

```typescript
// Widths via useState + localStorage (no external hook needed)
const [sidebarWidth, setSidebarWidth] = useState(() => {
  if (typeof window === 'undefined') return 260
  return parseInt(localStorage.getItem('sidebar-width') ?? '260', 10)
})

useEffect(() => {
  localStorage.setItem('sidebar-width', String(sidebarWidth))
}, [sidebarWidth])

// In JSX:
<div style={{ width: sidebarWidth, flexShrink: 0 }}>
  <ChapterSidebar />
</div>
<ResizableDivider onResize={(dx) =>
  setSidebarWidth(w => Math.min(420, Math.max(160, w + dx)))
} />
<main className="flex-1 min-w-0">  {/* min-w-0 prevents flex overflow */}
  <ReaderPanel />
</main>
```

Width constraints: sidebar 160–420px. No `useLocalStorageState` dependency — plain `useState` + `useEffect`.

---

## Implementation Order

Ordered to avoid broken intermediate states:

1. **#27** Fix AudioVisualizer idle state (isolated, zero risk)
2. **#28** Redesign SettingsPanel (isolated UI, all 5 providers)
3. **#22** Persist `currentSentenceIndex` + auto-resume (foundation for #23, #24, #25)
4. **#26** Add Google OAuth (isolated, single button — after persist so resume works after OAuth redirect)
5. **#23** Sentence highlighting in ReaderPanel (depends on #22 for segment building on resume)
6. **#24** Chapter completion + auto-advance (depends on #23 for last-sentence detection)
7. **#25** Supabase progress sync with correct signature (depends on #22, #24)
8. **#29** Resizable panels (isolated layout, no state dependencies)

---

## Non-Goals

- Audio caching / offline audio playback
- Cross-device library sync (Supabase `saved_novels` table)
- Word-level highlighting within sentences (Gemini v2.x removed TimepointType API)
- MiniMax voice preview
- Any backend changes
