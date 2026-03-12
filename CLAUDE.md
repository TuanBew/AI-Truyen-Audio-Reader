# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AudioTruyen** is a Vietnamese light-novel audiobook app. It scrapes chapters from `truyenplus.vn`, synthesizes them to speech via multiple TTS providers (Gemini/Google Cloud, OpenAI, MiniMax, Google Translate), and saves audio files locally. The UI is a Next.js SPA; the backend is a FastAPI server.

## Development Commands

### Backend (FastAPI)
```bash
cd backend

# Activate virtual environment
.venv\Scripts\activate         # Windows
source .venv/bin/activate      # Unix

# Install dependencies
pip install -r requirements.txt

# Run dev server (from backend/ directory)
uvicorn main:app --reload --port 8000

# API docs available at http://localhost:8000/docs
```

### Frontend (Next.js)
```bash
cd frontend

# Install dependencies
npm install

# Run dev server
npm run dev        # http://localhost:3000

# Build for production
npm run build

# Lint
npm run lint
```

## Architecture

### Backend (`backend/`)

**Entry point:** `main.py` — configures FastAPI with CORS (locked to `FRONTEND_ORIGIN`), rate limiting via `slowapi`, and mounts four routers:

| Router prefix | File | Purpose |
|---|---|---|
| `/api/scrape` | `routers/scraper.py` | Scrapes chapters and TOC from truyenplus.vn |
| `/api/tts` | `routers/tts.py` | Text-to-speech synthesis with provider fallback chain |
| `/api/audio` | `routers/audio.py` | Saves uploaded audio bytes to local disk |
| `/api/auth` | `routers/auth.py` | Upload/check Google Cloud service account credentials |

**TTS provider chain** (`routers/tts.py`): `_run_provider_chain()` tries providers in order starting from `preferred_provider`: **Gemini → OpenAI → MiniMax → Google Translate**. On quota/auth errors it falls back to the next; on success it returns `X-Provider-Used` and `X-Fallback-Used` headers. Two endpoints: `/api/tts/synthesize` (returns audio stream) and `/api/tts/synthesize-with-timing` (returns JSON with base64 audio + word-level timing data).

**TTS services** (`services/`):
- `tts_gemini.py` — Google Cloud Text-to-Speech (ADC via service account JSON). Primary provider. Supports `synthesize_with_timing()` for word-level highlighting.
- `tts_openai.py` — OpenAI TTS API. Voices: alloy/echo/fable/onyx/nova/shimmer. Models: tts-1/tts-1-hd.
- `tts_minimax.py` — MiniMax T2A v2 API. Audio returned as hex-encoded bytes in JSON response.
- `tts_gtranslate.py` — Unofficial Google Translate TTS (last-resort). Limited to ~200 chars; `synthesize_long()` splits text at sentence boundaries and concatenates MP3 chunks.

**Scraper** (`routers/scraper.py`): Only allows `truyenplus.vn` URLs. TOC fetching uses the site's AJAX API (`GET /get/listchap/{novel_id}?page=N`, 100 chapters/page, fetched in concurrent batches of 3 with polite delays). Novel ID is extracted from `onclick='page(ID,N)'` attributes on the homepage.

**Credentials** (`routers/auth.py`): Google Cloud service account JSON is uploaded via `POST /api/auth/upload-credentials` and saved to `backend/credentials/service_account.json`. The `GOOGLE_APPLICATION_CREDENTIALS` env var is set in-process automatically on server restart if the file exists.

**Audio saving** (`routers/audio.py`): Last-used save directory is persisted to `backend/.audio_state.json` so subsequent saves don't need to re-specify the path.

### Frontend (`frontend/`)

**Framework:** Next.js 16 with React 19, TypeScript, Tailwind CSS v4, Zustand for state.

**Single page entry:** `app/page.tsx` lazily imports `MainLayout` with `ssr: false` to avoid SSR issues with Zustand persist.

**State management** (`lib/store.ts`): Single Zustand store (`useAppStore`) with `persist` middleware. Persisted to `localStorage` under key `audiotruyen-store`. Persisted slices: `view`, `activeNovelId`, `savedNovels`, `finishedChapterUrls`, `ttsSettings`, `recordingState` (directory + format, not live recording state). Transient state (chapter content, word timings, player state) is NOT persisted.

**Key types** (`lib/types.ts`): `TTSProvider` = `"gemini" | "openai" | "minimax" | "gtranslate"`. API keys for OpenAI/MiniMax are stored in `ttsSettings` (localStorage) and sent to the backend in request headers.

**Component layout:**
- `MainLayout` — top-level shell with `ChapterSidebar` (left) + `ReaderPanel` (main) + `SettingsPanel` (right drawer). `HomePage` shown when `view === "home"`.
- `TTSPlayer` — audio playback with word-level highlighting (uses `WordTiming[]` from the timing endpoint).
- `RecordingControls` — triggers audio save via `POST /api/audio/save`.

## Environment Setup

Copy `backend/.env.example` to `backend/.env` and fill in:
- `GOOGLE_APPLICATION_CREDENTIALS` — path to service account JSON (or upload via the UI)
- `OPENAI_API_KEY` — for OpenAI TTS
- `MINIMAX_API_KEY` + `MINIMAX_GROUP_ID` — for MiniMax TTS
- `FRONTEND_ORIGIN` — defaults to `http://localhost:3000`

The Google Cloud service account needs the **Cloud Text-to-Speech API** enabled.
