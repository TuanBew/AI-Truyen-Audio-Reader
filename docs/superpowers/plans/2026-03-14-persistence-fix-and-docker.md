# Persistence Fix + Docker Production Setup

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix saves disappearing after restart/re-login by pulling cloud data into local state on sign-in, then package the app as production Docker containers.

**Architecture:** The persistence bug is a missing pull in `useAuth.ts` — the app already pushes local→Supabase but never fetches Supabase→local. The Docker setup uses Next.js standalone output (3-stage build) and a Python slim backend wired by docker-compose.

**Tech Stack:** Next.js 16 standalone, Zustand persist, Supabase JS client, FastAPI/uvicorn, Docker Compose v2

---

## Chunk 1: Cloud → Local data hydration (persistence fix)

### Task 1: Export `novelIdFromUrl` and add `mergeCloudData` to the Zustand store

**Files:**
- Modify: `frontend/lib/store.ts`

This task adds the store action that `useAuth.ts` will call to safely union cloud novels and finished chapter URLs into local state without discarding any existing local progress.

- [ ] **Step 1: Export `novelIdFromUrl`**

In `frontend/lib/store.ts`, change the function declaration on line 36 from:
```ts
function novelIdFromUrl(url: string): string {
```
to:
```ts
export function novelIdFromUrl(url: string): string {
```

- [ ] **Step 2: Add `mergeCloudData` to the `AppStore` interface**

In `frontend/lib/store.ts`, inside the `interface AppStore extends AppState` block, add after the `setAuthState` line (around line 92):
```ts
  // Cloud sync
  mergeCloudData: (cloudNovels: SavedNovel[], cloudFinishedUrls: string[]) => void
```

- [ ] **Step 3: Implement `mergeCloudData`**

In the `create<AppStore>()` implementation block, add after the `setAuthState` implementation (around line 308):
```ts
      // ── Cloud sync ────────────────────────────────────────
      mergeCloudData: (cloudNovels: SavedNovel[], cloudFinishedUrls: string[]) =>
        set((s) => {
          // Local wins on conflict: only add novels that don't exist locally yet
          const existingUrls = new Set(s.savedNovels.map((n) => n.url))
          const newNovels = cloudNovels.filter((n) => !existingUrls.has(n.url))
          // Union finished chapters (a chapter once finished stays finished)
          const mergedFinished = [...new Set([...s.finishedChapterUrls, ...cloudFinishedUrls])]
          return {
            savedNovels: [...s.savedNovels, ...newNovels],
            finishedChapterUrls: mergedFinished,
          }
        }),
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/store.ts
git commit -m "feat(store): export novelIdFromUrl, add mergeCloudData action"
```

---

### Task 2: Load user data from Supabase on sign-in

**Files:**
- Modify: `frontend/lib/hooks/useAuth.ts`

This is the core fix. On every sign-in (fresh login or page refresh with existing session), we first push guest state to Supabase (existing behavior), then pull all cloud data back into the local store.

- [ ] **Step 1: Add imports to `useAuth.ts`**

Replace the existing import block at the top of `frontend/lib/hooks/useAuth.ts`:
```ts
'use client'

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAppStore, novelIdFromUrl } from '@/lib/store'
import type { SavedNovel, TocData } from '@/lib/types'
```

- [ ] **Step 2: Add `loadUserDataFromSupabase` function**

Add this function at the bottom of `frontend/lib/hooks/useAuth.ts`, after the closing brace of `migrateGuestStateToSupabase`:

```ts
// ─── Cloud → Local hydration ──────────────────────────────

async function loadUserDataFromSupabase(userId: string) {
  // Fetch all novels belonging to this user
  const { data: novelRows } = await supabase
    .from('novels')
    .select('url, title, cover_url, total_chapters, toc, added_at, last_chapter_url, last_chapter_title')
    .eq('user_id', userId)

  // Fetch all finished chapter URLs
  const { data: progressRows } = await supabase
    .from('reading_progress')
    .select('chapter_url')
    .eq('user_id', userId)
    .eq('is_finished', true)

  const cloudNovels: SavedNovel[] = (novelRows ?? []).map((row) => ({
    id: novelIdFromUrl(row.url),
    url: row.url,
    title: row.title,
    coverUrl: row.cover_url,
    totalChapters: row.total_chapters,
    addedAt: new Date(row.added_at).getTime(),
    lastChapterUrl: row.last_chapter_url,
    lastChapterTitle: row.last_chapter_title,
    toc: row.toc as TocData,
  }))

  const cloudFinishedUrls: string[] = (progressRows ?? []).map((r) => r.chapter_url)

  useAppStore.getState().mergeCloudData(cloudNovels, cloudFinishedUrls)
}
```

