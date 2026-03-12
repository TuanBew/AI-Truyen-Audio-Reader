# AudioTruyen Production Upgrade Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade AudioTruyen from a local-only app to a production-ready, authenticated, cloud-synced audiobook reader with local XTTS-v2 TTS support, sentence-level persistence, and full security hardening for public open-source release.

**Architecture:** FastAPI backend serves a sentence-splitting TTS pipeline (one sentence at a time, 4 GB VRAM safe). A Next.js frontend manages a sentence queue with AbortController-based prefetch and Supabase sync for reading position. Supabase Auth handles Email/Password + Google OAuth; all tables are RLS-protected.

**Tech Stack:** Python 3.11+, FastAPI, pytest, httpx · Next.js 16, React 19, TypeScript, Zustand, Tailwind v4 · Supabase (PostgreSQL, Auth, RLS) · Coqui TTS (XTTS-v2 local server)

**Spec:** `docs/superpowers/specs/2026-03-12-audiotruyen-refactor-design.md`
**Repo:** https://github.com/TuanBew/AI-Truyen-Audio-Reader.git

---

## Chunk 1: Foundation — Git Setup + ADC Bug Fix

---

### Task 1: Initialize Git repository and push to GitHub

**Files:**
- Modify: `.gitignore` (root)
- Create: `README.md` (stub)

- [ ] **Step 1: Audit and repair .gitignore**

Open `.gitignore` at the project root. Find and REMOVE this stale line (it only matches `credentials/` at repo root, not `backend/credentials/`):
```
credentials/service_account.json
```

Ensure these lines are present (add any missing):

```gitignore
# Credentials — whole directory
backend/credentials/

# Environment files — explicit paths
backend/.env
frontend/.env.local
.env
.env.local
.env.*.local

# Runtime state
backend/.audio_state.json

# Python
__pycache__/
*.py[cod]
*.pyo
.venv/
venv/

# Node / Next.js
frontend/node_modules/
frontend/.next/
frontend/out/

# OS
.DS_Store
Thumbs.db
```

- [ ] **Step 2: Initialize git and make first commit**

```bash
cd "D:\importantProjects\WorkSpace_Personal Project_ Agents\AudioTruyen"
git init
git add .
# Verify no secrets are staged:
git status  # must show NO .env files, NO backend/credentials/ files
git commit -m "chore: initial AudioTruyen codebase — reader, TTS, scraper complete"
```

- [ ] **Step 3: Connect to GitHub remote and push**

```bash
git remote add origin https://github.com/TuanBew/AI-Truyen-Audio-Reader.git
git branch -M main
git push -u origin main
```

- [ ] **Step 4: Create feature branch**

```bash
git checkout -b feat/production-upgrade
```

---

### Task 2: Add pytest infrastructure to backend

**Files:**
- Modify: `backend/requirements.txt`
- Create: `backend/pytest.ini`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`

- [ ] **Step 1: Add test dependencies to requirements.txt**

Append to `backend/requirements.txt`:

```
pytest>=8.0.0
pytest-asyncio>=0.23.0
```

(`httpx` is already present.)

- [ ] **Step 2: Create pytest.ini with asyncio_mode = auto**

Create `backend/pytest.ini`:

```ini
[pytest]
asyncio_mode = auto
testpaths = tests
```

> **Why:** pytest-asyncio 0.23+ defaults to `strict` mode, which requires `@pytest.mark.asyncio` on every async test and `@pytest_asyncio.fixture` on every async fixture. Setting `asyncio_mode = auto` handles this globally, so async tests and fixtures work without decoration boilerplate.

- [ ] **Step 3: Create tests package**

Create `backend/tests/__init__.py` — empty file.

- [ ] **Step 4: Create conftest.py**

Create `backend/tests/conftest.py`:

```python
"""Shared pytest fixtures for AudioTruyen backend tests."""
import pytest
from httpx import AsyncClient, ASGITransport
from main import app


