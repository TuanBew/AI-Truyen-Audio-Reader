# AudioTruyen — Production Upgrade & Refactor Design Spec

**Date:** 2026-03-12
**Status:** Approved (v2 — post spec-review)
**Repo:** https://github.com/TuanBew/AI-Truyen-Audio-Reader.git
**Stack:** Next.js 16 · FastAPI · Supabase · Ollama / XTTS-v2

---

## 1. Goals & Scope

| # | Goal | Priority |
|---|------|----------|
| 1 | Fix FastAPI Google Cloud ADC credential desync bug | Critical |
| 2 | Sentence-level reading position persistence to Supabase | High |
| 3 | User authentication (Email/Password + Google OAuth) | High |
| 4 | Local TTS via XTTS-v2 (thivux/XTTS-v2-vietnamse) | High |
| 5 | Sentence-by-sentence TTS strategy (4 GB VRAM safe) | High |
| 6 | Premium minimalist dark-mode UI polish | Medium |
| 7 | Security hardening for public open-source release | High |

**Out of scope:** Novel recommendation, multi-language UI, mobile app, paid tiers.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      FRONTEND (Next.js 16)                      │
│                                                                 │
│  Zustand store (localStorage, guest mode)                       │
│  ├── Auth: Supabase Auth (Email/Password + Google OAuth)        │
│  ├── Sync hook: upsert reading_progress on sentence advance     │
│  ├── Sentence queue: active sentence + 1 prefetch               │
│  │   (AbortController per in-flight fetch, revoke blob URLs)    │
│  └── Audio visualizer: Web Audio API AnalyserNode (28 bars)     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP REST
┌──────────────────────────▼──────────────────────────────────────┐
│                      BACKEND (FastAPI)                          │
│                                                                 │
│  TTS chain (per sentence):                                      │
│    Gemini → OpenAI → MiniMax → XTTS-v2 (local) → GTranslate   │
│  ADC fix: lazy-cached client + reset_client() in auth router    │
│  Sentence splitter: Vietnamese-aware endpoint with 5000-char cap│
└──────────┬────────────────────────────┬────────────────────────┘
           │                            │
┌──────────▼──────────┐     ┌───────────▼──────────────────────┐
│  Supabase           │     │  XTTS-v2 local server            │
│  PostgreSQL + Auth  │     │  Coqui TTS HTTP API              │
│  Row Level Security │     │  POST http://localhost:5002/api/tts│
│  novels + progress  │     │  model: thivux/XTTS-v2-vietnamse │
└─────────────────────┘     └──────────────────────────────────┘
```

### XTTS-v2 Server Setup (documented for users)

`thivux/XTTS-v2-vietnamse` is a Coqui TTS model hosted on HuggingFace. It is **not** an Ollama LLM model. It runs via the Coqui TTS HTTP server:

```bash
pip install TTS
tts-server --model_path /path/to/thivux/XTTS-v2-vietnamse --port 5002
# OR via HuggingFace:
tts-server --model_name tts_models/vi/thivux/xtts_v2 --port 5002
```

Exposes: `GET http://localhost:5002/api/tts?text={sentence}&language=vi`
Returns: WAV audio bytes (Content-Type: audio/wav)

The provider is labelled **"Ollama / Local XTTS"** in the UI and settings for user clarity, but the backend calls the Coqui HTTP API, not Ollama's `/api/generate`.

---

## 3. Supabase Database Schema

### 3.1 novels

```sql
CREATE TABLE novels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES auth.users NOT NULL,
  url                TEXT NOT NULL,
  title              TEXT NOT NULL,
  cover_url          TEXT,
  total_chapters     INTEGER DEFAULT 0,
  toc                JSONB NOT NULL DEFAULT '[]',
  added_at           TIMESTAMPTZ DEFAULT NOW(),
  last_chapter_url   TEXT,
  last_chapter_title TEXT,
  UNIQUE(user_id, url)
);

-- Index for per-user library queries
CREATE INDEX novels_user_id_idx ON novels(user_id);
```