- [ ] **Step 3: Call `loadUserDataFromSupabase` in the sign-in handler**

In `useAuth.ts`, update `migrateGuestStateToSupabase` calls in both places (the `getSession` handler and the `onAuthStateChange` handler) to also call `loadUserDataFromSupabase` afterward.

Replace the existing `try/catch` blocks in both handlers. They currently look like:
```ts
          try {
            await migrateGuestStateToSupabase(session.user.id)
            setAuthState({ syncStatus: 'synced' })
          } catch {
            setAuthState({ syncStatus: 'offline' })
          }
```

Replace both with:
```ts
          // Separate try/catch: migration failure must NOT block the cloud pull.
          // If push fails (e.g. offline), we still want to restore cloud data.
          try {
            await migrateGuestStateToSupabase(session.user.id)
          } catch { /* best-effort — local data may not have uploaded */ }
          try {
            await loadUserDataFromSupabase(session.user.id)
            setAuthState({ syncStatus: 'synced' })
          } catch {
            setAuthState({ syncStatus: 'offline' })
          }
```

Note: Both the `getSession` block and the `onAuthStateChange` `SIGNED_IN` block need this change.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 5: Manual smoke test**

1. Start dev servers: backend on :8000, frontend on :3000
2. Log in with a Supabase account that has saved novels in the DB
3. Open DevTools → Application → Local Storage → clear `audiotruyen-store`
4. Refresh the page (session cookie still valid, so auto-sign-in fires)
5. Expected: saved novels reappear on the home page

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/hooks/useAuth.ts
git commit -m "fix(auth): pull cloud novels and finished chapters on sign-in

Adds loadUserDataFromSupabase() called after migrateGuestStateToSupabase().
Fixes saves disappearing when localStorage is cleared or a new browser is used."
```

---

## Chunk 2: Docker production setup

### Task 3: Enable Next.js standalone output

**Files:**
- Modify: `frontend/next.config.ts`

Standalone output creates a self-contained `.next/standalone/server.js` that doesn't need `node_modules` at runtime — essential for the slim Docker runner stage.

- [ ] **Step 1: Add `output: 'standalone'` to next.config.ts**

Replace the full contents of `frontend/next.config.ts` with:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 2: Verify local build still works**

```bash
cd frontend && npm run build
```
Expected: build succeeds, `.next/standalone/` directory is created

- [ ] **Step 3: Commit**

```bash
git add frontend/next.config.ts
git commit -m "feat(frontend): enable Next.js standalone output for Docker"
```

---

### Task 4: Create `frontend/Dockerfile`

**Files:**
- Create: `frontend/Dockerfile`
- Create: `frontend/.dockerignore`

Three stages: `deps` (install), `builder` (compile), `runner` (minimal production image). `NEXT_PUBLIC_*` Supabase vars are passed as build args because Next.js bakes them into the JS bundle at compile time — they cannot be injected at runtime.

- [ ] **Step 1: Create `frontend/.dockerignore`**

Create `frontend/.dockerignore` with:
```
node_modules
.next
.env*.local
.git
.gitignore
Dockerfile
.dockerignore
docs
screenshots
*.md
```

- [ ] **Step 2: Create `frontend/Dockerfile`**

Create `frontend/Dockerfile` with:
```dockerfile
# ── Stage 1: Install dependencies ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build ────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Both NEXT_PUBLIC_* and BACKEND_URL are evaluated at build time.
# next.config.ts rewrites() is called during `next build`, so the rewrite
# destination is resolved from process.env at build time, not at runtime.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG BACKEND_URL=http://localhost:8000
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV BACKEND_URL=$BACKEND_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 3: Production runner ────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# standalone output already includes its own node_modules snapshot
COPY --from=builder /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: Commit**

```bash
git add frontend/Dockerfile frontend/.dockerignore
git commit -m "feat(docker): add production Dockerfile for Next.js frontend"
```

---

### Task 5: Create `backend/Dockerfile`

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

