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