### 3.2 reading_progress

`novel_id` is removed from this table. `chapter_url` is globally unique per user because truyenplus.vn chapter URLs are unique per chapter across all novels. Keeping `novel_id` would create redundancy and a misleading composite key.

```sql
CREATE TABLE reading_progress (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users NOT NULL,
  chapter_url     TEXT NOT NULL,
  sentence_index  INTEGER NOT NULL DEFAULT 0,
  word_index      INTEGER NOT NULL DEFAULT -1,
  is_finished     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, chapter_url)
);
```

### 3.3 Auto-update trigger

```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON reading_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### 3.4 Row Level Security

```sql
-- Enable RLS
ALTER TABLE novels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_progress ENABLE ROW LEVEL SECURITY;

-- Deny anon role entirely (unauthenticated requests get no rows/access)
CREATE POLICY "novels_deny_anon" ON novels
  FOR ALL TO anon USING (false);
CREATE POLICY "progress_deny_anon" ON reading_progress
  FOR ALL TO anon USING (false);

-- Authenticated users: own rows only
CREATE POLICY "novels_own" ON novels
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "progress_own" ON reading_progress
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

---

## 4. Authentication Design

### Model: Progressive / Optional

- **Guest mode** (default): App works fully with `localStorage`. No account required.
- **Signed-in mode**: Reading state syncs bidirectionally with Supabase.
- **Sign-in methods**: Email/Password + Google OAuth (via Supabase Auth).
- **On sign-in**: Guest state migrated to Supabase with conflict resolution (see §4.3).
- **On sign-out**: Falls back to localStorage snapshot.
- **Frontend Supabase calls use the `anon` key + RLS** — the backend never calls Supabase directly, so `SUPABASE_SERVICE_ROLE_KEY` is not needed.

### 4.1 Frontend Auth Components

| Component | Purpose |
|---|---|
| `AuthModal.tsx` | Sign-in / Sign-up dialog (email + Google OAuth button) |
| `UserMenu.tsx` | Avatar + dropdown (profile, sync status, sign out) |
| `useAuth.ts` | Hook wrapping Supabase `onAuthStateChange` session listener |
| `useSyncProgress.ts` | Hook upserts `reading_progress` on sentence advance (debounced 1s) |
| `lib/supabase.ts` | Supabase client singleton (`createBrowserClient`) |

### 4.2 Auth Flow

```
App loads
  ├── supabase.auth.getSession() → session exists?
  │     ├── YES → load novels + progress from Supabase
  │     └── NO  → load from localStorage (guest mode)
  │
User clicks "Sign In"
  ├── Email/Password → supabase.auth.signInWithPassword()
  └── Google        → supabase.auth.signInWithOAuth({ provider: 'google' })
  │
On successful auth:
  └── migrateGuestStateToSupabase(userId)   ← correct spelling
```

### 4.3 Guest-to-Supabase Migration (conflict resolution)

```typescript
async function migrateGuestStateToSupabase(userId: string) {
  const localNovels = getLocalNovels()
  for (const novel of localNovels) {
    // Upsert novel — remote wins on title/cover (already authoritative)
    await supabase.from('novels').upsert(
      { user_id: userId, ...novel },
      { onConflict: 'user_id,url', ignoreDuplicates: true }
    )
  }

  const localProgress = getLocalProgress()
  for (const [chapterUrl, localEntry] of Object.entries(localProgress)) {
    // Check if remote has newer progress for this chapter
    const { data: remote } = await supabase
      .from('reading_progress')
      .select('sentence_index, is_finished')
      .eq('user_id', userId)
      .eq('chapter_url', chapterUrl)
      .single()

    // Local wins if it is at a greater-or-equal sentence position.
    // is_finished is OR-merged: once finished on either side, it stays finished.
    const localIsAhead = !remote ||
      localEntry.sentence_index >= remote.sentence_index

    if (localIsAhead) {
      await supabase.from('reading_progress').upsert({
        user_id: userId,
        chapter_url: chapterUrl,
        sentence_index: localEntry.sentence_index,
        word_index: localEntry.word_index,
        // Preserve remote finished flag if it was already set
        is_finished: localEntry.is_finished || (remote?.is_finished ?? false),
      }, { onConflict: 'user_id,chapter_url' })
    }
  }
}
```

