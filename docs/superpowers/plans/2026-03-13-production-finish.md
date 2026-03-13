# AudioTruyen Production Finish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 production blockers: AudioVisualizer idle animation, SettingsPanel layout, state persistence + auto-resume, Google OAuth, sentence highlighting, chapter completion + auto-advance, Supabase progress sync, and resizable panels.

**Architecture:** All changes are frontend-only. Foundation is extending Zustand's `partialize` to persist `currentChapterUrl` and `currentSentenceIndex`, enabling silent auto-resume on reload. Sentence highlighting replaces word-by-word rendering with sentence-segment rendering when the TTS sentence queue is loaded. Other tasks are isolated component fixes.

**Tech Stack:** Next.js 16, React 19, TypeScript, Zustand 5 (persist middleware), Supabase JS v2, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-03-13-production-finish-design.md`

---

## Chunk 1: Isolated UI Fixes (Tasks #27, #28)

### Task #27: Fix AudioVisualizer — static idle bars

**Files:**
- Modify: `frontend/components/AudioVisualizer.tsx`

The component already accepts `isPlaying: boolean` and has an idle fallback, but the idle fallback is an animated sine-wave that runs continuously. Fix: replace the animated sine-wave with flat static bars when `!isPlaying`.

- [ ] **Step 1: Locate the idle animation block**

Open `frontend/components/AudioVisualizer.tsx`. Find the block inside the `draw()` function that handles `!isPlaying || avg < 0.01`. It looks like:
```typescript
if (!isPlaying || avg < 0.01) {
  // draws bars with: 3 + 2 * Math.sin(idleTime + i * 0.4)
  idleTime = (idleTime + 0.04) % (Math.PI * 2)
  rafRef.current = requestAnimationFrame(draw)
  return
}
```

- [ ] **Step 2: Replace animated sine-wave with flat static bars**

Replace the idle block with:
```typescript
if (!isPlaying || avg < 0.01) {
  ctx.clearRect(0, 0, W, H)
  let x = 0
  for (let i = 0; i < BAR_COUNT; i++) {
    ctx.fillStyle = 'rgba(139, 92, 246, 0.25)'
    ctx.beginPath()
    ctx.roundRect(x, H - 3, barW, 3, 1)
    ctx.fill()
    x += barW + gap
  }
  rafRef.current = requestAnimationFrame(draw)
  return
}
```
The `idleTime` variable and its increment can be removed entirely (it is no longer used).

- [ ] **Step 3: Remove the `idleTimeRef` variable declaration**

Find `const idleTimeRef = useRef(0)` near the top of the component (around line 23) and delete it. Also remove any remaining references to `idleTimeRef` (e.g. `idleTimeRef.current += 0.04`).

- [ ] **Step 4: Verify**

Run `cd frontend && npm run dev`. Load the app:
- Before pressing Play: bars are flat 3px lines, completely static
- After pressing Play: bars animate with audio frequency data
- After pressing Stop/Pause: bars return to flat immediately

- [ ] **Step 5: Commit**
```bash
git add frontend/components/AudioVisualizer.tsx
git commit -m "fix(visualizer): static idle bars — no animation when not playing"
```

---

### Task #28: Redesign SettingsPanel — inline active-provider config + slider labels

**Files:**
- Modify: `frontend/components/SettingsPanel.tsx`

Current: provider-specific config lives in separate `CollapsibleSection` blocks below all radio buttons. New: config renders inline under its radio button only when that provider is selected.

- [ ] **Step 1: Add `ProviderConfig` helper component**

Add this component just above the `export default function SettingsPanel()` declaration in `frontend/components/SettingsPanel.tsx`:

```typescript
function ProviderConfig({
  provider, ttsSettings, sl, credentialsStatus,
}: {
  provider: TTSProvider
  ttsSettings: ReturnType<typeof useAppStore>['ttsSettings']
  sl: (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void
  credentialsStatus: CredStatus
}) {
  switch (provider) {
    case 'gemini':
      return (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Giọng</label>
            <select
              value={ttsSettings.geminiVoice}
              onChange={sl('geminiVoice')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
            >
              {GEMINI_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <GeminiCredentialsUploader />
        </div>
      )
    case 'openai':
      return (
        <div className="mt-3 flex flex-col gap-2">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">API Key</label>
            <input
              type="password" value={ttsSettings.openaiApiKey} onChange={sl('openaiApiKey')}
              placeholder="sk-..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Giọng</label>
            <select
              value={ttsSettings.openaiVoice} onChange={sl('openaiVoice')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
            >
              {OPENAI_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>
      )
    case 'minimax':
      return (
        <div className="mt-3 flex flex-col gap-2">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">API Key</label>
            <input
              type="password" value={ttsSettings.minimaxApiKey} onChange={sl('minimaxApiKey')}
              placeholder="MiniMax API key"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Group ID</label>
            <input
              type="text" value={ttsSettings.minimaxGroupId} onChange={sl('minimaxGroupId')}
              placeholder="MiniMax Group ID"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Giọng</label>
            <select
              value={ttsSettings.minimaxVoiceId} onChange={sl('minimaxVoiceId')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
            >
              {MINIMAX_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>
      )
    case 'xtts':
      return (
        <div className="mt-3">
          <label className="text-xs text-gray-500 mb-1 block">Endpoint URL</label>
          <input
            type="url" value={ttsSettings.xttsEndpoint} onChange={sl('xttsEndpoint')}
            placeholder="http://localhost:5002"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
          />
        </div>
      )
    case 'gtranslate':
      return (
        <p className="mt-2 text-xs text-gray-600 italic">
          Không cần cấu hình — dùng làm dự phòng cuối cùng
        </p>
      )
    default:
      return null
  }
}
```

Note: `ProviderConfig` uses the same `sl` handler already defined in `SettingsPanel`. Pass `credentialsStatus` as a prop (read from the existing `useState` in `SettingsPanel`).

- [ ] **Step 2: Replace provider radio section with inline-expansion pattern**

In `SettingsPanel`, replace the existing provider `<section>` (the `PROVIDERS.map(...)` block) with:

```typescript
<section>
  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
    Nhà cung cấp TTS
  </h3>
  <div className="flex flex-col gap-2">
    {PROVIDERS.map((p) => {
      const isActive = ttsSettings.preferredProvider === p.value
      return (
        <div
          key={p.value}
          className={`rounded-lg border p-3 transition-colors ${
            isActive ? 'border-indigo-500 bg-indigo-600/10' : 'border-gray-700 hover:border-gray-600'
          }`}
        >
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="provider"
              value={p.value}
              checked={isActive}
              onChange={() => updateTTSSettings({ preferredProvider: p.value })}
              className="mt-0.5 accent-indigo-500"
            />
            <div>
              <p className="text-sm font-medium text-white">{p.label}</p>
              <p className="text-xs text-gray-500">{p.description}</p>
            </div>
          </label>
          {isActive && (
            <ProviderConfig
              provider={p.value}
              ttsSettings={ttsSettings}
              sl={sl}
              credentialsStatus={credentialsStatus}
            />
          )}
        </div>
      )
    })}
  </div>
</section>
```

- [ ] **Step 3: Remove the old standalone Gemini/OpenAI/MiniMax/XTTS sections**

Delete these sections from `SettingsPanel` (they are now rendered inside `ProviderConfig`):
- The `<section>` containing the Gemini voice dropdown + `CollapsibleSection` for credentials (around lines 326–348)
- The `<CollapsibleSection title="OpenAI API Key">` block
- The `<CollapsibleSection title="MiniMax API Key">` block
- The `<CollapsibleSection title="Local XTTS Server">` block

- [ ] **Step 4: Add slider end labels to Speed and Pitch sliders**

In the Speed & Pitch section, add end labels below each `<input type="range">`:

```typescript
{/* Speed */}
<div>
  <div className="flex justify-between mb-1">
    <label className="text-sm text-gray-300">Tốc độ đọc</label>
    <span className="text-sm text-indigo-400 font-mono">{ttsSettings.speed.toFixed(1)}×</span>
  </div>
  <input type="range" min="0.5" max="2.0" step="0.1"
    value={ttsSettings.speed} onChange={slNum('speed')}
    className="w-full accent-indigo-500" />
  <div className="flex justify-between mt-0.5">
    <span className="text-xs text-gray-600">0.5×</span>
    <span className="text-xs text-gray-600">2.0×</span>
  </div>
</div>

{/* Pitch */}
<div>
  <div className="flex justify-between mb-1">
    <label className="text-sm text-gray-300">Cao độ (Gemini)</label>
    <span className="text-sm text-indigo-400 font-mono">{ttsSettings.pitch.toFixed(1)}</span>
  </div>
  <input type="range" min="-10" max="10" step="0.5"
    value={ttsSettings.pitch} onChange={slNum('pitch')}
    className="w-full accent-indigo-500" />
  <div className="flex justify-between mt-0.5">
    <span className="text-xs text-gray-600">–10</span>
    <span className="text-xs text-gray-600">+10</span>
  </div>
</div>
```

- [ ] **Step 5: Verify**

Open Settings panel. For each provider:
- Select Gemini → voice dropdown + credentials section appears below its row
- Select OpenAI → API key + voice appears below its row; Gemini config collapses
- Select MiniMax → API key + Group ID + voice appears
- Select XTTS → endpoint URL appears
- Select Google Translate → "Không cần cấu hình" note appears
- Speed slider shows `0.5×` / `2.0×` labels; Pitch shows `–10` / `+10`

- [ ] **Step 6: Commit**
```bash
git add frontend/components/SettingsPanel.tsx
git commit -m "feat(settings): inline active-provider config + slider end labels"
```

---

## Chunk 2: State Persistence + Auto-resume (Task #22)

### Task #22: Persist currentChapterUrl + currentSentenceIndex; auto-resume on reload

**Files:**
- Modify: `frontend/lib/store.ts`
- Modify: `frontend/components/ReaderPanel.tsx`
- Modify: `frontend/components/TTSPlayer.tsx`

This is the foundation for Tasks #23, #24, #25 — implement this before those.

- [ ] **Step 1: Add top-level `currentSentenceIndex` to store initial state**

In `frontend/lib/store.ts`, in the initial state object (around line 105), add a new top-level field:
```typescript
// Add BEFORE the sentenceQueue definition:
currentSentenceIndex: -1 as number,
```
This is separate from `sentenceQueue.currentSentenceIndex` (which stays for in-session use).

- [ ] **Step 2: Add `currentChapterUrl` and `currentSentenceIndex` to `partialize`**

In `frontend/lib/store.ts`, update the `partialize` config (lines ~356–368):
```typescript
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
  currentChapterUrl: state.currentChapterUrl,       // ADD
  currentSentenceIndex: state.currentSentenceIndex, // ADD
}),
```

- [ ] **Step 3: Extend `setCurrentSentenceIndex` to dual-write**

In `frontend/lib/store.ts`, find `setCurrentSentenceIndex` (around line 300):
```typescript
// BEFORE:
setCurrentSentenceIndex: (index: number) =>
  set((state) => ({
    sentenceQueue: { ...state.sentenceQueue, currentSentenceIndex: index },
  })),

// AFTER:
setCurrentSentenceIndex: (index: number) =>
  set((state) => ({
    currentSentenceIndex: index,  // persisted top-level
    sentenceQueue: { ...state.sentenceQueue, currentSentenceIndex: index },
  })),
```

All existing call sites (`playSentence`, `handleStop`, `seekToSentence`) automatically persist via this single change — no other call sites need updating.

- [ ] **Step 4: Add `currentSentenceIndex` to the state type**

The state field needs to be declared in the type system. In `frontend/lib/store.ts`, find the `AppStore` interface (around line 43). Add:
```typescript
currentSentenceIndex: number
```
alongside the existing state fields (near `activeNovelId`, `savedNovels`, etc.).

If the codebase uses a separate `AppState` type in `frontend/lib/types.ts` for state fields (check both files), add `currentSentenceIndex: number` to whichever file defines the state shape — not the actions. This prevents TypeScript errors when `set({ currentSentenceIndex: index })` is called in Step 3.

- [ ] **Step 5: Add auto-resume effect to ReaderPanel**

In `frontend/components/ReaderPanel.tsx`, add these imports if not already present:
```typescript
import { toast } from 'react-toastify'
```

Add these selectors alongside existing ones:
```typescript
const { setToc, setLoadingChapter, setCurrentChapter, setCurrentChapterUrl } = useAppStore()
```

Add this `useEffect` after the existing effects (around line 60):
```typescript
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

// Auto-resume: restore chapter from persisted state on page reload
useEffect(() => {
  const state = useAppStore.getState()
  const { activeNovelId, currentChapterUrl, savedNovels, currentChapter } = state
  if (!activeNovelId || !currentChapterUrl) return
  if (currentChapter) return  // already loaded in this session

  const novel = savedNovels.find((n) => n.id === activeNovelId)
  if (!novel) return

  setToc(novel.toc)
  setLoadingChapter(true)
  fetch(`${apiUrl}/api/scrape/chapter?url=${encodeURIComponent(currentChapterUrl)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
    .then((data) => { setCurrentChapter(data) })
    .catch((err) => {
      toast.error(`Không thể khôi phục chương: ${err}`)
      setCurrentChapterUrl(null)
    })
    .finally(() => setLoadingChapter(false))
}, []) // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 6: Restore sentence index in TTSPlayer after sentence split**

In `frontend/components/TTSPlayer.tsx`, in the `fetchSentences` effect (around line 90), after `setSentences(data.sentences)`:
```typescript
// After setSentences(data.sentences):
const persistedIndex = useAppStore.getState().currentSentenceIndex
if (persistedIndex > 0 && persistedIndex < data.sentences.length) {
  setResumeFromIndex(persistedIndex)
}
```

- [ ] **Step 7: Test auto-resume**

1. Load the app, load any novel (e.g. `https://truyenplus.vn/...`)
2. Navigate to Chapter 3
3. Press Play, let it reach sentence 5+
4. Hard-refresh the page (Ctrl+Shift+R)
5. Expected: app opens on Chapter 3 (not blank home screen), resume toast shows "Tiếp tục từ câu N?"
6. Expected: clicking "Tiếp tục" starts playback from the saved sentence

- [ ] **Step 8: Commit**
```bash
git add frontend/lib/store.ts frontend/components/ReaderPanel.tsx frontend/components/TTSPlayer.tsx
git commit -m "feat(persistence): persist currentChapterUrl + sentenceIndex; auto-resume on reload"
```

---

## Chunk 3: Auth + Sentence Highlighting (Tasks #26, #23)

### Task #26: Verify Google OAuth button in AuthModal

**Files:**
- Verify: `frontend/components/AuthModal.tsx`

The `handleGoogleAuth` function already exists (lines 56–69) AND the button is already wired in JSX (around line 81). This task is a verification-only step.

- [ ] **Step 1: Verify in browser**

Open the Auth modal (`Đăng nhập` button in top-right). Confirm:
- Google "Tiếp tục với Google" button is visible
- "hoặc" divider separates it from the email/password form
- Clicking Google button either redirects to Google OAuth or shows a clear error

**Note:** For Google OAuth to actually work, enable it in Supabase Dashboard → Authentication → Providers → Google (requires Google Cloud OAuth Client ID + Secret from Google Cloud Console). The code is already correct — this is a one-time dashboard configuration.

- [ ] **Step 2: Commit (no-op if no changes were needed)**
```bash
# Only commit if any changes were made to AuthModal.tsx
git status frontend/components/AuthModal.tsx
# If clean: no commit needed — mark task #26 complete
```

---

### Task #23: Real-time sentence highlighting in ReaderPanel

**Files:**
- Modify: `frontend/components/ReaderPanel.tsx`

Depends on Task #22 (sentenceQueue populates after chapter loads via auto-resume).

- [ ] **Step 1: Verify and add missing imports**

In `frontend/components/ReaderPanel.tsx` (line 3), the current imports are:
```typescript
import { useRef, useEffect, useCallback, useState } from "react"
```
Update to add `useMemo` and `Fragment`:
```typescript
import { useRef, useEffect, useCallback, useState, useMemo, Fragment } from "react"
```

- [ ] **Step 2: Add `SentenceSegment` interface and `buildSentenceSegments` helper**

Add after the existing `splitToWords` function:
```typescript
interface SentenceSegment {
  text: string
  index: number
  paraBreak: boolean
}

function buildSentenceSegments(content: string, sentences: string[]): SentenceSegment[] {
  if (!sentences.length) return []
  const paragraphs = content.split('\n').filter((p) => p.trim())
  const result: SentenceSegment[] = []
  let sentIdx = 0
  let searchFrom = 0

  for (const para of paragraphs) {
    const paraStart = content.indexOf(para, searchFrom)
    if (paraStart === -1) continue
    let isFirstInPara = true
    let paraOffset = paraStart

    while (sentIdx < sentences.length) {
      const sent = sentences[sentIdx].trim()
      const pos = content.indexOf(sent, paraOffset)
      if (pos === -1 || pos > paraStart + para.length) break
      result.push({ text: sentences[sentIdx], index: sentIdx, paraBreak: isFirstInPara })
      paraOffset = pos + sent.length
      searchFrom = paraOffset
      sentIdx++
      isFirstInPara = false
    }
  }

  // Append unmatched sentences (handles edge cases)
  while (sentIdx < sentences.length) {
    result.push({ text: sentences[sentIdx], index: sentIdx, paraBreak: false })
    sentIdx++
  }

  return result
}
```

- [ ] **Step 3: Add sentence queue selectors**

In the component body, add alongside existing `useAppStore` selectors:
```typescript
const { sentences, currentSentenceIndex: activeSentenceIdx } = useAppStore(
  (s) => s.sentenceQueue
)
```

- [ ] **Step 4: Build segments with `useMemo`**

Add after the selectors:
```typescript
const sentenceSegments = useMemo(
  () =>
    currentChapter?.content
      ? buildSentenceSegments(currentChapter.content, sentences)
      : [],
  [currentChapter?.content, sentences]
)
```

- [ ] **Step 5: Add auto-scroll effect**

Add after the existing effects:
```typescript
useEffect(() => {
  if (activeSentenceIdx < 0) return
  document.getElementById(`sent-${activeSentenceIdx}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}, [activeSentenceIdx])
```

- [ ] **Step 6: Replace the chapter content render**

Find the content area where `splitToWords(currentChapter.content).map(...)` renders. Replace the entire content render with a conditional:

```typescript
<div className="max-w-[72ch] mx-auto text-[1.25rem] leading-[1.85]">
  {sentenceSegments.length > 0 ? (
    // Sentence-level render when TTS sentence queue is loaded
    sentenceSegments.map((seg) => (
      <Fragment key={seg.index}>
        {seg.paraBreak && seg.index > 0 && <div className="mt-[1em]" />}
        <span
          id={`sent-${seg.index}`}
          className={
            seg.index === activeSentenceIdx
              ? 'bg-amber-400/20 text-amber-100 rounded px-0.5 transition-colors duration-200'
              : 'transition-colors duration-200'
          }
        >
          {seg.text}{' '}
        </span>
      </Fragment>
    ))
  ) : (
    // Word-level render fallback when sentences haven't loaded yet
    splitToWords(currentChapter.content).map(({ word, paraBreakBefore, globalIndex }) => (
      <Fragment key={globalIndex}>
        {paraBreakBefore && <div className="mt-[1em]" />}
        <span
          className={
            globalIndex === playerState.highlightedWordIndex
              ? 'bg-amber-300 underline decoration-amber-400'
              : ''
          }
        >
          {word}{' '}
        </span>
      </Fragment>
    ))
  )}
</div>
```

- [ ] **Step 7: Test sentence highlighting**

1. Load a chapter, press Play
2. Confirm: the first sentence lights up amber as it plays
3. Confirm: the page smoothly scrolls to keep the current sentence centered
4. Let multiple sentences play; confirm each one highlights in turn
5. Press Stop; confirm highlight stays on last sentence played
6. Hard-reload; confirm chapter restores; no highlight shown until Play pressed

- [ ] **Step 8: Commit**
```bash
git add frontend/components/ReaderPanel.tsx
git commit -m "feat(reader): real-time sentence highlighting with auto-scroll"
```

---

## Chunk 4: Completion, Sync, Panels (Tasks #24, #25, #29)

### Task #24: Chapter completion via last sentence + auto-advance

**Files:**
- Modify: `frontend/components/TTSPlayer.tsx`
- Modify: `frontend/components/ReaderPanel.tsx`

- [ ] **Step 1: Verify auto-advance is already wired**

Read `frontend/components/ReaderPanel.tsx` around line 140. Confirm `<TTSPlayer>` already receives an `onEnded` prop with auto-advance logic:
```typescript
// Should already exist:
onEnded={() => {
  if (autoAdvance && currentChapter.next_url) {
    navigateTo(currentChapter.next_url)
  }
}}
```
Also confirm `handleEnded` in `TTSPlayer.tsx` (around line 418) calls `onEnded?.()` and `markChapterFinished` in the fall-through block.

**If already correct:** skip to Step 3.

**If `markChapterFinished` is missing or gated on word-timing only:** update the fall-through block to unconditionally mark finished:
```typescript
if (!markedFinishedRef.current) {
  markedFinishedRef.current = true
  markChapterFinished(chapterUrl)
}
onEnded?.()
```

- [ ] **Step 2: Add 800ms delay to auto-advance (optional polish)**

If the existing auto-advance fires instantly (no delay), wrap it in `setTimeout(..., 800)` so users see the chapter completion before content changes:
```typescript
onEnded={() => {
  if (autoAdvance && currentChapter.next_url) {
    setTimeout(() => navigateTo(currentChapter.next_url), 800)
  }
}}
```

- [ ] **Step 3: Test auto-advance**

1. Load a chapter, enable "Tự chuyển" toggle in player
2. Let playback reach the last sentence and audio end
3. Confirm: next chapter loads (after ~800ms delay)
4. Confirm: previous chapter is marked with ✓ in sidebar chapter list
5. Disable "Tự chuyển", play to end → confirm no auto-advance

- [ ] **Step 4: Commit (only if changes were made)**
```bash
git add frontend/components/TTSPlayer.tsx frontend/components/ReaderPanel.tsx
git commit -m "feat(player): chapter completion via last sentence + auto-advance"
```

---

### Task #25: Supabase progress sync on every sentence advance

**Files:**
- Modify: `frontend/components/TTSPlayer.tsx`
- Modify: `frontend/lib/hooks/useSyncProgress.ts`

- [ ] **Step 1: Import and call `useSyncProgress` in TTSPlayer**

In `frontend/components/TTSPlayer.tsx`, add the import:
```typescript
import { useSyncProgress } from '@/lib/hooks/useSyncProgress'
```

Add in the component body (near other hooks):
```typescript
const syncProgress = useSyncProgress()
```

- [ ] **Step 2: Call `syncProgress` inside `playSentence`**

In `playSentence` (around line 198), after `setPlaying(true)`:
```typescript
// After setPlaying(true):
const totalSentences = useAppStore.getState().sentenceQueue.sentences.length
const isFinished = index >= totalSentences - 1
syncProgress(chapterUrl, index, -1, isFinished)
```

Add `syncProgress` and `chapterUrl` to the `useCallback` deps array:
```typescript
[synthesizeSentence, setCurrentSentenceIndex, setPlaying, evictSentenceAudio, syncProgress, chapterUrl]
```

- [ ] **Step 3: Confirm debounce delay in useSyncProgress**

Open `frontend/lib/hooks/useSyncProgress.ts`. Confirm the debounce is `1000` ms. If it differs, update it to `1000`.

- [ ] **Step 4: Add `is_finished` column to Supabase (manual one-time step)**

Run in Supabase SQL Editor (Dashboard → SQL Editor → New query):
```sql
ALTER TABLE reading_progress
  ADD COLUMN IF NOT EXISTS is_finished boolean DEFAULT false;
```

Add a comment at the top of `useSyncProgress.ts` documenting the schema:
```typescript
// Schema: reading_progress(user_id, chapter_url, sentence_index, word_index, is_finished, updated_at)
// Migration: ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS is_finished boolean DEFAULT false;
```

- [ ] **Step 5: Test Supabase sync**

1. Log in (email or Google OAuth)
2. Load a chapter, press Play, let 3+ sentences advance
3. Open Supabase Dashboard → Table Editor → `reading_progress`
4. Confirm: row exists for the chapter with `sentence_index` matching current position
5. Let more sentences play → confirm `sentence_index` updates within ~1s
6. Hard-reload → confirm resume toast shows the correct sentence number

- [ ] **Step 6: Commit**
```bash
git add frontend/components/TTSPlayer.tsx frontend/lib/hooks/useSyncProgress.ts
git commit -m "feat(sync): save sentence progress to Supabase on every sentence advance (debounced 1s)"
```

---

### Task #29: Resizable sidebar panel

**Files:**
- Create: `frontend/components/ResizableDivider.tsx`
- Modify: `frontend/components/MainLayout.tsx`

- [ ] **Step 1: Create `ResizableDivider` component**

Create `frontend/components/ResizableDivider.tsx`:
```typescript
'use client'

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
      className="w-1 flex-shrink-0 cursor-col-resize bg-gray-800 hover:bg-indigo-500 active:bg-indigo-400 transition-colors select-none"
      title="Kéo để thay đổi kích thước"
    />
  )
}
```

- [ ] **Step 2: Fix sidebar width state in `MainLayout`**

`MainLayout.tsx` already declares `const [sidebarWidth] = useState(320)` (line 16) — but the setter is missing and there's no localStorage persistence.

Replace that line with:
```typescript
const [sidebarWidth, setSidebarWidth] = useState(() => {
  if (typeof window === 'undefined') return 260
  return parseInt(localStorage.getItem('sidebar-width') ?? '260', 10)
})
```

Add `useEffect` for persistence (after the existing hooks, before the return):
```typescript
useEffect(() => {
  localStorage.setItem('sidebar-width', String(sidebarWidth))
}, [sidebarWidth])
```

Add `useEffect` to the React import at the top of `MainLayout.tsx` if it's not already there:
```typescript
import { useState, useEffect } from 'react'  // add useEffect
```

Also add the import for `ResizableDivider`:
```typescript
import ResizableDivider from './ResizableDivider'
```

- [ ] **Step 3: Replace fixed-width sidebar with dynamic width + divider**

In `MainLayout`'s JSX, find the sidebar `<div className="w-80 ...">` (fixed 320px). Replace:
```typescript
// BEFORE:
<div className="w-80 border-r border-gray-800 flex flex-col overflow-hidden">
  <ChapterSidebar />
</div>
<main className="flex-1 ...">

// AFTER:
<div
  style={{ width: sidebarWidth, flexShrink: 0 }}
  className="border-r border-gray-800 flex flex-col overflow-hidden"
>
  <ChapterSidebar />
</div>
<ResizableDivider
  onResize={(dx) => setSidebarWidth((w) => Math.min(420, Math.max(160, w + dx)))}
/>
<main className="flex-1 min-w-0 flex flex-col overflow-hidden">
  {/* existing content */}
</main>
```

`min-w-0` on `<main>` prevents flex overflow — critical for layout correctness.

- [ ] **Step 4: Test resize**

1. Load the app
2. Hover over the border between sidebar and reader — cursor shows `col-resize`
3. Drag left: sidebar shrinks, min 160px (cannot go narrower)
4. Drag right: sidebar grows, max 420px (cannot go wider)
5. Hard-reload: sidebar width is restored to dragged size
6. Confirm reader content area reflows correctly at all widths

- [ ] **Step 5: Commit**
```bash
git add frontend/components/ResizableDivider.tsx frontend/components/MainLayout.tsx
git commit -m "feat(layout): draggable sidebar resize with localStorage persistence"
```

---

## Final: Push and PR

- [ ] **Push branch and open PR**
```bash
git push -u origin feat/production-upgrade
gh pr create \
  --title "feat: production finish — 8 UX + persistence blockers" \
  --body "$(cat <<'EOF'
## Summary
- Fix AudioVisualizer idle animation (static bars when stopped)
- Redesign SettingsPanel with inline active-provider config + slider labels
- Persist currentChapterUrl + currentSentenceIndex; auto-resume chapter on reload
- Add Google OAuth button to AuthModal
- Real-time sentence highlighting with auto-scroll in ReaderPanel
- Chapter completion via last sentence + auto-advance to next chapter
- Supabase progress sync on every sentence advance (debounced 1s)
- Draggable sidebar resize with localStorage persistence

## Test Plan
- [ ] AudioVisualizer: no animation when stopped
- [ ] Settings: selecting each provider shows its config inline
- [ ] Hard-reload: restores chapter and sentence position
- [ ] Google button visible in AuthModal
- [ ] Sentence highlights during playback; auto-scrolls
- [ ] Last sentence → chapter marked finished → auto-advances (if enabled)
- [ ] Supabase reading_progress row updated within 1s of sentence change
- [ ] Sidebar drags to resize; width persists on reload

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