Python slim image with gcc for any compiled packages. Runtime env vars (API keys, credentials path) come from docker-compose via `env_file`.

- [ ] **Step 1: Create `backend/.dockerignore`**

Create `backend/.dockerignore` with:
```
__pycache__
*.pyc
*.pyo
.venv
venv
.env
.env.*
tests/
*.md
.git
.gitignore
Dockerfile
.dockerignore
.audio_state.json
credentials/
```

Note: `credentials/` is excluded from the image — it's mounted as a volume at runtime so keys never bake into the image layer.

- [ ] **Step 2: Create `backend/Dockerfile`**

Create `backend/Dockerfile` with:
```dockerfile
FROM python:3.11-slim
WORKDIR /app

# gcc required by some Python packages (e.g. aiofiles native extensions)
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 3: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore
git commit -m "feat(docker): add production Dockerfile for FastAPI backend"
```

---

### Task 6: Create `docker-compose.yml` and root `.env.example`

**Files:**
- Create: `docker-compose.yml` (project root)
- Create: `.env.example` (project root)

The compose file wires the two services together. Backend uses `env_file: ./backend/.env` for API keys (unchanged from local dev). The `NEXT_PUBLIC_*` vars and `BACKEND_URL` come from a root `.env` file that Docker Compose reads automatically for variable substitution in `args`.

**Why `BACKEND_URL` is set at both build time and runtime:** Next.js evaluates `next.config.ts` rewrites during `next build` (compiling them into `routes-manifest.json`) AND again when the standalone `server.js` starts. To be safe regardless of which evaluation path fires, `BACKEND_URL` is passed as a build arg (so the manifest is correct) AND as a runtime `environment:` entry (so the standalone server sees it at startup). This also allows overriding it without rebuilding the image.

- [ ] **Step 1: Create root `.env.example`**

Create `.env.example` at the project root:
```
# Copy this file to .env before running `docker compose build`
#
# These Supabase values are baked into the frontend JS bundle at build time.
# Get them from: Supabase Dashboard → your project → Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

- [ ] **Step 2: Create `docker-compose.yml`**

Create `docker-compose.yml` at the project root:
```yaml
services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "8000:8000"
    # Reads OPENAI_API_KEY, MINIMAX_*, XTTS_ENDPOINT, SCRAPER_RATE_LIMIT from backend/.env
    env_file: ./backend/.env
    environment:
      # Override to point at Docker-exposed frontend (for CORS)
      FRONTEND_ORIGIN: http://localhost:3000
      # Credentials are mounted below — override the path for the container
      GOOGLE_APPLICATION_CREDENTIALS: /app/credentials/service_account.json
    volumes:
      # Google Cloud TTS service account — mount read-only, never bake into image
      - ./backend/credentials:/app/credentials:ro
      # Audio files saved by the app persist across container restarts.
      # IMPORTANT: In the app's Settings panel, set the save directory to /audio
      # so recorded files land inside this volume instead of an ephemeral path.
      - audio_output:/audio
    restart: unless-stopped

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        # Read from root .env (Docker Compose auto-loads .env for substitution)
        NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL}
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}
        # Set at build time so the routes-manifest.json rewrite destination is correct
        BACKEND_URL: http://backend:8000
    ports:
      - "3000:3000"
    environment:
      # Also set at runtime so Next.js standalone server.js sees it on startup
      BACKEND_URL: http://backend:8000
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  # Named volume — survives `docker compose down`, deleted only by `docker compose down -v`
  audio_output:
```

- [ ] **Step 3: Create root `.env` from example (if not already present)**

```bash
cp .env.example .env
# Then edit .env and fill in actual Supabase URL and anon key
```

Add `.env` to `.gitignore` if not already there:
```bash
grep -q '^\.env$' .gitignore || echo '.env' >> .gitignore
```

- [ ] **Step 4: Full integration test**

```bash
# From project root
docker compose build
docker compose up
```

Expected:
- Backend accessible at http://localhost:8000/docs
- Frontend accessible at http://localhost:3000
- Frontend `/api/*` calls proxied to backend (check Network tab in DevTools)
- Login still works (Supabase keys were baked correctly)

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example .gitignore
git commit -m "feat(docker): add docker-compose.yml for production deployment

Backend env vars from backend/.env, Supabase keys baked into
frontend image at build time via root .env build args."
```