---

## 5. Sentence-Level TTS Pipeline

### 5.1 Sentence Splitting (`POST /api/tts/split-sentences`)

Rate limit: 120/min. Max input: 5000 characters (validated server-side, returns 422 if exceeded).

**Vietnamese-aware rules:**
- Split on `.`, `!`, `?`, `…` followed by whitespace or end-of-string
- Do NOT split on `...` (treat as continuation)
- Do NOT split inside numbered lists: `1.`, `2.`, `10.`
- Do NOT split on common abbreviations: `Mr.`, `Dr.`, `vs.`, `St.`
- Maximum sentence length: 300 characters (hard cap — split at last word boundary before limit)
- Minimum sentence length: 5 characters (merge with following sentence)

### 5.2 Frontend Sentence Queue

Audio cache uses `Record<number, string>` (blob URL strings) throughout. This type is consistent between the `SentenceQueue` interface and Zustand state. The cache is **transient** and excluded from Zustand `partialize` — blob URLs are meaningless across page sessions.

```typescript
interface SentenceQueue {
  sentences: string[]
  currentIndex: number
  prefetchIndex: number
  audioCache: Record<number, string>  // index → blob URL
  abortControllers: Record<number, AbortController>  // cancel in-flight fetches
}
```

**Memory management — blob URL lifecycle:**
- On eviction of `audioCache[N]`: call `URL.revokeObjectURL(audioCache[N])` before deleting
- On component unmount: revoke all remaining cached blob URLs
- Eviction policy: retain `[currentIndex - 1, currentIndex, currentIndex + 1]`, evict all others

**Playback loop:**
1. Load chapter → POST `/api/tts/split-sentences` → store `sentences[]`
2. Synthesize `sentences[0]` → cache blob URL → play
3. While playing: background-synthesize `sentences[1]`, store `abortControllers[1]`
4. On `sentences[N]` audio ended:
   - Play `sentences[N+1]` (from cache, already ready)
   - Evict `sentences[N-2]` (call `revokeObjectURL`, delete from cache)
   - Cancel existing prefetch if any: `abortControllers[N+2]?.abort()`
   - Start fresh prefetch for `sentences[N+2]`, store new `AbortController`
   - Upsert `sentence_index: N+1` to Supabase (debounced 1s)
5. On manual seek to `sentences[M]`:
   - Abort ALL in-flight fetches: `Object.values(abortControllers).forEach(c => c.abort())`
   - Clear `abortControllers`
   - Set `currentIndex = M`
   - If `audioCache[M]` exists: play immediately; else: fetch, then play
   - Start prefetch for `sentences[M+1]`

**Race condition prevention:** Each prefetch fetch uses its own `AbortController`. When seek fires, all controllers are aborted before any new fetches start. Any response that arrives after abort is discarded (the `fetch` promise rejects with `AbortError` and the catch handler is a no-op).

### 5.3 Resume on Return

On chapter load:
1. Query `reading_progress` WHERE `user_id = ? AND chapter_url = ?`
2. If `sentence_index > 0`: show "Resume from sentence N?" toast
3. User confirms → `currentIndex = sentence_index`, playback starts at sentence N
4. User declines → `currentIndex = 0`, start from beginning

### 5.4 Zustand State Extensions

