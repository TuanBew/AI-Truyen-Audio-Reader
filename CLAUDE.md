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
| `assets/` | Archived voice references (`voice-refs/`) only. Ambient tracks live in `web/public/ambient/`. |

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
    uv run worker run             # job loop (search, fetch_novel, fetch_chapter); Ctrl+C to stop
    uv run worker run --once      # drain the queue once and exit
    uv run worker enqueue fetch-novel https://truyenfull.live/<slug>/   # test without the web app

`worker/.env` points at the production Supabase project. To run the worker against local Supabase, override it in the shell (environment variables win over `.env`): `set -a; source <(bash scripts/supabase-test-env.sh); set +a; export SUPABASE_URL=$TEST_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$TEST_SUPABASE_SERVICE_ROLE_KEY WORKER_ID=local-dev`. In a worktree without `worker/.env`, also export dummy `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (the worker reads R2 settings at startup; nothing uploads before M2b).

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
- Cost and abuse protection requirements are in spec 7.3.1 and bind every change touching R2, Vercel or Edge TTS.
- Scraping goes through `sources/http.py` `PoliteClient` only (1.0-1.5 s spacing, allowed hosts); never add code that solves or bypasses Cloudflare challenges.

## Database rules

- Migrations in `supabase/migrations/` that are already applied to cloud (currently `20261015000100`, `20261015000200`, `20261015000300`) are never edited. Changes go in new timestamped files.
- Every new table: `enable row level security` plus explicit policies. Worker-only tables also `revoke insert, update, delete, truncate ... from authenticated`.
- Every new function: `revoke execute ... from public, anon, authenticated`, then grant only the intended roles. `security definer` functions use `set search_path = ''` and fully qualified names.
- Tests: add pgTAP coverage in `supabase/tests/` for every new table and function.

## Applying migrations to cloud

`supabase db push` fails on this project: the CLI login role `cli_login_postgres` cannot be created (`DbConfigLoginRoleStatusError`). Use this procedure instead (the one used in M1). Project ref: `pvslnmyzdbntyuckmncs` (also in `supabase/.temp/project-ref`; not a secret).

0. Ask the owner before every cloud apply; this changes their production database.
1. Run `npx --yes supabase@2.121.0 test db` locally first; it must pass.
2. List what is already applied (`select version from supabase_migrations.schema_migrations order by 1;`) and apply only newer files.
3. For each new migration file, in order, POST to the Management API `https://api.supabase.com/v1/projects/<project-ref>/database/query` a single request whose SQL is the file contents followed by `insert into supabase_migrations.schema_migrations (version, name) values ('<version>', '<name>') on conflict do nothing;`, so applying and recording happen in one implicit transaction (it runs as `postgres`).
4. Verify: the version is now listed in `supabase_migrations.schema_migrations`; RLS is enabled on every public table; function ACLs match the allow-list; anon has no table grants.

Token handling: use the owner's CLI token (Windows Credential Manager target `Supabase CLI:supabase`) or a short-lived token the owner creates. Never put it on a command line (process lists and shell history keep it): pass it to `curl` through a header file (`-H @file`) or read it inside a script. Never print or commit it, and delete any temp file that held it immediately after use.