@pytest.fixture
async def client():
    """Async test client for the FastAPI app."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac
```

- [ ] **Step 5: Verify pytest works**

```bash
cd backend
source .venv/Scripts/activate   # Windows Git Bash: source prefix required
pip install pytest pytest-asyncio
pytest tests/ -v
```

Expected: `no tests ran` (0 collected, no errors).

---

### Task 3: Fix ADC credential desync bug in tts_gemini.py

**Root cause (confirmed by code inspection):**
1. `_get_client()` is **stateless** — it creates a new `TextToSpeechClient()` on every call (no caching).
2. `list_voices()` at line 184 creates `texttospeech.TextToSpeechClient()` **directly**, bypassing `_get_client()` entirely.
3. `auth.py` sets `os.environ[...]` after upload but calls no reset — the Google Cloud SDK's internal credential cache in any existing clients is not invalidated.

**Fix:** True lazy singleton with `get_client()` / `reset_client()`. ALL code paths — `synthesize()`, `synthesize_with_timing()`, `list_voices()` — must call `get_client()`, never `TextToSpeechClient()` directly.

**Files:**
- Modify: `backend/services/tts_gemini.py`
- Create: `backend/tests/test_tts_gemini.py`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_tts_gemini.py`:

```python
"""Tests for the ADC client lazy-singleton and reset mechanism."""
import os
import pytest
from unittest.mock import patch, MagicMock, call
from services import tts_gemini


def test_get_client_raises_when_no_credentials():
    """get_client() must raise GeminiTTSError when env var is missing."""
    original = os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
    try:
        tts_gemini.reset_client()
        with pytest.raises(tts_gemini.GeminiTTSError, match="GOOGLE_APPLICATION_CREDENTIALS"):
            tts_gemini.get_client()
    finally:
        if original:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = original
        tts_gemini.reset_client()


def test_get_client_returns_same_instance():
    """get_client() must return the cached instance on repeated calls."""
    with patch("services.tts_gemini.texttospeech.TextToSpeechClient") as MockClient:
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance
        with patch("os.path.exists", return_value=True):
            with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/fake/path.json"}):
                tts_gemini.reset_client()
                first = tts_gemini.get_client()
                second = tts_gemini.get_client()
                third = tts_gemini.get_client()
                assert first is second is third
                # Must construct exactly once despite three calls
                assert MockClient.call_count == 1
                tts_gemini.reset_client()


def test_reset_client_forces_reinit():
    """reset_client() must cause the next get_client() to create a new instance."""
    with patch("services.tts_gemini.texttospeech.TextToSpeechClient") as MockClient:
        MockClient.side_effect = [MagicMock(name="client_v1"), MagicMock(name="client_v2")]
        with patch("os.path.exists", return_value=True):
            with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/fake/path.json"}):
                tts_gemini.reset_client()
                first = tts_gemini.get_client()
                tts_gemini.reset_client()
                second = tts_gemini.get_client()
                assert first is not second
                assert MockClient.call_count == 2
                tts_gemini.reset_client()


def test_list_voices_uses_cached_singleton(monkeypatch):
    """list_voices() must call get_client(), not construct its own TextToSpeechClient."""
    mock_client = MagicMock()
    mock_client.list_voices.return_value = MagicMock(voices=[])
    # Inject the mock directly into the module-level cache
    monkeypatch.setattr(tts_gemini, "_client", mock_client)
    result = tts_gemini.list_voices("vi-VN")
    mock_client.list_voices.assert_called_once_with(language_code="vi-VN")
    assert result == []
    # Cleanup: clear injected mock so subsequent tests start fresh
    monkeypatch.setattr(tts_gemini, "_client", None)
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend
pytest tests/test_tts_gemini.py -v
```

Expected: `AttributeError: module 'services.tts_gemini' has no attribute 'get_client'` (correct pre-implementation failure).

- [ ] **Step 3: Implement lazy singleton**

Replace the existing `_get_client()` function block in `backend/services/tts_gemini.py` with:

```python
# Lazy singleton. reset_client() invalidates it; next get_client() re-creates.
_client: "texttospeech.TextToSpeechClient | None" = None


def get_client() -> "texttospeech.TextToSpeechClient":
    """Return the cached TTS client, creating it on first call.

    Raises:
        GeminiTTSError: if GOOGLE_APPLICATION_CREDENTIALS is missing or invalid.
    """
    global _client
    if _client is None:
        credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if not credentials_path or not os.path.exists(credentials_path):
            raise GeminiTTSError(
                "GOOGLE_APPLICATION_CREDENTIALS not set or file not found. "
                "Upload your service account JSON via Settings → Google Cloud."
            )
        try:
            _client = texttospeech.TextToSpeechClient()
        except Exception as e:
            raise GeminiTTSError(f"Failed to initialise Google TTS client: {e}")
    return _client


def reset_client() -> None:
    """Invalidate the cached client. Call after saving new credentials.

    The next call to get_client() will re-instantiate using the current
    GOOGLE_APPLICATION_CREDENTIALS env var value.
    """
    global _client
    _client = None
```

**Also update all three call sites in the same file to use `get_client()`:**

In `synthesize()` — change `client = _get_client()` to `client = get_client()`.

In `synthesize_with_timing()` — change `client = _get_client()` to `client = get_client()`.

In `list_voices()` — replace:
```python
client = texttospeech.TextToSpeechClient()
resp = client.list_voices(language_code=language_code)
```
with:
```python
client = get_client()
resp = client.list_voices(language_code=language_code)
```

> Do **not** add a `_get_client = get_client` alias — updating the call sites directly is safer and avoids silent caching bypass if the alias is ever reassigned.

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pytest tests/test_tts_gemini.py -v
```

Expected: `4 passed`.

---

### Task 4: Fix auth.py to call reset_client() after credential upload

**Files:**
- Modify: `backend/routers/auth.py`
- Create: `backend/tests/test_auth.py`

- [ ] **Step 1: Write failing test**

Create `backend/tests/test_auth.py`:

```python
"""Tests for auth router — credential upload triggers client reset."""
import pytest
import json
import io
from unittest.mock import patch
from services import tts_gemini


VALID_SA = {
    "type": "service_account",
    "project_id": "test-project",
    "private_key_id": "key123",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    "client_email": "test@test-project.iam.gserviceaccount.com",
}


async def test_upload_credentials_resets_gemini_client(client, tmp_path, monkeypatch):
    """Uploading credentials must call tts_gemini.reset_client() exactly once."""
    reset_calls = []
    monkeypatch.setattr(tts_gemini, "reset_client", lambda: reset_calls.append(1))

    with patch("routers.auth.CREDENTIALS_DIR", tmp_path), \
         patch("routers.auth.CREDENTIALS_FILE", tmp_path / "service_account.json"), \
         patch("routers.auth._test_google_cloud_connection", return_value=(True, "")):

        response = await client.post(
            "/api/auth/upload-credentials",
            files={"file": ("service_account.json",
                            io.BytesIO(json.dumps(VALID_SA).encode()),
                            "application/json")},
        )

    assert response.status_code == 200
    assert len(reset_calls) == 1, f"reset_client() must be called once; called {len(reset_calls)} times"
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pytest tests/test_auth.py -v
```

Expected: `FAILED — AssertionError: reset_client() must be called once; called 0 times`.

- [ ] **Step 3: Update auth.py**

In `backend/routers/auth.py`, in `upload_credentials()`, after:
```python
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(CREDENTIALS_FILE)
```
Add:
```python
# Invalidate the cached TTS client so the next request uses the new credentials.
from services import tts_gemini as _tts_gemini
_tts_gemini.reset_client()
```

Also update `_test_google_cloud_connection()` to use the singleton instead of constructing its own client:

```python
def _test_google_cloud_connection() -> tuple[bool, str]:
    """Test Google Cloud TTS connectivity via the cached singleton."""
    try:
        from services import tts_gemini
        client = tts_gemini.get_client()
        client.list_voices(language_code="vi-VN")
        return True, ""
    except Exception as e:
        return False, str(e)
```

- [ ] **Step 4: Run all backend tests**

```bash
pytest tests/ -v
```

Expected: `5 passed`.

- [ ] **Step 5: Manual smoke test**

```bash
uvicorn main:app --reload --port 8000
curl http://localhost:8000/api/auth/credentials-status
# Expected: {"configured": true, "google_cloud_connected": true, ...}
```

- [ ] **Step 6: Commit**

```bash
git add backend/services/tts_gemini.py backend/routers/auth.py \
        backend/tests/ backend/requirements.txt backend/pytest.ini
git commit -m "fix(adc): lazy-cache TTS client + reset on credential upload

- get_client() caches singleton; reset_client() invalidates it
- synthesize(), synthesize_with_timing(), list_voices() all use get_client()
- auth.py calls reset_client() after saving credentials — no restart needed
- pytest.ini sets asyncio_mode=auto for async test support"
```

---

## Chunk 2: Database & Auth

---

### Task 5: Create Supabase schema migration

**Files:**
- Create: `supabase/migrations/001_initial_schema.sql`

> **Pre-requisite:** Create a Supabase project at https://supabase.com. Note the project URL and anon key.

- [ ] **Step 1: Create migrations directory**

```bash
mkdir -p supabase/migrations
```

- [ ] **Step 2: Write migration SQL**

Create `supabase/migrations/001_initial_schema.sql`:

```sql
-- ============================================================
-- AudioTruyen — Initial Schema (run in Supabase SQL Editor)
-- ============================================================

-- ─── novels ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS novels (
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

CREATE INDEX IF NOT EXISTS novels_user_id_idx ON novels(user_id);

-- ─── reading_progress ────────────────────────────────────────
-- chapter_url is globally unique per user on truyenplus.vn
-- novel_id omitted intentionally (chapter URLs are unique across novels)
CREATE TABLE IF NOT EXISTS reading_progress (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users NOT NULL,
  chapter_url     TEXT NOT NULL,
  sentence_index  INTEGER NOT NULL DEFAULT 0,
  word_index      INTEGER NOT NULL DEFAULT -1,
  is_finished     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, chapter_url)
);

-- ─── auto-update trigger ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_reading_progress_updated_at
  BEFORE UPDATE ON reading_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Row Level Security ───────────────────────────────────────
ALTER TABLE novels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_progress ENABLE ROW LEVEL SECURITY;

-- Deny unauthenticated (anon) role entirely
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

- [ ] **Step 3: Apply in Supabase SQL Editor**

Paste the file content into Supabase Dashboard → SQL Editor → Run.
Expected: no errors.

- [ ] **Step 4: Verify in Supabase Dashboard**

- Table Editor: `novels` and `reading_progress` tables exist with all columns
- Authentication → Policies: each table shows **2 policies** (`deny_anon` + `own`)
- Indexes: `novels_user_id_idx` is visible on the `novels` table

- [ ] **Step 5: Enable Google OAuth**

Dashboard → Authentication → Providers → Google → Enable → add Client ID + Secret → add `http://localhost:3000` to Redirect URLs → Save.

- [ ] **Step 6: Commit**

```bash
git add supabase/
git commit -m "feat(db): Supabase schema — novels + reading_progress, RLS, indexes"
```

---

### Task 6: Add Supabase client and env to frontend

**Files:**
- Create: `frontend/lib/supabase.ts`
- Create: `frontend/.env.local.example`
- Modify: `frontend/package.json`

> **Design note:** This project is a client-side SPA with `ssr: false` on MainLayout. We use `@supabase/supabase-js` directly (not `@supabase/ssr`) — no Next.js middleware needed for session refresh, and no server components requiring server-side auth. Simpler, fewer moving parts.

- [ ] **Step 1: Install Supabase client**

```bash
cd frontend
npm install @supabase/supabase-js
```

- [ ] **Step 2: Create .env.local.example**

Create `frontend/.env.local.example`:

```env
# Supabase — get from Supabase Dashboard → Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here

# Backend API
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Copy to your actual local file:
```bash
cp frontend/.env.local.example frontend/.env.local
# Edit frontend/.env.local with your real values
```

- [ ] **Step 3: Create Supabase client singleton**

Create `frontend/lib/supabase.ts`:

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
    'Copy frontend/.env.local.example to frontend/.env.local and fill in your values.'
  )
}

// Singleton browser Supabase client.
// Uses the anon key — Row Level Security enforces per-user access.
// No server-side session management needed (client-side SPA only).
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | head -20
```

Expected: No TypeScript errors from supabase.ts (will error if env vars missing in .env.local).

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/supabase.ts frontend/.env.local.example \
        frontend/package.json frontend/package-lock.json
git commit -m "feat(auth): Supabase client singleton (@supabase/supabase-js, client-side only)"
```

---

### Task 7: Add auth state to Zustand store

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/lib/store.ts`

- [ ] **Step 1: Add auth types**

In `frontend/lib/types.ts`, append:

```typescript
// ─── Auth ────────────────────────────────────────────────────
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline'

export interface AuthState {
  supabaseUserId: string | null
  supabaseEmail: string | null
  syncStatus: SyncStatus
}
```

- [ ] **Step 2: Add auth slice to store**

In `frontend/lib/store.ts`:

Add to the `AppState` interface:
```typescript
authState: AuthState
```

Add to `create(...)` initial state:
```typescript
authState: {
  supabaseUserId: null,
  supabaseEmail: null,
  syncStatus: 'idle',
},
```

Add the action:
```typescript
setAuthState: (auth: Partial<AuthState>) =>
  set((state) => ({
    authState: { ...state.authState, ...auth },
  })),
```

**Confirm `partialize` does NOT include `authState`:** The existing `partialize` is an allowlist that enumerates only `view`, `activeNovelId`, `savedNovels`, `finishedChapterUrls`, `ttsSettings`, `recordingState`. Do NOT add `authState` to this list — it must remain transient (not persisted to localStorage).

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/store.ts
git commit -m "feat(auth): add transient authState slice to Zustand store"
```

---

### Task 8: Build useAuth hook

**Files:**
- Create: `frontend/lib/hooks/useAuth.ts`

- [ ] **Step 1: Create hooks directory and useAuth**

```bash
mkdir -p frontend/lib/hooks
```

Create `frontend/lib/hooks/useAuth.ts`:

```typescript
'use client'

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/lib/store'

/**
 * Subscribes to Supabase auth state changes and syncs them into Zustand.
 * Mount this ONCE at the root component (MainLayout).
 *
 * Design notes:
 * - Uses onAuthStateChange as the single source of truth for session state.
 *   getSession() is used only for initial hydration before the listener fires.
 * - migratedRef prevents double-migration when both getSession() and
 *   onAuthStateChange fire near-simultaneously on page load.
 * - Reads savedNovels/finishedChapterUrls via getState() INSIDE the handler
 *   to avoid stale closure (captures state at sign-in time, not mount time).
 */
export function useAuth() {
  const setAuthState = useAppStore((s) => s.setAuthState)
  const migratedRef = useRef(false)

  useEffect(() => {
    // 1. Hydrate from existing session (handles page refresh)
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user && !migratedRef.current) {
        migratedRef.current = true
        setAuthState({
          supabaseUserId: session.user.id,
          supabaseEmail: session.user.email ?? null,
          syncStatus: 'syncing',
        })
        try {
          await migrateGuestStateToSupabase(session.user.id)
          setAuthState({ syncStatus: 'synced' })
        } catch {
          setAuthState({ syncStatus: 'offline' })
        }
      }
    })

    // 2. Listen for future auth changes (sign-in, sign-out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session?.user && !migratedRef.current) {
          migratedRef.current = true
          setAuthState({
            supabaseUserId: session.user.id,
            supabaseEmail: session.user.email ?? null,
            syncStatus: 'syncing',
          })
          try {
            await migrateGuestStateToSupabase(session.user.id)
            setAuthState({ syncStatus: 'synced' })
          } catch {
            setAuthState({ syncStatus: 'offline' })
          }
        } else if (event === 'SIGNED_OUT') {
          migratedRef.current = false
          setAuthState({ supabaseUserId: null, supabaseEmail: null, syncStatus: 'idle' })
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [setAuthState])
}


// ─── Guest → Supabase migration ──────────────────────────────

async function migrateGuestStateToSupabase(userId: string) {
  // Read current store state at migration time (not stale mount-time snapshot)
  const { savedNovels, finishedChapterUrls } = useAppStore.getState()

  // Migrate novels — ignoreDuplicates=true: remote title/cover wins on conflict
  for (const novel of savedNovels) {
    await supabase.from('novels').upsert(
      {
        user_id: userId,
        url: novel.url,
        title: novel.title,
        cover_url: novel.coverUrl ?? null,
        total_chapters: novel.totalChapters,
        toc: novel.toc,
        added_at: new Date(novel.addedAt).toISOString(),
        last_chapter_url: novel.lastChapterUrl ?? null,
        last_chapter_title: novel.lastChapterTitle ?? null,
      },
      { onConflict: 'user_id,url', ignoreDuplicates: true }
    )
  }

  // Migrate finished chapters with conflict resolution:
  // is_finished is OR-merged (once finished on either side, it stays finished)
  for (const chapterUrl of finishedChapterUrls) {
    const { data: remote } = await supabase
      .from('reading_progress')
      .select('sentence_index, is_finished')
      .eq('user_id', userId)
      .eq('chapter_url', chapterUrl)
      .single()

    // Skip if remote is already finished — it's authoritative
    if (remote?.is_finished) continue

    await supabase.from('reading_progress').upsert(
      {
        user_id: userId,
        chapter_url: chapterUrl,
        sentence_index: remote?.sentence_index ?? 0,
        word_index: -1,
        is_finished: true,
      },
      { onConflict: 'user_id,chapter_url' }
    )
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/lib/hooks/useAuth.ts
git commit -m "feat(auth): useAuth — Supabase session listener, migration guard, stale-closure-safe"
```

---

### Task 9: Build AuthModal component

**Files:**
- Create: `frontend/components/AuthModal.tsx`

- [ ] **Step 1: Create AuthModal**

Create `frontend/components/AuthModal.tsx`:

```typescript
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

interface Props {
  isOpen: boolean
  onClose: () => void
}

type Tab = 'signin' | 'signup'

export default function AuthModal({ isOpen, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Reset form state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setEmail('')
      setPassword('')
      setError(null)
      setSuccess(null)
      setTab('signin')
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      if (tab === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onClose()
      } else {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setSuccess('Kiểm tra email để xác nhận tài khoản!')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Đã xảy ra lỗi')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleAuth = async () => {
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    // Note: on success, the browser redirects — setLoading(false) below is
    // only reached on error (e.g. popup blocked, provider misconfigured).
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0d1117] p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        <button
          onClick={handleGoogleAuth}
          disabled={loading}
          className="mb-4 flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"/>
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
          </svg>
          Tiếp tục với Google
        </button>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/10" /></div>
          <div className="relative flex justify-center"><span className="bg-[#0d1117] px-3 text-xs text-gray-500">hoặc</span></div>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-white/5 p-1">
          {(['signin', 'signup'] as Tab[]).map((t) => (
            <button key={t} onClick={() => { setTab(t); setError(null); setSuccess(null) }}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-violet-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              {t === 'signin' ? 'Đăng nhập' : 'Đăng ký'}
            </button>
          ))}
        </div>

        <form onSubmit={handleEmailAuth} className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-violet-500" />
          <input type="password" placeholder="Mật khẩu" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-violet-500" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          {success && <p className="text-xs text-green-400">{success}</p>}
          <button type="submit" disabled={loading}
            className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
            {loading ? 'Đang xử lý...' : tab === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-500">
          Đăng nhập để đồng bộ vị trí đọc giữa các thiết bị
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/AuthModal.tsx
git commit -m "feat(auth): AuthModal — email/password + Google OAuth, form resets on open"
```

---

### Task 10: Build UserMenu and wire auth into MainLayout

**Files:**
- Create: `frontend/components/UserMenu.tsx`
- Modify: `frontend/components/MainLayout.tsx`

- [ ] **Step 1: Create UserMenu**

Create `frontend/components/UserMenu.tsx`:

```typescript
'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Props {
  email: string
  syncStatus: string
}

const syncIcons: Record<string, string> = {
  idle: '○', syncing: '↻', synced: '✓', offline: '✗',
}

export default function UserMenu({ email, syncStatus }: Props) {
  const [open, setOpen] = useState(false)
  // Fallback to '?' for OAuth providers that don't return an email
  const initial = email.charAt(0).toUpperCase() || '?'

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/10">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
          {initial}
        </span>
        <span className="text-xs text-gray-400" title={`Sync: ${syncStatus}`}>
          {syncIcons[syncStatus] ?? '○'}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-white/10 bg-[#0d1117] p-1 shadow-2xl">
          <div className="px-3 py-2">
            <p className="truncate text-xs font-medium text-white">{email || 'Người dùng'}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {syncStatus === 'synced' ? '☁ Đã đồng bộ' :
               syncStatus === 'syncing' ? '↻ Đang đồng bộ...' :
               syncStatus === 'offline' ? '✗ Không thể kết nối' : '○ Chưa đồng bộ'}
            </p>
          </div>
          <div className="mt-1 border-t border-white/10 pt-1">
            <button onClick={() => { supabase.auth.signOut(); setOpen(false) }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition hover:bg-white/5 hover:text-white">
              Đăng xuất
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire auth into MainLayout**

Read `frontend/components/MainLayout.tsx` in full before editing.

Add to the imports at the top (add `useState` to the existing React import if not already present — do not duplicate the import):

```typescript
import { useState } from 'react'
import { useAuth } from '@/lib/hooks/useAuth'
import { useAppStore } from '@/lib/store'
import AuthModal from './AuthModal'
import UserMenu from './UserMenu'
```

Inside the `MainLayout` function body, add:

```typescript
useAuth()  // Mount Supabase session listener at root
const authState = useAppStore((s) => s.authState)
const [authModalOpen, setAuthModalOpen] = useState(false)
```

In the header JSX, add the auth slot alongside the existing settings button:

```tsx
{authState.supabaseUserId ? (
  <UserMenu email={authState.supabaseEmail ?? ''} syncStatus={authState.syncStatus} />
) : (
  <button
    onClick={() => setAuthModalOpen(true)}
    className="rounded-xl bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500"
  >
    Đăng nhập
  </button>
)}
<AuthModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} />
```

- [ ] **Step 3: Test auth flow in browser**

```bash
cd frontend && npm run dev
```

1. Open http://localhost:3000
2. Click "Đăng nhập" → AuthModal opens (Google + email form)
3. Sign in via Google → redirect back → header shows avatar `✓`
4. Click avatar → UserMenu shows email + "Đã đồng bộ"
5. Click "Đăng xuất" → reverts to "Đăng nhập" button

- [ ] **Step 4: Commit**

```bash
git add frontend/components/UserMenu.tsx frontend/components/MainLayout.tsx
git commit -m "feat(auth): UserMenu + MainLayout wiring — sign-in/out, sync status indicator"
```

---

## Chunk 3: Sentence-Level TTS Pipeline

---

### Task 11: Add sentence-splitting endpoint to backend

**Files:**
- Modify: `backend/routers/tts.py`
- Create: `backend/tests/test_sentence_split.py`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_sentence_split.py`:

```python
"""Tests for Vietnamese sentence-splitting endpoint."""
import pytest


async def test_split_basic_sentences(client):
    response = await client.post(
        "/api/tts/split-sentences",
        json={"text": "Xin chào. Tôi là AI. Bạn khỏe không?"}
    )
    assert response.status_code == 200
    assert response.json()["sentences"] == ["Xin chào.", "Tôi là AI.", "Bạn khỏe không?"]


async def test_split_preserves_ellipsis(client):
    response = await client.post(
        "/api/tts/split-sentences",
        json={"text": "Anh ấy dừng lại... rồi tiếp tục."}
    )
    assert response.status_code == 200
    assert len(response.json()["sentences"]) == 1


async def test_split_enforces_max_chars(client):
    long_sentence = ("Từ " * 120).strip()   # ~480 chars
    response = await client.post("/api/tts/split-sentences", json={"text": long_sentence})
    assert response.status_code == 200
    for s in response.json()["sentences"]:
        assert len(s) <= 300


async def test_split_rejects_oversized_input(client):
    response = await client.post("/api/tts/split-sentences", json={"text": "x" * 5001})
    assert response.status_code == 422


async def test_split_merges_short_sentences(client):
    response = await client.post("/api/tts/split-sentences", json={"text": "Ừ. Tôi hiểu rồi."})
    assert response.status_code == 200
    # "Ừ." is 3 chars → merged with next sentence
    assert len(response.json()["sentences"]) == 1
```

- [ ] **Step 2: Run tests to confirm they fail (404)**

```bash
pytest tests/test_sentence_split.py -v
```

Expected: All fail with connection error or 404.

- [ ] **Step 3: Add sentence-splitting logic to tts.py**

At the top of `backend/routers/tts.py`, find the existing `from pydantic import BaseModel, Field` import and ADD `field_validator` to it (do not add a duplicate import line):

```python
from pydantic import BaseModel, Field, field_validator
```

Below the imports, add the helper constants and function:

```python
import re as _re

_ABBREV_RE = _re.compile(
    r'\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|No|Vol|pp|e\.g|i\.e)\.',
    _re.IGNORECASE
)
# Numbered list prefixes require a trailing space so "3.14" is NOT protected
_NUMBERED_LIST_RE = _re.compile(r'(?<!\d)\b\d+\.\s')


def _split_into_sentences(text: str) -> list[str]:
    """Vietnamese-aware sentence splitter. Max 300 chars per sentence."""
    text = text.replace('...', '\x00EL\x00')

    def _protect(m: _re.Match) -> str:
        return m.group(0).replace('.', '\x00DOT\x00')

    text = _ABBREV_RE.sub(_protect, text)
    text = _NUMBERED_LIST_RE.sub(_protect, text)

    parts = _re.split(r'(?<=[.!?…])\s+', text.strip())
    parts = [
        p.replace('\x00EL\x00', '...').replace('\x00DOT\x00', '.')
        for p in parts if p.strip()
    ]

    # Enforce 300-char max by splitting at last word boundary
    result: list[str] = []
    for part in parts:
        while len(part) > 300:
            split_pos = part.rfind(' ', 0, 300)
            if split_pos == -1:
                split_pos = 300
            result.append(part[:split_pos].strip())
            part = part[split_pos:].strip()
        if part:
            result.append(part)

    # Merge sentences shorter than 5 chars with the next one
    merged: list[str] = []
    i = 0
    while i < len(result):
        s = result[i]
        if len(s.strip()) < 5 and i + 1 < len(result):
            merged.append(s.strip() + ' ' + result[i + 1].strip())
            i += 2
        else:
            merged.append(s)
            i += 1

    return [s for s in merged if s.strip()]
```

Add the Pydantic request model (after existing models in the file):

```python
class SplitRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def text_max_length(cls, v: str) -> str:
        if len(v) > 5000:
            raise ValueError("Text exceeds 5000 character limit")
        return v
```

Add the endpoint (with the same `@limiter.limit` pattern as existing endpoints):

```python
@router.post("/split-sentences")
@limiter.limit("120/minute")
async def split_sentences(request: Request, body: SplitRequest):
    """Split chapter text into Vietnamese sentences for sentence-by-sentence TTS."""
    sentences = _split_into_sentences(body.text)
    return {"sentences": sentences, "count": len(sentences)}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pytest tests/test_sentence_split.py -v
```

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/tts.py backend/tests/test_sentence_split.py
git commit -m "feat(tts): Vietnamese sentence-splitting endpoint — 300-char VRAM-safe cap"
```

---

### Task 12: Add sentence queue types and Zustand state

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/lib/store.ts`

- [ ] **Step 1: Add SentenceQueueState type**

Append to `frontend/lib/types.ts`:

```typescript
// ─── Sentence Queue ───────────────────────────────────────────
export interface SentenceQueueState {
  sentences: string[]
  currentSentenceIndex: number
  sentenceAudioCache: Record<number, string>    // blob URLs — NOT persisted
  prefetchingSentenceIndex: number
  // In store (not component state) so seek logic can cancel from anywhere
  sentenceAbortControllers: Record<number, AbortController>
  currentSentenceWordTimings: WordTiming[]
}
```

- [ ] **Step 2: Add sentence queue to store**

In `frontend/lib/store.ts`, add `SentenceQueueState` to the interface and add the state + actions:

```typescript
// Initial state
sentenceQueue: {
  sentences: [],
  currentSentenceIndex: -1,
  sentenceAudioCache: {},
  prefetchingSentenceIndex: -1,
  sentenceAbortControllers: {},
  currentSentenceWordTimings: [],
} as SentenceQueueState,
```

Actions:

```typescript
setSentences: (sentences: string[]) =>
  set((state) => {
    // Revoke all blob URLs from previous chapter before replacing
    Object.values(state.sentenceQueue.sentenceAudioCache).forEach(
      (url) => URL.revokeObjectURL(url)
    )
    // Abort all in-flight prefetch requests
    Object.values(state.sentenceQueue.sentenceAbortControllers).forEach(
      (c) => c.abort()
    )
    return {
      sentenceQueue: {
        sentences,
        currentSentenceIndex: -1,
        sentenceAudioCache: {},
        prefetchingSentenceIndex: -1,
        sentenceAbortControllers: {},
        currentSentenceWordTimings: [],
      },
    }
  }),

setCurrentSentenceIndex: (index: number) =>
  set((state) => ({
    sentenceQueue: { ...state.sentenceQueue, currentSentenceIndex: index },
  })),

cacheSentenceAudio: (index: number, blobUrl: string) =>
  set((state) => ({
    sentenceQueue: {
      ...state.sentenceQueue,
      sentenceAudioCache: { ...state.sentenceQueue.sentenceAudioCache, [index]: blobUrl },
    },
  })),

evictSentenceAudio: (index: number) =>
  set((state) => {
    const cache = { ...state.sentenceQueue.sentenceAudioCache }
    if (cache[index]) {
      URL.revokeObjectURL(cache[index])  // release Blob from browser memory
      delete cache[index]
    }
    return { sentenceQueue: { ...state.sentenceQueue, sentenceAudioCache: cache } }
  }),

registerAbortController: (index: number, controller: AbortController) =>
  set((state) => ({
    sentenceQueue: {
      ...state.sentenceQueue,
      sentenceAbortControllers: {
        ...state.sentenceQueue.sentenceAbortControllers,
        [index]: controller,
      },
      prefetchingSentenceIndex: index,
    },
  })),

abortAllPrefetches: () =>
  set((state) => {
    Object.values(state.sentenceQueue.sentenceAbortControllers).forEach((c) => c.abort())
    return {
      sentenceQueue: {
        ...state.sentenceQueue,
        sentenceAbortControllers: {},
        prefetchingSentenceIndex: -1,
      },
    }
  }),

setCurrentSentenceWordTimings: (timings: WordTiming[]) =>
  set((state) => ({
    sentenceQueue: { ...state.sentenceQueue, currentSentenceWordTimings: timings },
  })),
```

**`partialize` note:** The existing `partialize` is an allowlist. Do NOT add `sentenceQueue` to it — `AbortController` instances are not JSON-serializable, blob URLs are meaningless across sessions. It will be excluded automatically.

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/store.ts
git commit -m "feat(store): sentence queue state — setSentences revokes old blobs, aborts controllers"
```

---

### Task 13: Refactor TTSPlayer to sentence-by-sentence playback

**Files:**
- Modify: `frontend/components/TTSPlayer.tsx`

> Read the existing file in full before editing. The word-timing highlight logic must be preserved — it now uses `currentSentenceWordTimings` instead of the chapter-level array.

- [ ] **Step 1: Read existing TTSPlayer.tsx completely**

Use the Read tool on `frontend/components/TTSPlayer.tsx`. Understand: where audio bytes are fetched, where word timings are set, where the `<audio>` element is managed.

- [ ] **Step 2: Add chapter-load trigger for sentence splitting**

Add a `useEffect` that fires when the loaded chapter changes:

```typescript
const currentChapter = useAppStore((s) => s.currentChapter)
const setSentences = useAppStore((s) => s.setSentences)
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

useEffect(() => {
  if (!currentChapter?.content) return

  const fetchSentences = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/tts/split-sentences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: currentChapter.content }),
      })
      if (!res.ok) throw new Error(`Split failed: ${res.status}`)
      const data = await res.json()
      setSentences(data.sentences)  // revokes previous blobs automatically
    } catch (err) {
      console.error('Failed to split chapter into sentences:', err)
    }
  }

  fetchSentences()
}, [currentChapter?.url])  // re-run when chapter URL changes, not on every content update
```

- [ ] **Step 3: Implement sentence synthesis with prefetch and AbortController**

```typescript
const cacheSentenceAudio = useAppStore((s) => s.cacheSentenceAudio)
const evictSentenceAudio = useAppStore((s) => s.evictSentenceAudio)
const registerAbortController = useAppStore((s) => s.registerAbortController)
const abortAllPrefetches = useAppStore((s) => s.abortAllPrefetches)
const setCurrentSentenceWordTimings = useAppStore((s) => s.setCurrentSentenceWordTimings)

const synthesizeSentence = async (index: number): Promise<string | null> => {
  const { sentences, sentenceAudioCache } = useAppStore.getState().sentenceQueue
  if (sentenceAudioCache[index]) return sentenceAudioCache[index]

  const controller = new AbortController()
  registerAbortController(index, controller)

  try {
    const res = await fetch(`${apiUrl}/api/tts/synthesize-with-timing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: sentences[index],
        provider: ttsSettings.preferredProvider,
        // pass API keys and voice settings as needed
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`)
    const data = await res.json()
    // data.audio_base64, data.word_timings
    const audioBytes = Uint8Array.from(atob(data.audio_base64), c => c.charCodeAt(0))
    const blob = new Blob([audioBytes], { type: 'audio/mpeg' })
    const blobUrl = URL.createObjectURL(blob)
    cacheSentenceAudio(index, blobUrl)
    return blobUrl
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null  // Seek cancelled this prefetch — silently discard
    }
    console.error(`Sentence ${index} synthesis failed:`, err)
    return null
  }
}
```

- [ ] **Step 4: Implement sentence playback loop**

```typescript
const playSentence = async (index: number) => {
  const url = await synthesizeSentence(index)
  if (!url || !audioRef.current) return

  // Update word timings for this sentence
  // (fetch timings separately or include in synthesize response)
  audioRef.current.src = url
  audioRef.current.play()
  setCurrentSentenceIndex(index)

  // Prefetch the next sentence
  const next = index + 1
  const { sentences } = useAppStore.getState().sentenceQueue
  if (next < sentences.length) {
    synthesizeSentence(next)  // fire-and-forget; AbortController handles cancellation
  }

  // Evict sentence from 2 before current (retain current-1, current, current+1)
  const toEvict = index - 2
  if (toEvict >= 0) evictSentenceAudio(toEvict)
}
```

Wire into `<audio>` `onEnded` handler:

```typescript
const handleSentenceEnded = () => {
  const { sentences, currentSentenceIndex } = useAppStore.getState().sentenceQueue
  const nextIndex = currentSentenceIndex + 1

  // Mark chapter finished when the last sentence ends
  const isLastSentence = currentSentenceIndex >= sentences.length - 1
  if (isLastSentence) {
    if (currentChapterUrl) {
      markChapterFinished(currentChapterUrl)
      syncProgress(currentChapterUrl, currentSentenceIndex, -1, true)
    }
    return
  }

  playSentence(nextIndex)
  if (currentChapterUrl) {
    syncProgress(currentChapterUrl, nextIndex, -1, false)
  }
}
```

- [ ] **Step 5: Handle manual seek to sentence M**

```typescript
const seekToSentence = async (index: number) => {
  abortAllPrefetches()  // cancel all in-flight fetches immediately
  await playSentence(index)
  if (currentChapterUrl) {
    syncProgress(currentChapterUrl, index, -1, false)
  }
}
```

- [ ] **Step 6: Cleanup on unmount**

```typescript
useEffect(() => {
  return () => {
    // Revoke all cached blob URLs and clear the store
    const cache = useAppStore.getState().sentenceQueue.sentenceAudioCache
    Object.values(cache).forEach((url) => URL.revokeObjectURL(url))
    useAppStore.getState().abortAllPrefetches()
    // Reset sentence queue via setSentences([]) to clear stale cache keys in store
    useAppStore.getState().setSentences([])
  }
}, [])
```

- [ ] **Step 7: Manual test**

1. Load a chapter → observe "S.1/N" counter in player bar
2. Press Play → audio starts for sentence 1
3. Let run → sentence 2 starts automatically (confirms prefetch worked)
4. Click sentence 5 button → audio jumps to sentence 5, no lingering "abort" toasts
5. DevTools → Memory → take heap snapshot → confirm blob URL count stays bounded

- [ ] **Step 8: Commit**

```bash
git add frontend/components/TTSPlayer.tsx
git commit -m "feat(tts): sentence-by-sentence playback — prefetch, AbortController, blob cleanup"
```

---

## Chunk 4: Sync Hook + XTTS Provider

---

### Task 14: Build useSyncProgress hook

**Files:**
- Create: `frontend/lib/hooks/useSyncProgress.ts`

- [ ] **Step 1: Create useSyncProgress**

Create `frontend/lib/hooks/useSyncProgress.ts`:

```typescript
'use client'

import { useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/lib/store'

/**
 * Returns a sync function that debounces reading progress upserts to Supabase.
 * Call on every sentence advance. Guest users (no userId): no-op.
 */
export function useSyncProgress() {
  const userId = useAppStore((s) => s.authState.supabaseUserId)
  const setAuthState = useAppStore((s) => s.setAuthState)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  return useCallback(
    (chapterUrl: string, sentenceIndex: number, wordIndex: number, isFinished: boolean) => {
      if (!userId) return  // guest mode — no-op

      if (debounceRef.current) clearTimeout(debounceRef.current)

      debounceRef.current = setTimeout(async () => {
        setAuthState({ syncStatus: 'syncing' })
        try {
          const { error } = await supabase.from('reading_progress').upsert(
            {
              user_id: userId,
              chapter_url: chapterUrl,
              sentence_index: sentenceIndex,
              word_index: wordIndex,
              is_finished: isFinished,
            },
            { onConflict: 'user_id,chapter_url' }
          )
          setAuthState({ syncStatus: error ? 'offline' : 'synced' })
        } catch {
          setAuthState({ syncStatus: 'offline' })
        }
      }, 1000)
    },
    [userId, setAuthState]
  )
}
```

- [ ] **Step 2: Add resume-on-return to TTSPlayer**

In `frontend/components/TTSPlayer.tsx`, after sentences are fetched (in the `useEffect` from Task 13, Step 2), add a resume check:

```typescript
// After setSentences(data.sentences):
const userId = useAppStore.getState().authState.supabaseUserId
if (userId && currentChapterUrl) {
  const { data: progress } = await supabase
    .from('reading_progress')
    .select('sentence_index')
    .eq('user_id', userId)
    .eq('chapter_url', currentChapterUrl)
    .single()

  if (progress && progress.sentence_index > 0) {
    setResumeFromIndex(progress.sentence_index)  // triggers resume toast
  }
}
```

Resume toast JSX (in TTSPlayer, positioned above the player bar):

```tsx
{resumeFromIndex > 0 && (
  <div className="absolute bottom-full left-0 right-0 mb-2 mx-4 flex items-center justify-between rounded-xl bg-violet-900/80 px-4 py-2 text-sm text-white backdrop-blur">
    <span>Tiếp tục từ câu {resumeFromIndex + 1}?</span>
    <div className="flex gap-2">
      <button
        onClick={() => { seekToSentence(resumeFromIndex); setResumeFromIndex(0) }}
        className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-medium hover:bg-violet-500"
      >
        Tiếp tục
      </button>
      <button onClick={() => setResumeFromIndex(0)} className="text-xs text-gray-400 hover:text-white">
        Bỏ qua
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 3: End-to-end sync test**

1. Sign in → load chapter → play through 3 sentences
2. Supabase Dashboard → reading_progress → verify row with correct `sentence_index`
3. Reload browser → open same chapter → resume toast should appear

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/hooks/useSyncProgress.ts frontend/components/TTSPlayer.tsx
git commit -m "feat(sync): sentence-level progress sync to Supabase + resume-on-return toast"
```

---

### Task 15: Build XTTS-v2 backend service (synchronous)

**Files:**
- Create: `backend/services/tts_xtts.py`
- Create: `backend/tests/test_tts_xtts.py`

> **Design note:** `tts_xtts.py` uses **synchronous** `httpx.Client` (not `AsyncClient`). This is intentional — the existing `_run_provider_chain()` is a sync function, and using `asyncio.run()` inside a sync function that is itself called from an async FastAPI handler would raise `RuntimeError: This event loop is already running`. Synchronous httpx calls in a FastAPI async handler briefly block the event loop, which is acceptable for a 300-char sentence (~0.5–2s inference). If needed in the future, the chain can be made fully async.

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_tts_xtts.py`:

```python
"""Tests for XTTS-v2 Coqui TTS synchronous HTTP service."""
import pytest
import httpx
from unittest.mock import patch, MagicMock
from services.tts_xtts import synthesize, XTTSTTSError, XTTSQuotaError


def test_synthesize_returns_bytes_on_success():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.content = b"RIFF....WAV"

    with patch("services.tts_xtts.httpx.Client") as MockClient:
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get = MagicMock(return_value=mock_response)
        MockClient.return_value = mock_client

        result = synthesize("Xin chào", endpoint="http://localhost:5002")
        assert result == b"RIFF....WAV"


def test_synthesize_raises_quota_on_429():
    mock_response = MagicMock(status_code=429)

    with patch("services.tts_xtts.httpx.Client") as MockClient:
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get = MagicMock(return_value=mock_response)
        MockClient.return_value = mock_client

        with pytest.raises(XTTSQuotaError):
            synthesize("text", endpoint="http://localhost:5002")


def test_synthesize_raises_error_on_connection_refused():
    with patch("services.tts_xtts.httpx.Client") as MockClient:
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get = MagicMock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        MockClient.return_value = mock_client

        with pytest.raises(XTTSTTSError, match="unreachable"):
            synthesize("text", endpoint="http://localhost:5002")


def test_synthesize_rejects_text_over_300_chars():
    with pytest.raises(XTTSTTSError, match="300"):
        synthesize("x" * 301, endpoint="http://localhost:5002")
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/test_tts_xtts.py -v
```

Expected: `ModuleNotFoundError: No module named 'services.tts_xtts'`.

- [ ] **Step 3: Implement tts_xtts.py (synchronous)**

Create `backend/services/tts_xtts.py`:

```python
"""
Coqui XTTS-v2 Vietnamese TTS service — synchronous HTTP client.