```typescript
// Additions to PlayerState (transient — NOT persisted)
sentenceQueue: string[]                          // all sentences for current chapter
currentSentenceIndex: number                     // -1 = not started
sentenceAudioCache: Record<number, string>       // blob URLs (NOT persisted)
prefetchingSentenceIndex: number                 // currently being fetched

// Per-sentence word timing (replaces chapter-level wordTimings)
currentSentenceWordTimings: WordTiming[]         // timing for current sentence only

// Abort controllers for in-flight sentence prefetch requests (NOT persisted)
// Must be in store (not component state) so seek logic can cancel from anywhere
sentenceAbortControllers: Record<number, AbortController>

// Auth state (transient)
supabaseUserId: string | null
syncStatus: 'idle' | 'syncing' | 'synced' | 'offline'
```

---

## 6. TTS Provider Updates

### 6.1 Updated Provider Type

In `frontend/lib/types.ts`:
```typescript
// Before
export type TTSProvider = "gemini" | "openai" | "minimax" | "gtranslate"

// After
export type TTSProvider = "gemini" | "openai" | "minimax" | "xtts" | "gtranslate"
```

Updated provider chain order:
```
preferred_provider → Gemini → OpenAI → MiniMax → XTTS → GTranslate
```

### 6.2 XTTS-v2 Service (`backend/services/tts_xtts.py`)

```python
# HTTP API contract:
# GET http://{endpoint}/api/tts?text={encoded_text}&language=vi
# Returns: WAV audio bytes (Content-Type: audio/wav)
# Max text length: 300 chars (enforced before calling)
# Errors: XTTSTTSError, XTTSQuotaError (HTTP 429 or connection refused)
#
# Config (from .env):
#   XTTS_ENDPOINT=http://localhost:5002
#
# Provider label in UI: "Local XTTS (Vietnamese)"
```

Settings panel exposes:
- Endpoint URL (default: `http://localhost:5002`)
- No API key required (local)
- Setup instructions link (points to README section on XTTS-v2 setup)

### 6.3 ADC Credential Desync Fix (corrected diagnosis)

**Actual root cause (confirmed by code inspection):**
1. `tts_gemini._get_client()` creates a `TextToSpeechClient()` on **every call** — no caching. This is wasteful but not the auth bug source.
2. `list_voices()` at line 184 constructs its own `TextToSpeechClient()` directly, bypassing `_get_client()` entirely.
3. `auth.py` sets `os.environ["GOOGLE_APPLICATION_CREDENTIALS"]` after file save but **never calls any reset** — the env var update has no effect on already-running clients because Google Cloud Python SDK caches credentials internally in the `_helpers` layer.

**Fix — true lazy singleton with explicit reset, applied consistently everywhere:**

```python
# backend/services/tts_gemini.py

_client: TextToSpeechClient | None = None

def get_client() -> TextToSpeechClient:
    """Return cached client. Cache is invalidated by reset_client()."""
    global _client
    if _client is None:
        _client = TextToSpeechClient()  # reads GOOGLE_APPLICATION_CREDENTIALS at call time
    return _client

def reset_client() -> None:
    """Force re-initialization on next call. Must be called by auth.py after
    saving new credentials and setting the env var."""
    global _client
    _client = None

# All internal uses — synthesize(), synthesize_with_timing(), list_voices()
# — must call get_client(), never TextToSpeechClient() directly.
```

`backend/routers/auth.py` after saving JSON and setting `os.environ[...]`:
```python
from services import tts_gemini
tts_gemini.reset_client()
```

Result: Zero server restart required. All three call sites (synthesize, timing, list_voices) benefit from the reset.

---

## 7. UI Design Specification

### 7.1 Reader Typography (Kindle-style)

| Property | Current | New |
|---|---|---|
| Body font size | ~16px | 20px (1.25rem) |
| Line height | ~1.6 | 1.85 |
| Max content width | full | 72ch |
| Paragraph spacing | tight | 1.5em |
| Font family | system-ui | `Inter` (via `next/font/google`) |
| Word highlight | `bg-yellow-300` (harsh) | `text-amber-300 underline decoration-amber-400/50` |

### 7.2 Audio Player Bar (Fixed Bottom)

Always visible regardless of chapter load state.

