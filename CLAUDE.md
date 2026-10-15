# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

AudioTruyen v2: a private, single-user web app for reading and listening to Vietnamese web novels with multi-voice, emotion-aware narration from a self-hosted TTS model. Design spec: `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md`. Plans: `docs/superpowers/plans/`. Spike results: `docs/superpowers/spikes/`.

## Layout

| Path | What |
|---|---|
| `web/` | Next.js 16 app (App Router, React 19, Tailwind v4, `@supabase/ssr`). Deployed to Vercel later (M6). |
| `worker/` | Python 3.12 worker (uv). Scraping, analysis, TTS, R2 uploads. Runs on the owner's laptop, outbound connections only. |
| `supabase/` | Supabase CLI config, migrations, pgTAP tests. |
| `assets/` | Archived voice references (`voice-refs/`) and ambient tracks. |

## Commands

Supabase (needs Docker Desktop running), from the repo root:

    npx --yes supabase@2.121.0 start
    npx --yes supabase@2.121.0 test db
    npx --yes supabase@2.121.0 db reset

Worker, from `worker/`:

    uv sync
    uv run pytest                 # unit tests; db tests skip without TEST_SUPABASE_* env
    uv run ruff check . && uv run ruff format --check .
    uv run worker doctor          # checks Supabase, R2, ffmpeg using worker/.env

Load local Supabase test env for `db` tests (Git Bash, repo root):

    set -a; source <(bash scripts/supabase-test-env.sh); set +a

Web, from `web/`:

    npm install
    npm run dev | npm run lint | npm run typecheck | npm test | npm run build

## Rules

- Next.js 16 uses `proxy.ts`, not `middleware.ts`.
- Web uses only the anon key + user session (RLS). The service-role key exists only in `worker/.env`.
- Only the worker writes `chapter_audio`, `chapter_analysis`, `worker_status`, `llm_usage`; worker writes to `chapter_audio` are fenced by `attempt`.
- UI copy is Vietnamese.
