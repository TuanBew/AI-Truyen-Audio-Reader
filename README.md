# AudioTruyen — Vietnamese Audiobook Reader

Vietnamese light-novel reader that scrapes chapters from **truyenplus.vn**, synthesizes them sentence-by-sentence via multiple TTS providers, and syncs your reading position to the cloud.

## Features

- Real-time word highlighting during TTS playback
- Sentence-by-sentence synthesis (4 GB VRAM safe with local XTTS-v2)
- Cloud sync via Supabase — resume from exact sentence on any device
- Multiple TTS providers with automatic fallback chain:
  - Google Gemini (Cloud TTS) · OpenAI · MiniMax · Local XTTS-v2 · Google Translate
- Email/Password + Google OAuth authentication
- Guest mode — no account required; sign in to enable cloud sync
- Sentence-aware scrubber with hover tooltip
- Ambient background music player
- Production-ready Docker setup

## Quick Start

### Option A: Docker (Recommended)

```bash
git clone https://github.com/TuanBew/AI-Truyen-Audio-Reader.git
cd AI-Truyen-Audio-Reader

# Configure environment
cp .env.example .env               # fill in Supabase URL + anon key
cp backend/.env.example backend/.env  # fill in API keys

# Build and run
docker compose build
docker compose up
```

- Frontend: http://localhost:3000
- Backend API docs: http://localhost:8000/docs

### Option B: Local Development

#### Prerequisites

- Python 3.11+
- Node.js 18+
- A Supabase project (free tier works)

#### Backend

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash: source .venv/Scripts/activate
                                # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # edit with your API keys
uvicorn main:app --reload --port 8000
```

#### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local  # edit with Supabase URL + anon key
npm run dev
```

Open http://localhost:3000

## Supabase Setup

1. Create a project at https://supabase.com
2. SQL Editor → paste and run `supabase/migrations/001_initial_schema.sql`
3. Authentication → Providers → Google → enable with your OAuth credentials
4. Copy the Project URL and anon key to `frontend/.env.local`

## TTS Providers

| Provider | Requirement | Quality |
|---|---|---|
| Google Gemini / Cloud TTS | Service account JSON | Best |
| OpenAI | API key | Excellent |
| MiniMax | API key + Group ID | Good |
| Local XTTS-v2 | ~2–4 GB RAM/VRAM | Good, free |
| Google Translate | None | Fallback |

### Local XTTS-v2 Setup (Optional)

High-quality Vietnamese TTS with no API cost:

```bash
pip install TTS
tts-server --model_name tts_models/vi/thivux/xtts_v2 --port 5002
```

Select "Local XTTS (Vietnamese)" in Settings.

## Environment Variables

### `backend/.env`

```env
OPENAI_API_KEY=sk-...
MINIMAX_API_KEY=...
MINIMAX_GROUP_ID=...
GOOGLE_APPLICATION_CREDENTIALS=./credentials/service_account.json
FRONTEND_ORIGIN=http://localhost:3000
```

### `frontend/.env.local`

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

## Architecture

```
frontend/          Next.js 16 · React 19 · TypeScript · Tailwind v4 · Zustand
backend/           FastAPI · Python 3.11 · uvicorn
  routers/         scraper · tts · audio · auth
  services/        tts_gemini · tts_openai · tts_minimax · tts_gtranslate
docker-compose.yml Production orchestration
```

See `docs/superpowers/specs/` for detailed design documents.

## License

MIT