```
┌─────────────────────────────────────────────────────────────────┐
│  ◀prev  ◀5s  ▌▌play  5s▶  next▶  Ch.12 · S.3/47   01:23/04:12 │
├─────────────────────────────────────────────────────────────────┤
│  ▁▂▄█▇▅▃▁▂▄▆█▇▅▃▁▂▄▆█▇▅▃▂▁  (28-bar FFT visualizer)           │
│  [1.0×]  [pitch 0]  [Gemini ✓]  [auto ●]  [☁ synced]          │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 Audio Visualizer

- **Technology:** Web Audio API `AnalyserNode`
- **fftSize:** 64 → yields 32 frequency bins (`frequencyBinCount = 32`)
- **Bars used:** 28 bars from bins **2–29** (skip bin 0 = DC offset, bin 1 = sub-bass, bins 30–31 = ultrasonic silence for speech)
- **Update rate:** `requestAnimationFrame` (~60fps)
- **Idle animation:** CSS `@keyframes` breathing pulse at 20% height
- **Color:** Violet gradient (`#7c3aed` → `#a78bfa`)
- **Container height:** 32px; bars scale proportionally to `frequencyData[i] / 255`

### 7.4 Settings Panel Visual Hierarchy

1. **TTS Provider** — radio cards with status badges (primary weight)
2. **Playback** — speed/pitch sliders, auto-advance toggle
3. **Voice Selection** — provider-specific, collapsible per provider
4. **Credentials / API Keys** — collapsed by default, expand on click
5. **Local XTTS** — endpoint URL input, setup instructions link, collapsed

### 7.5 Auth UI

- **Header right slot:** Guest → "Sign In" button; Signed in → avatar + `UserMenu`
- `AuthModal`: centered dialog, tabs for Sign In / Sign Up
- Google OAuth: prominent button at top of modal
- Sync indicator: cloud icon in player bar (`☁` syncing → `✓` synced → `✗` offline)

---

## 8. Security Hardening

### 8.1 `.gitignore` (complete additions)

```gitignore
# Credentials — entire directory, not just specific files
backend/credentials/

# Environment files — explicit paths to avoid ambiguity
backend/.env
frontend/.env.local
.env
.env.local
.env.*.local

# Runtime state
backend/.audio_state.json

# NOTE: .env.example files ARE committed (they are templates, not secrets)
```

### 8.2 Environment Variables

**`backend/.env`** (backend only — never sent to frontend)
```env
GOOGLE_APPLICATION_CREDENTIALS=./credentials/service_account.json
OPENAI_API_KEY=
MINIMAX_API_KEY=
MINIMAX_GROUP_ID=
XTTS_ENDPOINT=http://localhost:5002
FRONTEND_ORIGIN=http://localhost:3000
SCRAPER_RATE_LIMIT=30
```

**`frontend/.env.local`** (frontend only)
```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_URL=http://localhost:8000
```

> **Note:** Backend does NOT integrate with Supabase directly. All Supabase access is frontend-only using the `anon` key + RLS. No `SUPABASE_SERVICE_ROLE_KEY` is needed or used.

### 8.3 CORS

- `FRONTEND_ORIGIN` env var, already locked in `main.py`
- Verify no `*` wildcard exists in production config
- Auth endpoints rate-limited: 10/min (brute-force protection)
- Sentence-split endpoint: 120/min

### 8.4 API Key Handling

| Key | Location | How used |
|---|---|---|
| OpenAI / MiniMax | `localStorage` | Sent in request headers to backend |
| Supabase anon key | `frontend/.env.local` | Frontend only, RLS enforces access |
| Google SA JSON | Uploaded via UI → `backend/credentials/` | ADC, never returned to frontend |

---

## 9. New Files (additions only)