Calls the Coqui TTS server hosting thivux/XTTS-v2-vietnamse.

User setup:
  pip install TTS
  tts-server --model_name tts_models/vi/thivux/xtts_v2 --port 5002

API:
  GET http://{endpoint}/api/tts?text={encoded_text}&language=vi
  → WAV audio bytes

Note: Synchronous httpx is used intentionally to avoid asyncio.run() deadlock
inside the synchronous _run_provider_chain() function in routers/tts.py.
"""

import os
import urllib.parse

import httpx


class XTTSTTSError(Exception):
    pass


class XTTSQuotaError(XTTSTTSError):
    pass


_DEFAULT_ENDPOINT = "http://localhost:5002"
_MAX_TEXT_LENGTH = 300


def synthesize(
    text: str,
    language: str = "vi",
    endpoint: str | None = None,
) -> bytes:
    """
    Synthesize a single sentence via Coqui TTS HTTP API (synchronous).

    Args:
        text: Sentence to synthesize. Must be ≤300 chars.
        language: Language code (default: "vi").
        endpoint: Server base URL. Falls back to XTTS_ENDPOINT env var.

    Returns:
        WAV audio bytes.

    Raises:
        XTTSTTSError: Server unreachable, error response, or text too long.
        XTTSQuotaError: HTTP 429 / 503.
    """
    if len(text) > _MAX_TEXT_LENGTH:
        raise XTTSTTSError(
            f"Text length {len(text)} exceeds {_MAX_TEXT_LENGTH}-char VRAM-safety limit."
        )

    base = endpoint or os.getenv("XTTS_ENDPOINT", _DEFAULT_ENDPOINT)
    url = f"{base}/api/tts?text={urllib.parse.quote(text)}&language={language}"

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(url)
    except httpx.ConnectError as e:
        raise XTTSTTSError(
            f"XTTS server unreachable at {base}. "
            "Is the Coqui TTS server running? See README → XTTS Setup. "
            f"Detail: {e}"
        )
    except httpx.TimeoutException as e:
        raise XTTSTTSError(f"XTTS request timed out (30s): {e}")
    except httpx.HTTPError as e:
        raise XTTSTTSError(f"XTTS HTTP error: {e}")

    if response.status_code in (429, 503):
        raise XTTSQuotaError(f"XTTS server overloaded (HTTP {response.status_code})")
    if response.status_code != 200:
        raise XTTSTTSError(
            f"XTTS returned HTTP {response.status_code}: {response.text[:200]}"
        )
    return response.content
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pytest tests/test_tts_xtts.py -v
```

Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/services/tts_xtts.py backend/tests/test_tts_xtts.py
git commit -m "feat(xtts): synchronous Coqui XTTS-v2 service — 300-char cap, httpx.Client"
```

---

### Task 16: Wire XTTS into TTS chain and settings

**Files:**
- Modify: `backend/routers/tts.py`
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/components/SettingsPanel.tsx`

- [ ] **Step 1: Update TTSProvider type**

In `frontend/lib/types.ts`:
```typescript
// Before:
export type TTSProvider = "gemini" | "openai" | "minimax" | "gtranslate"
// After:
export type TTSProvider = "gemini" | "openai" | "minimax" | "xtts" | "gtranslate"
```

Also add `xttsEndpoint` to `TTSSettings`:
```typescript
xttsEndpoint: string  // default: "http://localhost:5002"
```

In store initial state:
```typescript
xttsEndpoint: "http://localhost:5002",
```

- [ ] **Step 2: Add XTTS to provider chain in tts.py**

In `backend/routers/tts.py`, update the provider order constant:
```python
PROVIDER_ORDER = ["gemini", "openai", "minimax", "xtts", "gtranslate"]
```

Add the XTTS block inside `_run_provider_chain()` between MiniMax and GTranslate:

```python
from services.tts_xtts import synthesize as xtts_synthesize, XTTSTTSError, XTTSQuotaError

# In _run_provider_chain(), after MiniMax block:
if current_provider == "xtts":
    try:
        xtts_endpoint = request_xtts_endpoint or os.getenv("XTTS_ENDPOINT", "http://localhost:5002")
        audio_bytes = xtts_synthesize(text, endpoint=xtts_endpoint)
        return audio_bytes, "xtts", False, first_error
    except XTTSQuotaError as e:
        if not first_error:
            first_error = str(e)
        logger.warning("XTTS overloaded, falling back: %s", e)
    except XTTSTTSError as e:
        if not first_error:
            first_error = str(e)
        logger.warning("XTTS error, falling back: %s", e)
    current_provider = _next_provider(current_provider)
```

Update `TTSRequest` model to accept the endpoint override:
```python
xtts_endpoint: str | None = None
```

- [ ] **Step 3: Add XTTS to SettingsPanel**

In `frontend/components/SettingsPanel.tsx`:

Add XTTS radio card in the provider group:
```tsx
<label>
  <input type="radio" value="xtts" checked={...} onChange={...} />
  <div>
    <p>Local XTTS (Vietnamese)</p>
    <p>thivux/XTTS-v2 · Cần Coqui TTS server</p>
  </div>
</label>
```

Add XTTS endpoint section as a `CollapsibleSection` (see Task 20) — visible **always** (not gated on preferred provider) so fallback users can configure it:

```tsx
<CollapsibleSection title="Local XTTS Server" defaultOpen={false}>
  <div>
    <label className="text-xs text-gray-400">Endpoint URL</label>
    <input
      type="url"
      value={ttsSettings.xttsEndpoint}
      onChange={(e) => updateTTSSettings({ xttsEndpoint: e.target.value })}
      placeholder="http://localhost:5002"
      className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
    />
  </div>
  <a href="https://github.com/TuanBew/AI-Truyen-Audio-Reader#xtts-setup"
     target="_blank" rel="noopener noreferrer"
     className="text-xs text-violet-400 hover:underline">
    Hướng dẫn cài đặt XTTS-v2 →
  </a>
</CollapsibleSection>
```

- [ ] **Step 4: Run all backend tests**

```bash
pytest tests/ -v
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/tts.py frontend/lib/types.ts frontend/components/SettingsPanel.tsx
git commit -m "feat(xtts): wire XTTS into provider chain + settings panel

- Provider order: Gemini → OpenAI → MiniMax → XTTS → GTranslate
- TTSProvider type adds 'xtts'; xttsEndpoint in TTSSettings
- XTTS endpoint config always visible in settings (not gated on preferred provider)"
```

---

## Chunk 5: UI Polish + Security + Docs

---

### Task 17: Premium dark-mode typography

**Files:**
- Modify: `frontend/app/layout.tsx`
- Modify: `frontend/app/globals.css`
- Modify: `frontend/components/ReaderPanel.tsx`

> **Tailwind v4 note:** This project uses Tailwind CSS v4 which uses CSS-first configuration. Font customization uses `@theme` in `globals.css` — there is NO `tailwind.config.ts` to edit.

- [ ] **Step 1: Add Inter font via next/font**

In `frontend/app/layout.tsx`:

```typescript
import { Inter } from 'next/font/google'

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-inter',
})

// Add inter.variable to the className of <html> or <body>:
// <html className={inter.variable}>
```

- [ ] **Step 2: Register font in Tailwind v4 via globals.css**

In `frontend/app/globals.css`, find the `@theme` block (or add one if absent) and add:

```css
@theme {
  --font-sans: var(--font-inter), system-ui, sans-serif;
}
```

- [ ] **Step 3: Update ReaderPanel typography**

In `frontend/components/ReaderPanel.tsx`, update the chapter content container:

```tsx
<div className="mx-auto max-w-[72ch] text-[1.25rem] leading-[1.85] text-gray-100 [&>p]:mb-[1.5em] font-sans tracking-wide">
  {words.map((word, idx) => (
    <span
      key={idx}
      className={
        idx === highlightedWordIndex
          ? 'text-amber-300 underline decoration-amber-400/50 decoration-2'
          : ''
      }
    >
      {word}{' '}
    </span>
  ))}
</div>
```

- [ ] **Step 4: Visual verification**

Open a chapter. Verify in browser DevTools:
- Computed font-family includes Inter
- Font size: 20px
- Line height: 1.85
- Highlighted word: amber underline (no harsh yellow background)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/layout.tsx frontend/app/globals.css frontend/components/ReaderPanel.tsx
git commit -m "feat(ui): Kindle-style typography — Inter, 20px/1.85lh/72ch, amber highlight"
```

---

### Task 18: Build AudioVisualizer component

**Files:**
- Create: `frontend/components/AudioVisualizer.tsx`
- Modify: `frontend/components/TTSPlayer.tsx`

- [ ] **Step 1: Create AudioVisualizer**

Create `frontend/components/AudioVisualizer.tsx`:

```typescript
'use client'

import { useEffect, useRef } from 'react'

interface Props {
  audioElement: HTMLAudioElement | null
  isPlaying: boolean
}

const BAR_COUNT = 28
const FFT_SIZE = 64        // yields 32 frequency bins
const BIN_START = 2        // skip DC offset (0) and sub-bass (1)
// Use bins 2–29 (28 bins in speech frequency range for Vietnamese)

export default function AudioVisualizer({ audioElement, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const connectedElementRef = useRef<HTMLAudioElement | null>(null)
  // Use a ref for idleTime to prevent unbounded float accumulation across re-renders
  const idleTimeRef = useRef(0)

  useEffect(() => {
    if (!audioElement || !canvasRef.current) return

    // Create AudioContext lazily (requires user gesture first)
    if (!contextRef.current) {
      contextRef.current = new AudioContext()
    }
    const ctx = contextRef.current

    // If audioElement changed, disconnect the old source node first
    if (sourceRef.current && connectedElementRef.current !== audioElement) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }

    // Connect new element (only once per element reference)
    if (!sourceRef.current) {
      try {
        sourceRef.current = ctx.createMediaElementSource(audioElement)
        connectedElementRef.current = audioElement
        analyserRef.current = ctx.createAnalyser()
        analyserRef.current.fftSize = FFT_SIZE
        analyserRef.current.smoothingTimeConstant = 0.8
        sourceRef.current.connect(analyserRef.current)
        analyserRef.current.connect(ctx.destination)
      } catch (e) {
        // HTMLMediaElement already connected — log and continue (idle animation only)
        console.warn('AudioVisualizer: could not connect audio element', e)
      }
    }

    const analyser = analyserRef.current
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const canvas = canvasRef.current
    const canvasCtx = canvas.getContext('2d')!

    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      const { width, height } = canvas
      canvasCtx.clearRect(0, 0, width, height)
      const barWidth = Math.floor(width / BAR_COUNT) - 1

      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = BIN_START + i
        const value = dataArray[binIndex] / 255

        let displayValue = value
        if (!isPlaying || value < 0.01) {
          // Wrap idleTime to prevent float precision loss over long sessions
          idleTimeRef.current = (idleTimeRef.current + 0.04) % (Math.PI * 2)
          displayValue = 0.15 + 0.07 * Math.sin(idleTimeRef.current + i * 0.4)
        }

        const barHeight = Math.max(2, displayValue * (height - 4))
        const x = i * (barWidth + 1)
        const y = height - barHeight

        const gradient = canvasCtx.createLinearGradient(0, y, 0, height)
        gradient.addColorStop(0, '#a78bfa')
        gradient.addColorStop(1, '#7c3aed')
        canvasCtx.fillStyle = gradient
        canvasCtx.beginPath()
        canvasCtx.roundRect(x, y, barWidth, barHeight, 2)
        canvasCtx.fill()
      }
    }

    if (ctx.state === 'suspended') ctx.resume()
    draw()

    return () => cancelAnimationFrame(animFrameRef.current)
  }, [audioElement, isPlaying])

  return (
    <canvas
      ref={canvasRef}
      width={BAR_COUNT * 9}
      height={32}
      className="w-full"
      aria-hidden="true"
    />
  )
}
```

- [ ] **Step 2: Integrate into TTSPlayer**

In `frontend/components/TTSPlayer.tsx`, import and add `<AudioVisualizer>` in the fixed player bar between the controls row and the metadata row:

```typescript
import AudioVisualizer from './AudioVisualizer'

// In JSX:
<AudioVisualizer audioElement={audioRef.current} isPlaying={playerState.isPlaying} />
```

- [ ] **Step 3: Visual test**

Play a sentence — bars should animate. Pause — bars fade to breathing pulse. Seek — bars reset smoothly.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/AudioVisualizer.tsx frontend/components/TTSPlayer.tsx
git commit -m "feat(ui): 28-bar FFT visualizer — bins 2–29, violet gradient, idleTime breathing"
```

---

### Task 19: Polish settings panel hierarchy

**Files:**
- Modify: `frontend/components/SettingsPanel.tsx`

- [ ] **Step 1: Add CollapsibleSection helper and reorganize**

Add the `CollapsibleSection` component inside `SettingsPanel.tsx` (not exported, local use only):

```typescript
function CollapsibleSection({
  title, badge, defaultOpen = false, children
}: {
  title: string
  badge?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-xl border border-white/10">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-gray-300">{title}</span>
        <div className="flex items-center gap-2">
          {badge && <span className="text-xs text-green-400">{badge}</span>}
          <span className="text-xs text-gray-500">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && <div className="border-t border-white/10 px-4 pb-4 pt-2">{children}</div>}
    </div>
  )
}
```

Reorganize the settings sections in this render order:

1. **TTS Provider** — radio cards (no collapse; always visible)
2. **Playback** — speed slider, pitch slider, auto-advance toggle (no collapse)
3. **Voice Selection** — collapsible, open by default, shows only current provider's voice
4. **Google Cloud Credentials** — collapsible, badge shows "Configured ✓" when connected
5. **OpenAI API Key** — collapsible
6. **MiniMax API Key** — collapsible
7. **Local XTTS Server** — collapsible (always rendered, not gated on provider selection)

- [ ] **Step 2: Visual verification**

Open Settings. Confirm:
- Provider radios visible immediately without scrolling
- Speed/pitch sliders visible without scrolling
- Credentials section shows "Configured ✓" when Google Cloud is connected
- All API key sections are collapsed by default

- [ ] **Step 3: Commit**

```bash
git add frontend/components/SettingsPanel.tsx
git commit -m "feat(ui): settings panel hierarchy — primary controls first, credentials collapsed"
```

---

### Task 20: Security audit and hardening

**Files:**
- Modify: `.gitignore`
- Verify: `backend/main.py`
- Create: `backend/.env.example`

- [ ] **Step 1: Verify .gitignore with test files**

Create test secrets and confirm they are ignored:

```bash
# Create temporary test files
echo "TEST=1" > backend/.env
echo '{"type":"service_account"}' > backend/credentials/test.json

# Check they are NOT tracked
git ls-files --others --exclude-standard backend/.env
# Expected: no output (ignored)

git ls-files --others --exclude-standard backend/credentials/
# Expected: no output (ignored)

# Clean up test files
rm backend/.env
rm backend/credentials/test.json
```

If any file shows up as untracked (not ignored), fix `.gitignore` and repeat.

- [ ] **Step 2: Verify CORS has no wildcard**

Read `backend/main.py`. Find `CORSMiddleware` configuration. It must read:

```python
allow_origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")]
```

There must be **no** `allow_origins=["*"]`. If found, fix it immediately.

- [ ] **Step 3: Create backend/.env.example**

Create `backend/.env.example`:

```env
# ─── Google Cloud TTS ──────────────────────────────────────────
GOOGLE_APPLICATION_CREDENTIALS=./credentials/service_account.json

# ─── OpenAI TTS ────────────────────────────────────────────────
OPENAI_API_KEY=

# ─── MiniMax TTS ───────────────────────────────────────────────
MINIMAX_API_KEY=
MINIMAX_GROUP_ID=

# ─── Local XTTS-v2 ─────────────────────────────────────────────
# Run: tts-server --model_name tts_models/vi/thivux/xtts_v2 --port 5002
XTTS_ENDPOINT=http://localhost:5002

# ─── App Config ────────────────────────────────────────────────
FRONTEND_ORIGIN=http://localhost:3000
SCRAPER_RATE_LIMIT=30
```

- [ ] **Step 4: Run final test suite**

```bash
cd backend
pytest tests/ -v --tb=short
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add .gitignore backend/.env.example
git commit -m "security: gitignore audit, CORS verified, env.example templates"
```

---

### Task 21: Write README and push to main

**Files:**
- Create/update: `README.md`

> Note: `frontend/.env.local.example` was created in Task 6.

- [ ] **Step 1: Write README.md**

```markdown
# AI Truyen Audio Reader

Vietnamese light-novel audiobook reader. Scrapes chapters from truyenplus.vn,
synthesizes them sentence-by-sentence (4 GB VRAM safe), and syncs your
reading position to the cloud.

## Features

- Real-time word highlighting during TTS playback
- Sentence-by-sentence synthesis (4 GB VRAM safe with local XTTS-v2)
- Cloud sync via Supabase — resume from exact sentence on any device
- TTS providers: Google Gemini · OpenAI · MiniMax · Local XTTS-v2 · Google Translate
- Email/Password + Google OAuth authentication
- Guest mode — no account required; sign in to enable cloud sync

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- A Supabase project (free tier works)

### 1. Backend

```bash
git clone https://github.com/TuanBew/AI-Truyen-Audio-Reader.git
cd AI-Truyen-Audio-Reader/backend
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
cp .env.example .env            # edit with your API keys
uvicorn main:app --reload --port 8000
```

### 2. Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local  # edit with Supabase URL + anon key
npm run dev
```

Open http://localhost:3000

### 3. Supabase Setup

1. Create project at https://supabase.com
2. SQL Editor → paste and run `supabase/migrations/001_initial_schema.sql`
3. Authentication → Providers → Google → enable with your OAuth credentials
4. Copy URL + anon key to `frontend/.env.local`

### 4. Local XTTS-v2 (Optional) {#xtts-setup}

High-quality Vietnamese TTS with no API key (requires ~2–4 GB RAM/VRAM):

```bash
pip install TTS
tts-server --model_name tts_models/vi/thivux/xtts_v2 --port 5002
```

Select "Local XTTS (Vietnamese)" in Settings. Configure the endpoint URL
if you use a different port (Settings → Local XTTS Server → Endpoint URL).

## Architecture

See `docs/superpowers/specs/2026-03-12-audiotruyen-refactor-design.md`

## License

MIT
```

- [ ] **Step 2: Final test run**

```bash
cd backend && pytest tests/ -v
cd ../frontend && npm run build
```

Both must succeed.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: README with quick-start, XTTS setup, Supabase instructions"
git push origin feat/production-upgrade
```

- [ ] **Step 4: Open pull request**

```bash
gh pr create \
  --title "feat: production upgrade — Supabase sync, XTTS-v2, sentence TTS, auth, UI polish" \
  --body "Full design: docs/superpowers/specs/2026-03-12-audiotruyen-refactor-design.md" \
  --base main
```

---

## Summary

| Phase | Tasks | Key outcome |
|---|---|---|
| P0 Git + pytest | 1–2 | Repo initialized, pushed, pytest with asyncio_mode=auto |
| P1 ADC Fix | 3–4 | Gemini TTS works without restart after credential upload |
| P2 Schema | 5 | Supabase tables, 2 RLS policies each, user_id index |
| P3 Auth | 6–10 | Email/Google sign-in, migration guard, stale-closure-safe |
| P4 Pipeline | 11–13 | Sentence TTS, prefetch, AbortController, blob lifecycle |
| P5 Sync | 14 | Sentence progress → Supabase, resume toast on return |
| P6 XTTS | 15–16 | Sync Coqui service, provider chain, settings always accessible |
| P7 UI | 17–19 | Inter 20px/1.85lh, FFT visualizer, settings hierarchy |
| P8 Security | 20 | gitignore test-verified, CORS confirmed, env.example |
| P9 Docs | 21 | README, PR opened |