```
AudioTruyen/
├── docs/superpowers/specs/           ← this file
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql    ← schema + RLS + indexes + trigger
├── backend/
│   ├── services/
│   │   └── tts_xtts.py               ← NEW: Coqui XTTS-v2 HTTP client
│   └── routers/
│       └── tts.py                    ← add split-sentences endpoint + rate limit
└── frontend/
    ├── lib/
    │   ├── supabase.ts               ← NEW: browser Supabase client singleton
    │   ├── types.ts                  ← update TTSProvider union (add "xtts")
    │   ├── hooks/
    │   │   ├── useAuth.ts            ← NEW: Supabase session listener
    │   │   └── useSyncProgress.ts    ← NEW: debounced upsert on sentence advance
    │   └── store.ts                  ← extend: sentence queue + auth state
    └── components/
        ├── AuthModal.tsx             ← NEW: sign-in/sign-up dialog
        ├── UserMenu.tsx              ← NEW: avatar + dropdown
        └── AudioVisualizer.tsx       ← NEW: 28-bar FFT component
```

---

## 10. Implementation Phases (ordered to avoid broken intermediate states)

| Phase | Scope | Key files | Verification |
|---|---|---|---|
| **P0 — Git Setup** | Init repo, push to GitHub, branch `feat/production-upgrade` | `.gitignore`, `README.md` | `git log`, CI green |
| **P1 — ADC Fix** | Lazy singleton + reset, fix `list_voices()` | `tts_gemini.py`, `auth.py` | Upload credentials → TTS works without restart |
| **P2 — Supabase Schema** | Migrations, RLS, trigger, indexes | `supabase/migrations/001_initial_schema.sql` | Supabase dashboard shows tables + RLS active |
| **P3 — Auth Frontend** | Supabase client, AuthModal, UserMenu, useAuth | `supabase.ts`, `AuthModal.tsx`, `UserMenu.tsx`, `useAuth.ts` | Sign in/out works; Google OAuth redirects correctly |
| **P4 — Sentence Pipeline** | Split endpoint, sentence queue, blob URL lifecycle, AbortController | `tts.py`, `TTSPlayer.tsx`, `store.ts` | Sentence-by-sentence audio plays; seek cancels in-flight fetches |
| **P5 — Sync Hook** | useSyncProgress, resume-on-return toast | `useSyncProgress.ts`, `store.ts` | Sign-in → progress syncs; reload chapter → resume prompt |
| **P6 — XTTS Provider** | tts_xtts.py, settings UI, chain + type update | `tts_xtts.py`, `tts.py`, `SettingsPanel.tsx`, `types.ts` | Local XTTS synthesizes sentence; fallback on connection refused |
| **P7 — UI Polish** | Typography, player bar, visualizer, settings hierarchy | `ReaderPanel.tsx`, `TTSPlayer.tsx`, `AudioVisualizer.tsx`, `SettingsPanel.tsx` | Visual review: text 20px, visualizer animates, player always visible |
| **P8 — Security** | .gitignore audit, env validation, CORS review, rate limits | `main.py`, `.gitignore`, `.env.example` files | `git status` shows no secrets; rate limit returns 429 on breach |
| **P9 — Docs + README** | Setup guide, XTTS-v2 instructions, env reference | `README.md` | New contributor can run app from README alone |

---

## 11. Non-Negotiable Constraints

1. **Do not break existing word-level highlighting** — `WordTiming[]` still works per sentence
2. **Guest mode works without any account** — localStorage fallback always active
3. **Supabase sync is conflict-safe** — migration compares `sentence_index` before upsert; local only wins if strictly ahead
4. **No secrets in source code** — all keys via env vars or runtime upload
5. **Sentence max = 300 chars** — hard cap enforced backend-side before XTTS inference
6. **Blob URLs revoked on eviction** — `revokeObjectURL()` called before cache entry deletion
7. **In-flight fetches aborted on seek** — `AbortController` per prefetch, cancelled on manual navigation
8. **CORS locked** — `FRONTEND_ORIGIN` env var, no wildcard in production

---

*Spec v1 written: 2026-03-12 | Spec v2 (post-review fixes): 2026-03-12 | Spec v3 (migration OR-merge + AbortControllers in store): 2026-03-12*
