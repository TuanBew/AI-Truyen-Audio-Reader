# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Steps marked **[USER]** need the human owner (their accounts, passwords, irreversible confirmations); stop and ask, never simulate them.

**Goal:** Replace the v1 code with the v2 skeleton: Supabase schema + RLS + job/attempt SQL functions (tested), a Python worker package that can talk to Supabase and R2, a Next.js 16 web app with single-user email/password sign-in, CI, and the owner's cloud project migrated to the v2 schema.

**Architecture:** Monorepo with `web/` (Next.js, Vercel root later), `worker/` (uv Python package), `supabase/` (CLI config, migrations, pgTAP tests). Supabase is the hub; RLS gates the web app; the worker uses the service role. Database behaviour is tested with pgTAP (`supabase test db`) plus a worker pytest "db" tier against local Supabase; everything runs in GitHub Actions.

**Tech Stack:** Supabase CLI 2.121.0 (via `npx`), Postgres + pgTAP, Docker Desktop, Python 3.12 + uv, supabase-py, boto3, pydantic-settings, pytest, ruff, moto; Node 22 + npm, Next.js 16.4.1, React 19, Tailwind v4, `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.3, zod 4.6.7, vitest 5.0.4; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md` (sections 3.1, 4, 5.1, 5.9, 6.1, 6.2, 7.3, 7.4, 7.5, 8 "M1")

## Global Constraints

- Branch: `rework/m1` (already checked out). Commit after every task. Never push without the owner's go-ahead (Task 8 asks).
- Supabase CLI is always invoked as `npx --yes supabase@2.121.0 ...` from the repo root.
- Python: 3.12 only (`requires-python = ">=3.12,<3.13"`), managed by uv. Node 22, npm (no pnpm/yarn).
- Next.js 16 uses `proxy.ts` (exported function `proxy`), not `middleware.ts`.
- Every user-data table has `user_id uuid not null references auth.users on delete cascade`; `worker_status` and `llm_usage` do not (spec 4).
- `claim_job`, `requeue_expired_jobs`, `begin_chapter_audio` are executable only by `service_role` (spec 4).
- Only the worker creates `chapter_audio` rows; every later worker write is fenced by `attempt` (spec 5.1).
- Secrets never enter git, chat, logs or CLI arguments. `.env` files are gitignored; passwords are read with `getpass`. Only the owner types their real password, in their own browser or terminal.
- UI copy is Vietnamese, sentence case, no em dash (`—`) in visible text, errors say what happened and what to do.
- Colors come from CSS variables (spec 6.4); no hardcoded colors in components; no Inter font, no purple accent.
- Shell is Git Bash on Windows; quote the repo path (it contains spaces).

---

## File Structure

| Path | Responsibility |
|---|---|
| `.gitignore` | v2 ignore rules (env, venvs, node, supabase temp, backups, scratch) |
| `CLAUDE.md` | v2 project guide for Claude Code |
| `README.md` | Short v2 readme |
| `assets/ambient/*.mp3` → `web/public/ambient/` | Ambient tracks kept from v1 |
| `supabase/config.toml` | Local Supabase config (sign-up disabled) |
| `supabase/migrations/20261015000100_v2_schema.sql` | Drop v1 objects, create v2 tables, indexes, triggers |
| `supabase/migrations/20261015000200_v2_rls.sql` | RLS policies, grants, Realtime publication |
| `supabase/migrations/20261015000300_v2_functions.sql` | `claim_job`, `requeue_expired_jobs`, `begin_chapter_audio` |
| `supabase/tests/01_schema.test.sql` | pgTAP: tables, columns, constraints |
| `supabase/tests/02_rls.test.sql` | pgTAP: owner isolation, read-only tables, anon denied |
| `supabase/tests/03_functions.test.sql` | pgTAP: queue ordering, leases, attempts, permissions |
| `scripts/supabase-test-env.sh` | Prints `TEST_SUPABASE_*` env lines from `supabase status` |
| `worker/pyproject.toml`, `worker/.python-version`, `worker/.env.example` | uv project |
| `worker/src/audiotruyen_worker/config.py` | `Settings` (pydantic-settings) |
| `worker/src/audiotruyen_worker/db.py` | Supabase service-role client factory |
| `worker/src/audiotruyen_worker/storage/r2.py` | `R2Storage` (boto3 S3 against R2) |
| `worker/src/audiotruyen_worker/doctor.py` | Connectivity checks |
| `worker/src/audiotruyen_worker/admin.py` | `create_owner`, `set_password` |
| `worker/src/audiotruyen_worker/cli.py` | `worker doctor | create-user | set-password` |
| `worker/tests/*` | Unit tests + `db`-marked tests against local Supabase |
| `web/` | Next.js 16 app (create-next-app base) |
| `web/lib/env.ts` | Public env parsing (zod) |
| `web/lib/auth/paths.ts` | `isPublicPath`, `safeNextPath` |
| `web/lib/supabase/server.ts` | Server Supabase client |
| `web/proxy.ts` | Session refresh + auth redirects |
| `web/app/login/*` | Login page, form, server actions |
| `web/app/page.tsx`, `web/app/layout.tsx`, `web/app/globals.css` | Placeholder home, root layout, theme tokens |
| `.github/workflows/ci.yml` | CI: web, worker, database jobs |
| `.claude/launch.json` | `web` dev-server config for the browser pane |

---

### Task 1: Remove v1, restructure the repository

**Files:**
- Delete: `backend/`, `frontend/` (after moving ambient), `docker-compose.yml`, `.env.example`, `supabase/migrations/001_initial_schema.sql`, `spikes/`, `.claude/launch.json`
- Move: `frontend/public/ambient/*.mp3` → `assets/ambient/`
- Rewrite: `.gitignore`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Produces: `assets/ambient/{city-rain,coffee-shop,forest-beats,lo-chill,midnight-study}.mp3` (Task 7 moves them into `web/public/ambient/`); a clean tree with only `docs/`, `assets/`, `supabase/` (empty migrations dir), `.github/` (absent), and top-level docs.

- [ ] **Step 1: Move the ambient tracks and delete v1**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
mkdir -p assets/ambient
git mv frontend/public/ambient/*.mp3 assets/ambient/
git rm -r -q backend frontend docker-compose.yml .env.example supabase/migrations/001_initial_schema.sql spikes .claude/launch.json
git status --short | head -20
```

Expected: five `R` (rename) lines for the mp3s and many `D` lines. If `git rm` complains about local modifications in `spikes/`, rerun with `-f` only for `spikes` (its outputs are throwaway).

- [ ] **Step 2: Remove leftover untracked v1 artefacts**

```bash
ls backend frontend spikes 2>/dev/null
```

These directories may still exist with gitignored content (`backend/.venv`, `frontend/node_modules`, `spikes/m0/.venv-*`, `spikes/m0/out`). Delete them: `rm -rf backend frontend spikes`. They contain only reproducible environments and spike outputs (the validated voice refs are already archived in `assets/voice-refs/m0/`).

- [ ] **Step 3: Replace `.gitignore`**

```gitignore
# OS and editors
.DS_Store
Thumbs.db
.vscode/

# Env and secrets (examples are committed)
.env
.env.*
!.env.example
!.env.local.example
audiotruyen-489912-*.json
*service_account*.json

# Python
__pycache__/
*.py[cod]
.venv/
.pytest_cache/
.ruff_cache/
*.egg-info/
dist/
build/

# Worker runtime
worker/logs/

# Node / Next.js
node_modules/
web/.next/
web/out/
web/next-env.d.ts
*.tsbuildinfo

# Supabase local state
supabase/.temp/
supabase/.branches/

# Data backups (never commit)
backup/

# Local tooling (launch.json is force-added on purpose)
.claude/
.superpowers/
```

- [ ] **Step 4: Replace `CLAUDE.md`**

```markdown
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
```

- [ ] **Step 5: Replace `README.md`**

```markdown
# AudioTruyen

Private read-along audiobook app for Vietnamese web novels: Next.js web app, Supabase, Cloudflare R2, and a local Python worker running the VieNeu TTS model.

Status: v2 rework in progress. See `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md` and `CLAUDE.md`.
```

- [ ] **Step 6: Verify the tree**

```bash
git ls-files | cut -d/ -f1 | sort -u
git ls-files assets/ambient | wc -l
```

Expected first output exactly: `.gitignore`, `CLAUDE.md`, `README.md`, `assets`, `docs`. Expected count: `5`. `git ls-files | grep -iE "\.env$|service_account"` must print nothing.

- [ ] **Step 7: Commit**

```bash
git add .gitignore CLAUDE.md README.md assets
git status --short
git commit -m "chore: remove v1 code and spikes, restructure repo for v2"
```

Do not use `git add -A`: the owner's untracked file `docs/superpowers/plans/2026-03-13-player-ui-overhaul.md` must stay untracked. `git status --short` before the commit must show only the staged renames/deletions/edits from this task plus that one `??` line.

---

### Task 2: Local Supabase and the v2 schema

**Files:**
- Create: `supabase/config.toml` (via `supabase init`), `supabase/migrations/20261015000100_v2_schema.sql`, `supabase/tests/01_schema.test.sql`

**Interfaces:**
- Produces: tables `voices, novels, chapters, characters, lexicon, chapter_analysis, chapter_audio, jobs, worker_status, llm_usage, progress, listened_chapters, bookmarks, listen_sessions, settings` in `public`, with the columns below (later tasks and M2-M5 rely on these exact names); trigger function `public.set_updated_at()`.

- [ ] **Step 1: Start Docker Desktop and initialise Supabase**

```bash
docker info >/dev/null 2>&1 || ("/c/Program Files/Docker/Docker/Docker Desktop.exe" &)
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 5; done; docker info --format '{{.ServerVersion}}'
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
printf 'n\nn\n' | npx --yes supabase@2.121.0 init
```

Expected: a Docker server version prints; `supabase/config.toml` exists. If `init` asks other questions, answer "no" to every IDE/Deno prompt.

- [ ] **Step 2: Configure `supabase/config.toml`**

Edit the generated file:
- set `project_id = "audiotruyen"`
- under `[auth]` set `enable_signup = false`
- under `[auth.email]` set `enable_signup = false` and `enable_confirmations = false`

Leave every other generated value unchanged.

- [ ] **Step 3: Write the failing schema test** — `supabase/tests/01_schema.test.sql`

```sql
begin;
select plan(26);

select hasnt_table('public', 'reading_progress', 'v1 reading_progress is gone');

select has_table('public', t, 'table ' || t || ' exists')
from unnest(array[
  'voices', 'novels', 'chapters', 'characters', 'lexicon', 'chapter_analysis',
  'chapter_audio', 'jobs', 'worker_status', 'llm_usage', 'progress',
  'listened_chapters', 'bookmarks', 'listen_sessions', 'settings'
]) as t;

select has_column('public', t, 'user_id', t || ' has user_id')
from unnest(array['novels', 'chapters', 'chapter_audio', 'jobs', 'settings']) as t;

select col_default_is('public', 'chapter_audio', 'attempt', 1, 'attempt defaults to 1');
select col_is_unique('public', 'chapter_audio', array['chapter_id', 'voice_hash'], 'one row per chapter and voice_hash');
select col_is_unique('public', 'chapters', array['novel_id', 'index'], 'one row per chapter number');
select col_is_pk('public', 'chapter_analysis', array['chapter_id', 'text_hash', 'strategy', 'strategy_version'], 'analysis pk includes strategy');
select col_default_is('public', 'jobs', 'status', 'queued'::text, 'jobs start queued');

select * from finish();
rollback;
```

- [ ] **Step 4: Run it to see it fail**

```bash
npx --yes supabase@2.121.0 start
npx --yes supabase@2.121.0 test db
```

Expected: `start` prints local URLs and keys; `test db` fails (tables missing).

- [ ] **Step 5: Write the migration** — `supabase/migrations/20261015000100_v2_schema.sql`

```sql
-- AudioTruyen v2 schema. The v2 project reuses the v1 Supabase project, so drop the v1 objects first.
drop table if exists public.reading_progress cascade;
drop table if exists public.novels cascade;
drop function if exists public.update_updated_at() cascade;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.voices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('preset', 'clone')),
  preset_name text,
  refs jsonb not null default '{}'::jsonb,
  gender text not null default 'unknown' check (gender in ('male', 'female', 'unknown')),
  is_default_narrator boolean not null default false,
  is_default_male boolean not null default false,
  is_default_female boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voices_preset_has_name check (kind <> 'preset' or preset_name is not null),
  unique (user_id, name)
);
create unique index voices_one_default_narrator on public.voices (user_id) where is_default_narrator;
create unique index voices_one_default_male on public.voices (user_id) where is_default_male;
create unique index voices_one_default_female on public.voices (user_id) where is_default_female;

create table public.novels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  source_novel_id text not null,
  url text not null,
  slug text,
  title text not null,
  author text,
  cover_url text,
  description text,
  status text check (status in ('ongoing', 'completed')),
  chapter_count integer not null default 0,
  followed boolean not null default false,
  auto_synthesize_new boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, source_novel_id)
);

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid not null references public.novels (id) on delete cascade,
  index integer not null check (index >= 1),
  title text not null,
  url text not null,
  text text,
  text_hash text,
  fetched_at timestamptz,
  is_new boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (novel_id, index)
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid not null references public.novels (id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  gender text not null default 'unknown' check (gender in ('male', 'female', 'unknown')),
  voice_id uuid references public.voices (id) on delete set null,
  color text,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (novel_id, name)
);

create table public.lexicon (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid references public.novels (id) on delete cascade,
  pattern text not null,
  replacement text not null,
  is_regex boolean not null default false,
  enabled boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lexicon_scope_order on public.lexicon (user_id, novel_id, position);

create table public.chapter_analysis (
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  text_hash text not null,
  strategy text not null,
  strategy_version integer not null,
  segments jsonb not null,
  created_at timestamptz not null default now(),
  primary key (chapter_id, text_hash, strategy, strategy_version)
);

create table public.chapter_audio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  voice_hash text not null,
  status text not null default 'queued' check (status in ('queued', 'partial', 'ready', 'failed')),
  provider text not null default 'vieneu',
  attempt integer not null default 1 check (attempt >= 1),
  init_key text,
  chunks jsonb not null default '[]'::jsonb,
  full_key text,
  duration_ms integer,
  segments jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chapter_id, voice_hash)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('search', 'fetch_novel', 'fetch_chapter', 'synthesize', 'check_updates')),
  payload jsonb not null default '{}'::jsonb,
  priority integer not null default 10,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  worker_id text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_queue on public.jobs (priority, created_at) where status = 'queued';
create index jobs_running_lease on public.jobs (lease_until) where status = 'running';
create index jobs_owner_recent on public.jobs (user_id, created_at desc);

create table public.worker_status (
  worker_id text primary key,
  last_seen timestamptz not null default now(),
  version text,
  device text,
  queue_depth integer not null default 0,
  current_job uuid references public.jobs (id) on delete set null
);

create table public.llm_usage (
  model text not null,
  day_pt date not null,
  requests integer not null default 0,
  tokens integer not null default 0,
  locked_until timestamptz,
  primary key (model, day_pt)
);

create table public.progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid not null references public.novels (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  segment_index integer not null default 0,
  position_ms integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, novel_id)
);

create table public.listened_chapters (
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  finished_at timestamptz not null default now(),
  primary key (user_id, chapter_id)
);

create table public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  segment_index integer not null,
  quote text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookmarks_owner on public.bookmarks (user_id, created_at desc);

create table public.listen_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  started_at timestamptz not null default now(),
  seconds integer not null default 0 check (seconds >= 0)
);
create index listen_sessions_owner_time on public.listen_sessions (user_id, started_at);

create table public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array[
    'voices', 'novels', 'chapters', 'characters', 'lexicon', 'chapter_audio',
    'jobs', 'progress', 'bookmarks', 'settings'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end;
$$;
```

- [ ] **Step 6: Run the tests to see them pass**

```bash
npx --yes supabase@2.121.0 db reset
npx --yes supabase@2.121.0 test db
```

Expected: `db reset` applies the migration without errors; `test db` reports `01_schema.test.sql .. ok` and `All tests successful`.

- [ ] **Step 7: Commit**

```bash
git add supabase/config.toml supabase/migrations/20261015000100_v2_schema.sql supabase/tests/01_schema.test.sql
git commit -m "feat(db): v2 schema replacing v1 tables"
```

Also add any other file `supabase init` created inside `supabase/` (for example `supabase/.gitignore`), but never `supabase/.temp/`.

---

### Task 3: Row-level security, grants, Realtime

**Files:**
- Create: `supabase/migrations/20261015000200_v2_rls.sql`, `supabase/tests/02_rls.test.sql`

**Interfaces:**
- Consumes: tables from Task 2.
- Produces: policy names `<table>_owner` (full access) and `<table>_owner_read` / `<table>_read` (read-only); anon has no table privileges; `chapter_analysis`, `chapter_audio`, `worker_status`, `llm_usage` are not writable by `authenticated`; Realtime publication includes `jobs`, `chapter_audio`, `worker_status`.

- [ ] **Step 1: Write the failing RLS test** — `supabase/tests/02_rls.test.sql`

```sql
begin;
select plan(11);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@audiotruyen.test', '{}', '{}', now(), now());

insert into public.novels (id, user_id, source, source_novel_id, url, title)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'truyenfull', '1', 'https://truyenfull.live/a/', 'Truyện A');
insert into public.chapters (id, user_id, novel_id, index, title, url)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'Chương 1', 'https://truyenfull.live/a/chuong-1/');
insert into public.chapter_audio (user_id, chapter_id, voice_hash)
values ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001', 'h1');
insert into public.worker_status (worker_id) values ('laptop');

-- user A
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';

select is((select count(*)::int from public.novels), 1, 'owner sees own novel');
select is((select count(*)::int from public.chapter_audio), 1, 'owner reads own chapter_audio');
select lives_ok(
  $$insert into public.jobs (user_id, type) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel')$$,
  'owner enqueues a job'
);
select throws_ok(
  $$insert into public.chapter_audio (user_id, chapter_id, voice_hash) values ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001', 'h2')$$,
  '42501', null, 'owner cannot write chapter_audio'
);
select ok((select count(*) from public.worker_status) = 1, 'owner reads worker_status');
select throws_ok(
  $$insert into public.worker_status (worker_id) values ('x')$$,
  '42501', null, 'owner cannot write worker_status'
);

-- user B
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}';

select is((select count(*)::int from public.novels), 0, 'other user sees no novels');
select is((select count(*)::int from public.chapter_audio), 0, 'other user sees no chapter_audio');
select throws_ok(
  $$insert into public.novels (user_id, source, source_novel_id, url, title) values ('11111111-1111-1111-1111-111111111111', 'truyenfull', '2', 'u', 't')$$,
  '42501', null, 'cannot insert rows for another user'
);

-- anon
reset role;
set local role anon;
select throws_ok($$select count(*) from public.novels$$, '42501', null, 'anon cannot read novels');
select throws_ok($$select count(*) from public.worker_status$$, '42501', null, 'anon cannot read worker_status');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx --yes supabase@2.121.0 test db
```

Expected: `02_rls.test.sql` fails (other users can read rows, anon can read).

- [ ] **Step 3: Write the migration** — `supabase/migrations/20261015000200_v2_rls.sql`

```sql
-- Row-level security for AudioTruyen v2 (spec section 4).

-- Owner full access.
do $$
declare t text;
begin
  foreach t in array array[
    'voices', 'novels', 'chapters', 'characters', 'lexicon', 'jobs', 'progress',
    'listened_chapters', 'bookmarks', 'listen_sessions', 'settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)',
      t || '_owner', t
    );
  end loop;
end;
$$;

-- Owner read-only (written only by the worker with the service role).
do $$
declare t text;
begin
  foreach t in array array['chapter_analysis', 'chapter_audio'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_owner_read', t
    );
  end loop;
end;
$$;

-- Shared read-only status tables (single-user app, no user_id).
do $$
declare t text;
begin
  foreach t in array array['worker_status', 'llm_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end;
$$;

-- Defense in depth on top of RLS.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
revoke insert, update, delete, truncate on public.chapter_analysis, public.chapter_audio, public.worker_status, public.llm_usage from authenticated;

-- Realtime for the web app (spec 7.5).
alter publication supabase_realtime add table public.jobs, public.chapter_audio, public.worker_status;
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
npx --yes supabase@2.121.0 db reset
npx --yes supabase@2.121.0 test db
```

Expected: both test files ok, `All tests successful`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261015000200_v2_rls.sql supabase/tests/02_rls.test.sql
git commit -m "feat(db): row-level security, grants and realtime publication"
```

---

### Task 4: Queue and attempt functions

**Files:**
- Create: `supabase/migrations/20261015000300_v2_functions.sql`, `supabase/tests/03_functions.test.sql`

**Interfaces:**
- Consumes: `public.jobs`, `public.chapters`, `public.chapter_audio` (Task 2).
- Produces (called by the worker via RPC in Task 6 and M2):
  - `public.claim_job(p_worker_id text, p_lease_seconds integer default 300) returns setof public.jobs`
  - `public.requeue_expired_jobs() returns integer`
  - `public.begin_chapter_audio(p_chapter_id uuid, p_voice_hash text) returns table (id uuid, attempt integer, status text)`
  - all three executable only by `service_role`.

- [ ] **Step 1: Write the failing test** — `supabase/tests/03_functions.test.sql`

```sql
begin;
select plan(17);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now());
insert into public.novels (id, user_id, source, source_novel_id, url, title)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'truyenfull', '1', 'u', 'Truyện A');
insert into public.chapters (id, user_id, novel_id, index, title, url)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'Chương 1', 'u1');

insert into public.jobs (id, user_id, type, priority, created_at, run_after) values
  ('10000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'synthesize', 10, now() - interval '3 minutes', now()),
  ('10000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 0, now() - interval '1 minute', now()),
  ('10000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 0, now() - interval '2 minutes', now() + interval '1 hour');

-- claim_job: priority first, run_after respected
select is((select id from public.claim_job('w1', 300)), '10000000-0000-0000-0000-000000000002'::uuid, 'claims the due priority-0 job first');
select is((select status from public.jobs where id = '10000000-0000-0000-0000-000000000002'), 'running', 'claimed job is running');
select is((select worker_id from public.jobs where id = '10000000-0000-0000-0000-000000000002'), 'w1', 'claimed job records the worker');
select is((select attempts from public.jobs where id = '10000000-0000-0000-0000-000000000002'), 1, 'claim increments attempts');
select ok((select lease_until > now() from public.jobs where id = '10000000-0000-0000-0000-000000000002'), 'claim sets a future lease');
select is((select id from public.claim_job('w1', 300)), '10000000-0000-0000-0000-000000000001'::uuid, 'then the priority-10 job');
select is((select count(*)::int from public.claim_job('w1', 300)), 0, 'the not-yet-due job is not claimed');

-- requeue_expired_jobs
update public.jobs set lease_until = now() - interval '1 minute' where id = '10000000-0000-0000-0000-000000000002';
update public.jobs set lease_until = now() - interval '1 minute', attempts = 3 where id = '10000000-0000-0000-0000-000000000001';
select is(public.requeue_expired_jobs(), 2, 'two expired leases handled');
select is((select status from public.jobs where id = '10000000-0000-0000-0000-000000000002'), 'queued', 'expired job with attempts left is requeued');
select is((select status from public.jobs where id = '10000000-0000-0000-0000-000000000001'), 'failed', 'expired job without attempts left fails');

-- begin_chapter_audio
select is(
  (select row(attempt, status)::text from public.begin_chapter_audio('cccccccc-0000-0000-0000-000000000001', 'h1')),
  '(1,queued)', 'first call creates attempt 1'
);
select is(
  (select user_id from public.chapter_audio where chapter_id = 'cccccccc-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'row copies the chapter owner'
);
update public.chapter_audio set init_key = 'k', chunks = '[{"key":"s0"}]', status = 'partial' where voice_hash = 'h1';
select is(
  (select row(attempt, status)::text from public.begin_chapter_audio('cccccccc-0000-0000-0000-000000000001', 'h1')),
  '(2,queued)', 'call on a non-ready row starts attempt 2'
);
select is(
  (select row(init_key, chunks)::text from public.chapter_audio where voice_hash = 'h1'),
  '(,[])', 're-attempt resets init_key and chunks'
);
update public.chapter_audio set status = 'ready' where voice_hash = 'h1';
select is(
  (select row(attempt, status)::text from public.begin_chapter_audio('cccccccc-0000-0000-0000-000000000001', 'h1')),
  '(2,ready)', 'ready row is returned unchanged'
);
select throws_ok(
  $$select * from public.begin_chapter_audio('cccccccc-0000-0000-0000-00000000ffff', 'h1')$$,
  'P0002', null, 'unknown chapter raises no_data_found'
);

-- permissions
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select throws_ok($$select * from public.claim_job('w1', 300)$$, '42501', null, 'authenticated cannot claim jobs');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx --yes supabase@2.121.0 test db
```

Expected: `03_functions.test.sql` fails (functions do not exist).

- [ ] **Step 3: Write the migration** — `supabase/migrations/20261015000300_v2_functions.sql`

```sql
-- Job queue and chapter-audio attempt functions (spec 4 and 5.1). Service role only.

create or replace function public.claim_job(p_worker_id text, p_lease_seconds integer default 300)
returns setof public.jobs
language sql
security definer
set search_path = ''
as $$
  update public.jobs j
     set status = 'running',
         worker_id = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1
   where j.id = (
     select q.id
       from public.jobs q
      where q.status = 'queued' and q.run_after <= now()
      order by q.priority, q.created_at
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

create or replace function public.requeue_expired_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.jobs j
     set status = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         error = case when j.attempts >= j.max_attempts
                      then 'lease expired after ' || j.attempts || ' attempts'
                      else j.error end,
         worker_id = null,
         lease_until = null
   where j.status = 'running' and j.lease_until < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.begin_chapter_audio(p_chapter_id uuid, p_voice_hash text)
returns table (id uuid, attempt integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r public.chapter_audio;
begin
  insert into public.chapter_audio (user_id, chapter_id, voice_hash, status, attempt)
  select c.user_id, c.id, p_voice_hash, 'queued', 1
    from public.chapters c
   where c.id = p_chapter_id
  on conflict (chapter_id, voice_hash) do nothing
  returning * into r;

  if found then
    return query select r.id, r.attempt, r.status;
    return;
  end if;

  select * into r
    from public.chapter_audio a
   where a.chapter_id = p_chapter_id and a.voice_hash = p_voice_hash
     for update;

  if not found then
    raise exception 'chapter % not found', p_chapter_id using errcode = 'no_data_found';
  end if;

  if r.status <> 'ready' then
    update public.chapter_audio a
       set attempt = a.attempt + 1,
           status = 'queued',
           init_key = null,
           chunks = '[]'::jsonb,
           full_key = null,
           duration_ms = null,
           segments = '[]'::jsonb,
           warnings = '[]'::jsonb
     where a.id = r.id
    returning * into r;
  end if;

  return query select r.id, r.attempt, r.status;
end;
$$;

revoke execute on function public.claim_job(text, integer) from public, anon, authenticated;
revoke execute on function public.requeue_expired_jobs() from public, anon, authenticated;
revoke execute on function public.begin_chapter_audio(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_job(text, integer) to service_role;
grant execute on function public.requeue_expired_jobs() to service_role;
grant execute on function public.begin_chapter_audio(uuid, text) to service_role;
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
npx --yes supabase@2.121.0 db reset
npx --yes supabase@2.121.0 test db
```

Expected: three test files ok, `All tests successful`. If the `row(...)::text` comparisons fail only on formatting (for example `(,[])` vs `(,"[]")`), print the actual value with `select row(init_key, chunks)::text ...` in `psql` and fix the expected literal in the test, not the function.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261015000300_v2_functions.sql supabase/tests/03_functions.test.sql
git commit -m "feat(db): claim_job, requeue_expired_jobs, begin_chapter_audio"
```

---

### Task 5: Worker package skeleton (config, R2 storage, doctor)

**Files:**
- Create: `worker/pyproject.toml`, `worker/.python-version`, `worker/.env.example`, `worker/src/audiotruyen_worker/__init__.py`, `worker/src/audiotruyen_worker/config.py`, `worker/src/audiotruyen_worker/db.py`, `worker/src/audiotruyen_worker/storage/__init__.py`, `worker/src/audiotruyen_worker/storage/r2.py`, `worker/src/audiotruyen_worker/doctor.py`, `worker/src/audiotruyen_worker/cli.py`, `worker/tests/__init__.py`, `worker/tests/test_config.py`, `worker/tests/test_r2.py`, `worker/tests/test_doctor.py`
- Lockfile: `worker/uv.lock` (generated)

**Interfaces:**
- Produces:
  - `Settings` with fields `supabase_url: str`, `supabase_service_role_key: SecretStr`, `r2_account_id: str`, `r2_access_key_id: str`, `r2_secret_access_key: SecretStr`, `r2_bucket: str`, `r2_endpoint_url: str | None`, `worker_id: str`, `log_level: str`; property `r2_endpoint -> str`; `load_settings(**overrides) -> Settings`.
  - `make_client(settings) -> supabase.Client` (service role).
  - `R2Storage(client, bucket)` with `put_bytes(key, data, content_type) -> None`, `get_bytes(key) -> bytes`, `exists(key) -> bool`, `delete(key) -> None`, classmethod `from_settings(settings) -> R2Storage`, attribute `bucket`.
  - `CheckResult(name, ok, detail)`, `run_check(name, fn) -> CheckResult`, `check_supabase(client) -> str`, `check_r2(storage, worker_id) -> str`, `check_ffmpeg() -> str`.
  - CLI entry point `worker` (`audiotruyen_worker.cli:main(argv: list[str] | None = None) -> int`) with subcommand `doctor`.

- [ ] **Step 1: Write `worker/pyproject.toml`, `.python-version`, `.env.example`**

`worker/pyproject.toml`:

```toml
[project]
name = "audiotruyen-worker"
version = "0.1.0"
description = "AudioTruyen v2 worker: scraping, analysis, TTS and uploads"
requires-python = ">=3.12,<3.13"
dependencies = [
  "boto3>=1.35",
  "pydantic>=2.9",
  "pydantic-settings>=2.6",
  "supabase>=2.10",
]

[project.scripts]
worker = "audiotruyen_worker.cli:main"

[dependency-groups]
dev = [
  "moto[s3]>=5",
  "pytest>=8",
  "ruff>=0.7",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/audiotruyen_worker"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = ["db: needs local Supabase (TEST_SUPABASE_* env, see scripts/supabase-test-env.sh)"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
```

`worker/.python-version`:

```
3.12
```

`worker/.env.example`:

```dotenv
# Copy to worker/.env and fill in. Never commit worker/.env.
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=audiotruyen
# Optional: override the R2 endpoint (tests or other S3-compatible storage)
# R2_ENDPOINT_URL=
# Optional: defaults to the machine name
# WORKER_ID=laptop
LOG_LEVEL=INFO
```

Then:

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen/worker" && mkdir -p src/audiotruyen_worker/storage tests && touch src/audiotruyen_worker/__init__.py src/audiotruyen_worker/storage/__init__.py tests/__init__.py && uv sync
```

Expected: uv creates `.venv` with Python 3.12 and writes `uv.lock`.

- [ ] **Step 2: Write the failing tests**

`worker/tests/test_config.py`:

```python
import pytest
from pydantic import ValidationError

from audiotruyen_worker.config import load_settings

REQUIRED = {
    "SUPABASE_URL": "http://127.0.0.1:54321",
    "SUPABASE_SERVICE_ROLE_KEY": "service-key",
    "R2_ACCOUNT_ID": "acc123",
    "R2_ACCESS_KEY_ID": "id",
    "R2_SECRET_ACCESS_KEY": "r2-hidden-value",
    "R2_BUCKET": "audiotruyen",
}


@pytest.fixture
def env(monkeypatch):
    for key, value in REQUIRED.items():
        monkeypatch.setenv(key, value)
    return monkeypatch


def test_loads_required_values(env):
    settings = load_settings(_env_file=None)
    assert settings.supabase_url == "http://127.0.0.1:54321"
    assert settings.r2_bucket == "audiotruyen"
    assert settings.supabase_service_role_key.get_secret_value() == "service-key"


def test_secrets_are_masked_in_repr(env):
    text = repr(load_settings(_env_file=None))
    assert "service-key" not in text
    assert "r2-hidden-value" not in text


def test_r2_endpoint_defaults_to_account_url(env):
    assert load_settings(_env_file=None).r2_endpoint == "https://acc123.r2.cloudflarestorage.com"


def test_r2_endpoint_override(env):
    env.setenv("R2_ENDPOINT_URL", "http://localhost:9000")
    assert load_settings(_env_file=None).r2_endpoint == "http://localhost:9000"


def test_worker_id_defaults_to_hostname(env):
    assert load_settings(_env_file=None).worker_id


def test_missing_required_value_fails(env):
    env.delenv("R2_BUCKET")
    with pytest.raises(ValidationError):
        load_settings(_env_file=None)
```

`worker/tests/test_r2.py`:

```python
import boto3
import pytest
from moto import mock_aws

from audiotruyen_worker.storage.r2 import R2Storage


@pytest.fixture
def storage():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="audiotruyen")
        yield R2Storage(client, "audiotruyen")


def test_put_then_get_roundtrip(storage):
    storage.put_bytes("a/b.txt", b"xin chao", "text/plain")
    assert storage.get_bytes("a/b.txt") == b"xin chao"


def test_exists_reflects_object_presence(storage):
    assert storage.exists("missing.txt") is False
    storage.put_bytes("present.txt", b"1", "text/plain")
    assert storage.exists("present.txt") is True


def test_delete_removes_object(storage):
    storage.put_bytes("gone.txt", b"1", "text/plain")
    storage.delete("gone.txt")
    assert storage.exists("gone.txt") is False


def test_put_sets_content_type(storage):
    storage.put_bytes("seg.webm", b"\x1a\x45\xdf\xa3", "audio/webm")
    head = storage.client.head_object(Bucket="audiotruyen", Key="seg.webm")
    assert head["ContentType"] == "audio/webm"
```

`worker/tests/test_doctor.py`:

```python
from audiotruyen_worker.doctor import CheckResult, check_r2, run_check


class FakeStorage:
    bucket = "audiotruyen"

    def __init__(self, corrupt: bool = False):
        self.objects: dict[str, bytes] = {}
        self.corrupt = corrupt

    def put_bytes(self, key, data, content_type):
        self.objects[key] = data

    def get_bytes(self, key):
        return b"other" if self.corrupt else self.objects[key]

    def delete(self, key):
        self.objects.pop(key, None)


def test_run_check_reports_success():
    assert run_check("x", lambda: "fine") == CheckResult("x", True, "fine")


def test_run_check_captures_exception():
    def boom():
        raise RuntimeError("no route")

    result = run_check("x", boom)
    assert result.ok is False
    assert result.detail == "RuntimeError: no route"


def test_check_r2_roundtrip_cleans_up():
    storage = FakeStorage()
    detail = check_r2(storage, "laptop")
    assert "audiotruyen" in detail
    assert storage.objects == {}


def test_check_r2_detects_mismatch_and_still_cleans_up():
    storage = FakeStorage(corrupt=True)
    result = run_check("r2", lambda: check_r2(storage, "laptop"))
    assert result.ok is False
    assert "mismatch" in result.detail
    assert storage.objects == {}
```

- [ ] **Step 3: Run them to see them fail**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen/worker" && uv run pytest -q
```

Expected: collection errors (`ModuleNotFoundError: audiotruyen_worker.config` etc.).

- [ ] **Step 4: Implement the modules**

`worker/src/audiotruyen_worker/config.py`:

```python
"""Worker configuration from environment variables and worker/.env."""

from __future__ import annotations

import socket

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    supabase_url: str
    supabase_service_role_key: SecretStr
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: SecretStr
    r2_bucket: str
    r2_endpoint_url: str | None = None
    worker_id: str = Field(default_factory=socket.gethostname)
    log_level: str = "INFO"

    @property
    def r2_endpoint(self) -> str:
        return self.r2_endpoint_url or f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


def load_settings(**overrides) -> Settings:
    return Settings(**overrides)
```

`worker/src/audiotruyen_worker/db.py`:

```python
"""Supabase client with the service-role key (bypasses RLS; worker only)."""

from __future__ import annotations

from supabase import Client, create_client

from audiotruyen_worker.config import Settings


def make_client(settings: Settings) -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_role_key.get_secret_value())
```

`worker/src/audiotruyen_worker/storage/r2.py`:

```python
"""Cloudflare R2 access through its S3-compatible API."""

from __future__ import annotations

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from audiotruyen_worker.config import Settings


class R2Storage:
    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket

    @classmethod
    def from_settings(cls, settings: Settings) -> R2Storage:
        client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key.get_secret_value(),
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
        )
        return cls(client, settings.r2_bucket)

    def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get_bytes(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)
```

`worker/src/audiotruyen_worker/doctor.py`:

```python
"""Connectivity checks for `worker doctor`."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


def run_check(name: str, fn: Callable[[], str]) -> CheckResult:
    try:
        return CheckResult(name, True, fn())
    except Exception as exc:  # noqa: BLE001 - doctor reports every failure as a result
        return CheckResult(name, False, f"{type(exc).__name__}: {exc}")


def check_supabase(client) -> str:
    client.table("worker_status").select("worker_id").limit(1).execute()
    return "connected, worker_status readable"


def check_r2(storage, worker_id: str) -> str:
    key = f"_doctor/{worker_id}.txt"
    payload = f"audiotruyen doctor probe from {worker_id}".encode()
    storage.put_bytes(key, payload, "text/plain")
    try:
        if storage.get_bytes(key) != payload:
            raise RuntimeError("read-back mismatch")
    finally:
        storage.delete(key)
    return f"put/get/delete ok in bucket {storage.bucket}"


def check_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise FileNotFoundError("ffmpeg is not on PATH (needed from M2)")
    return path
```

`worker/src/audiotruyen_worker/cli.py`:

```python
"""Command-line entry point: `uv run worker <command>`."""

from __future__ import annotations

import argparse
import sys

from audiotruyen_worker.config import load_settings
from audiotruyen_worker.doctor import check_ffmpeg, check_r2, check_supabase, run_check


def _doctor() -> int:
    from audiotruyen_worker.db import make_client
    from audiotruyen_worker.storage.r2 import R2Storage

    settings = load_settings()
    client = make_client(settings)
    storage = R2Storage.from_settings(settings)
    results = [
        run_check("supabase", lambda: check_supabase(client)),
        run_check("r2", lambda: check_r2(storage, settings.worker_id)),
        run_check("ffmpeg", check_ffmpeg),
    ]
    for result in results:
        print(f"{'OK  ' if result.ok else 'FAIL'} {result.name:<9} {result.detail}")
    return 0 if all(r.ok for r in results) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="worker", description="AudioTruyen worker")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("doctor", help="check Supabase, R2 and ffmpeg connectivity")
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run tests and lint**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen/worker" && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run worker --help
```

Expected: `14 passed`; ruff clean (run `uv run ruff format .` once if the format check fails, then re-run); `worker --help` lists `doctor`.

- [ ] **Step 6: Commit**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
git add worker/pyproject.toml worker/uv.lock worker/.python-version worker/.env.example worker/src worker/tests
git commit -m "feat(worker): package skeleton with settings, R2 storage and doctor"
```

---

### Task 6: Worker admin commands and database-tier tests

**Files:**
- Create: `worker/src/audiotruyen_worker/admin.py`, `worker/tests/conftest.py`, `worker/tests/test_admin.py`, `worker/tests/test_db_queue.py`, `scripts/supabase-test-env.sh`
- Modify: `worker/src/audiotruyen_worker/cli.py` (add `create-user`, `set-password`)

**Interfaces:**
- Consumes: SQL functions from Task 4 (`claim_job`, `begin_chapter_audio`), `make_client`/`load_settings` from Task 5.
- Produces:
  - `create_owner(client, email: str, password: str) -> str` (returns user id; email confirmed).
  - `set_password(client, email: str, password: str) -> str` (returns user id; raises `LookupError` if no such user).
  - `validate_password(password: str) -> None` (raises `ValueError` if shorter than 12 characters).
  - CLI: `worker create-user --email E`, `worker set-password --email E` (password via `getpass`, entered twice).
  - Env contract for db tests: `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Write `scripts/supabase-test-env.sh`**

```bash
#!/usr/bin/env bash
# Prints TEST_SUPABASE_* lines for the running local Supabase.
# Usage (Git Bash, repo root):  set -a; source <(bash scripts/supabase-test-env.sh); set +a
# CI:                            bash scripts/supabase-test-env.sh >> "$GITHUB_ENV"
set -euo pipefail
eval "$(npx --yes supabase@2.121.0 status -o env 2>/dev/null)"
echo "TEST_SUPABASE_URL=${API_URL}"
echo "TEST_SUPABASE_ANON_KEY=${ANON_KEY}"
echo "TEST_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}"
```

Verify: `bash scripts/supabase-test-env.sh | cut -d= -f1` prints the three names. If `supabase status -o env` uses different variable names in this CLI version, check them with `npx --yes supabase@2.121.0 status -o env | cut -d= -f1` and adjust the three `echo` lines (keep the `TEST_SUPABASE_*` output names).

- [ ] **Step 2: Write the failing tests**

`worker/tests/conftest.py`:

```python
import os
import secrets
import uuid

import pytest

URL = os.environ.get("TEST_SUPABASE_URL")
ANON = os.environ.get("TEST_SUPABASE_ANON_KEY")
SERVICE = os.environ.get("TEST_SUPABASE_SERVICE_ROLE_KEY")


def _require_db():
    if not (URL and ANON and SERVICE):
        pytest.skip("local Supabase not configured; run scripts/supabase-test-env.sh")


@pytest.fixture
def admin_client():
    _require_db()
    from supabase import create_client

    return create_client(URL, SERVICE)


@pytest.fixture
def owner(admin_client):
    from audiotruyen_worker.admin import create_owner

    email = f"owner-{uuid.uuid4().hex[:10]}@audiotruyen.test"
    password = secrets.token_urlsafe(18)
    user_id = create_owner(admin_client, email, password)
    yield {"id": user_id, "email": email, "password": password}
    admin_client.auth.admin.delete_user(user_id)
```

`worker/tests/test_admin.py`:

```python
import pytest

from audiotruyen_worker.admin import validate_password


def test_short_password_rejected():
    with pytest.raises(ValueError):
        validate_password("short")


def test_long_password_accepted():
    validate_password("đủ-dài-để-dùng-123")


@pytest.mark.db
def test_created_owner_can_sign_in(owner):
    from supabase import create_client

    from tests.conftest import ANON, URL

    anon = create_client(URL, ANON)
    session = anon.auth.sign_in_with_password({"email": owner["email"], "password": owner["password"]})
    assert session.user.id == owner["id"]


@pytest.mark.db
def test_set_password_changes_login(admin_client, owner):
    from supabase import create_client

    from audiotruyen_worker.admin import set_password
    from tests.conftest import ANON, URL

    set_password(admin_client, owner["email"], "mat-khau-moi-rat-dai-42")
    anon = create_client(URL, ANON)
    session = anon.auth.sign_in_with_password({"email": owner["email"], "password": "mat-khau-moi-rat-dai-42"})
    assert session.user.id == owner["id"]


@pytest.mark.db
def test_set_password_unknown_email(admin_client):
    from audiotruyen_worker.admin import set_password

    with pytest.raises(LookupError):
        set_password(admin_client, "khong-ton-tai@audiotruyen.test", "mat-khau-moi-rat-dai-42")
```

`worker/tests/test_db_queue.py`:

```python
import threading

import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.db


def _novel_and_chapter(admin_client, owner_id):
    novel = (
        admin_client.table("novels")
        .insert({"user_id": owner_id, "source": "truyenfull", "source_novel_id": "t1", "url": "u", "title": "T"})
        .execute()
        .data[0]
    )
    chapter = (
        admin_client.table("chapters")
        .insert({"user_id": owner_id, "novel_id": novel["id"], "index": 1, "title": "C1", "url": "u1"})
        .execute()
        .data[0]
    )
    return novel, chapter


def test_claim_job_hands_each_job_to_exactly_one_worker(admin_client, owner):
    from supabase import create_client

    from tests.conftest import SERVICE, URL

    rows = [{"user_id": owner["id"], "type": "fetch_chapter", "payload": {"n": i}} for i in range(24)]
    mine = {r["id"] for r in admin_client.table("jobs").insert(rows).execute().data}

    claimed: list[str] = []
    lock = threading.Lock()

    def run(worker_id: str) -> None:
        client = create_client(URL, SERVICE)
        while True:
            data = client.rpc("claim_job", {"p_worker_id": worker_id, "p_lease_seconds": 300}).execute().data
            if not data:
                return
            with lock:
                claimed.extend(row["id"] for row in data)

    threads = [threading.Thread(target=run, args=(f"w{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert len(claimed) == len(set(claimed)), "a job was claimed twice"
    assert mine <= set(claimed), "some jobs were never claimed"


def test_begin_chapter_audio_attempt_fencing(admin_client, owner):
    _, chapter = _novel_and_chapter(admin_client, owner["id"])
    args = {"p_chapter_id": chapter["id"], "p_voice_hash": "vh1"}

    first = admin_client.rpc("begin_chapter_audio", args).execute().data[0]
    assert (first["attempt"], first["status"]) == (1, "queued")

    fenced = (
        admin_client.table("chapter_audio")
        .update({"init_key": "a1/init.webm", "status": "partial"})
        .eq("id", first["id"])
        .eq("attempt", 1)
        .execute()
        .data
    )
    assert len(fenced) == 1

    second = admin_client.rpc("begin_chapter_audio", args).execute().data[0]
    assert second["attempt"] == 2

    stale = (
        admin_client.table("chapter_audio")
        .update({"init_key": "stale"})
        .eq("id", first["id"])
        .eq("attempt", 1)
        .execute()
        .data
    )
    assert stale == [], "a stale attempt must not be able to write"


def test_authenticated_user_cannot_claim_jobs(owner):
    from supabase import create_client

    from tests.conftest import ANON, URL

    client = create_client(URL, ANON)
    client.auth.sign_in_with_password({"email": owner["email"], "password": owner["password"]})
    with pytest.raises(APIError):
        client.rpc("claim_job", {"p_worker_id": "x", "p_lease_seconds": 300}).execute()
```

- [ ] **Step 3: Run them to see them fail**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
npx --yes supabase@2.121.0 status >/dev/null || npx --yes supabase@2.121.0 start
set -a; source <(bash scripts/supabase-test-env.sh); set +a
cd worker && uv run pytest -q
```

Expected: failures/errors from `ModuleNotFoundError: audiotruyen_worker.admin`.

- [ ] **Step 4: Implement `admin.py` and the CLI commands**

`worker/src/audiotruyen_worker/admin.py`:

```python
"""Owner account management with the service-role client (single-user app)."""

from __future__ import annotations

MIN_PASSWORD_LENGTH = 12


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LENGTH} characters")


def create_owner(client, email: str, password: str) -> str:
    validate_password(password)
    response = client.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    return response.user.id


def _find_user_id(client, email: str) -> str:
    page = 1
    while True:
        users = client.auth.admin.list_users(page=page, per_page=200)
        if not users:
            raise LookupError(f"no user with email {email}")
        for user in users:
            if (user.email or "").lower() == email.lower():
                return user.id
        page += 1


def set_password(client, email: str, password: str) -> str:
    validate_password(password)
    user_id = _find_user_id(client, email)
    client.auth.admin.update_user_by_id(user_id, {"password": password})
    return user_id
```

Replace `worker/src/audiotruyen_worker/cli.py` entirely with:

```python
"""Command-line entry point: `uv run worker <command>`."""

from __future__ import annotations

import argparse
import getpass
import sys

from audiotruyen_worker.config import load_settings
from audiotruyen_worker.doctor import check_ffmpeg, check_r2, check_supabase, run_check


def _doctor() -> int:
    from audiotruyen_worker.db import make_client
    from audiotruyen_worker.storage.r2 import R2Storage

    settings = load_settings()
    client = make_client(settings)
    storage = R2Storage.from_settings(settings)
    results = [
        run_check("supabase", lambda: check_supabase(client)),
        run_check("r2", lambda: check_r2(storage, settings.worker_id)),
        run_check("ffmpeg", check_ffmpeg),
    ]
    for result in results:
        print(f"{'OK  ' if result.ok else 'FAIL'} {result.name:<9} {result.detail}")
    return 0 if all(r.ok for r in results) else 1


def _read_password() -> str:
    first = getpass.getpass("Mật khẩu (ít nhất 12 ký tự): ")
    second = getpass.getpass("Nhập lại mật khẩu: ")
    if first != second:
        raise SystemExit("Hai lần nhập không khớp. Chạy lại lệnh.")
    return first


def _create_user(email: str) -> int:
    from audiotruyen_worker.admin import create_owner
    from audiotruyen_worker.db import make_client

    user_id = create_owner(make_client(load_settings()), email, _read_password())
    print(f"Đã tạo tài khoản {email} ({user_id}).")
    return 0


def _set_password(email: str) -> int:
    from audiotruyen_worker.admin import set_password
    from audiotruyen_worker.db import make_client

    user_id = set_password(make_client(load_settings()), email, _read_password())
    print(f"Đã đổi mật khẩu cho {email} ({user_id}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="worker", description="AudioTruyen worker")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("doctor", help="check Supabase, R2 and ffmpeg connectivity")
    create = sub.add_parser("create-user", help="create the owner account (password prompted)")
    create.add_argument("--email", required=True)
    reset = sub.add_parser("set-password", help="set a new password for an existing account")
    reset.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    if args.command == "create-user":
        return _create_user(args.email)
    if args.command == "set-password":
        return _set_password(args.email)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`worker` prints Vietnamese text; if the Windows console shows mojibake, run it with `PYTHONIOENCODING=utf-8`.

- [ ] **Step 5: Run all worker tests**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen/worker" && uv run pytest -q && uv run pytest -q -m db && uv run ruff check . && uv run ruff format --check .
```

Expected: the first run includes the db tests and passes (`22 passed`); the second shows `6 passed` (db only); ruff clean. If `list_users` in the installed supabase-py returns an object instead of a list, adapt `_find_user_id` to that return type and keep the behaviour (paginate until empty).

Also check that the db tests skip cleanly without the env: `env -u TEST_SUPABASE_URL uv run pytest -q` → passes with `6 skipped`.

- [ ] **Step 6: Commit**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
git add scripts/supabase-test-env.sh worker/src/audiotruyen_worker/admin.py worker/src/audiotruyen_worker/cli.py worker/tests
git commit -m "feat(worker): owner account commands and database-tier queue tests"
```

---

### Task 7: Web app skeleton with single-user sign-in

**Files:**
- Create: `web/` via create-next-app, then `web/lib/env.ts`, `web/lib/env.test.ts`, `web/lib/auth/paths.ts`, `web/lib/auth/paths.test.ts`, `web/lib/supabase/server.ts`, `web/proxy.ts`, `web/app/login/page.tsx`, `web/app/login/login-form.tsx`, `web/app/login/actions.ts`, `web/vitest.config.ts`, `web/.env.local.example`, `.claude/launch.json`
- Rewrite: `web/app/page.tsx`, `web/app/layout.tsx`, `web/app/globals.css`
- Move: `assets/ambient/*.mp3` → `web/public/ambient/`
- Delete: create-next-app sample assets in `web/public/` (`*.svg`)

**Interfaces:**
- Consumes: local Supabase (Tasks 2-4), `worker create-user` (Task 6) for a local test account.
- Produces: `parsePublicEnv(raw) -> {NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY}`, `publicEnv`; `isPublicPath(pathname: string): boolean`; `safeNextPath(value: unknown): string`; `createClient(): Promise<SupabaseClient>` (server); server actions `signIn(prev, formData)` and `signOut()`; CSS variables `--bg --surface --surface-raised --text --text-muted --border --accent --accent-contrast --focus` and Tailwind colors `bg, surface, surface-raised, text, text-muted, border, accent, accent-contrast`.

- [ ] **Step 1: Scaffold and install dependencies**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
npx --yes create-next-app@16.4.1 web --typescript --eslint --tailwind --app --no-src-dir --import-alias "@/*" --use-npm --yes
cd web
npm install @supabase/ssr@0.12.7 @supabase/supabase-js@2.117.3 zod@4.6.7
npm install -D vitest@5.0.4
rm -f public/*.svg
mkdir -p public/ambient && git mv ../assets/ambient/*.mp3 public/ambient/
```

If a flag is rejected, run `npx --yes create-next-app@16.4.1 --help` and use the equivalent flags (TypeScript, ESLint, Tailwind, App Router, no `src/`, alias `@/*`, npm, non-interactive). Remove any nested `web/.git` directory if create-next-app initialised one.

- [ ] **Step 2: Add scripts and vitest config**

In `web/package.json` set `"scripts"` to:

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

`web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
```

`web/.env.local.example`:

```dotenv
# Copy to web/.env.local. Local Supabase values come from: npx --yes supabase@2.121.0 status
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

- [ ] **Step 3: Write the failing unit tests**

`web/lib/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePublicEnv } from "./env";

describe("parsePublicEnv", () => {
  it("accepts a URL and a key", () => {
    const env = parsePublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "a-long-enough-anon-key",
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("rejects a missing key", () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" })).toThrow();
  });

  it("rejects a malformed URL", () => {
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "not a url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a-long-enough-anon-key" }),
    ).toThrow();
  });
});
```

`web/lib/auth/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isPublicPath, safeNextPath } from "./paths";

describe("isPublicPath", () => {
  it("allows the login page", () => {
    expect(isPublicPath("/login")).toBe(true);
  });
  it("protects everything else", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/read/abc/1")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/novel/123")).toBe("/novel/123");
  });
  it("rejects external and protocol-relative targets", () => {
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });
  it("falls back for empty or non-string values", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(42)).toBe("/");
  });
  it("never redirects back to the login page", () => {
    expect(safeNextPath("/login")).toBe("/");
  });
});
```

Run: `cd web && npm test` → fails (modules missing).

- [ ] **Step 4: Implement the library modules**

`web/lib/env.ts`:

```ts
import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function parsePublicEnv(raw: Record<string, string | undefined>): PublicEnv {
  return publicEnvSchema.parse(raw);
}

// Next.js inlines NEXT_PUBLIC_* only when referenced by their full names.
export const publicEnv = parsePublicEnv({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});
```

Note: `env.test.ts` imports this module, so `publicEnv` is evaluated at import time. Make the test pass without real env by setting the two variables in `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-for-vitest-only",
    },
  },
});
```

`web/lib/auth/paths.ts`:

```ts
const PUBLIC_PATHS = new Set(["/login"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || value === "") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (isPublicPath(value)) return "/";
  return value;
}
```

`web/lib/supabase/server.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { publicEnv } from "@/lib/env";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: proxy.ts refreshes the session cookies instead.
        }
      },
    },
  });
}
```

Run: `npm test` → `env` and `paths` tests pass (9 tests).

- [ ] **Step 5: Proxy, sign-in, home, theme**

`web/proxy.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "@/lib/auth/paths";
import { publicEnv } from "@/lib/env";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname, search } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  if (user && isPublicPath(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|ambient/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3|webm)$).*)"],
};
```

`web/app/login/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/paths";
import { createClient } from "@/lib/supabase/server";

export type SignInState = { error: string | null };

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Nhập email và mật khẩu để đăng nhập." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: "Email hoặc mật khẩu không đúng. Kiểm tra lại rồi thử lại." };
  }
  redirect(safeNextPath(formData.get("next")));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
```

`web/app/login/login-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

const initialState: SignInState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="next" value={next} />
      <div className="grid gap-2">
        <label htmlFor="email" className="text-sm font-medium text-text">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-11 rounded-lg border border-border bg-surface-raised px-3 text-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        />
      </div>
      <div className="grid gap-2">
        <label htmlFor="password" className="text-sm font-medium text-text">
          Mật khẩu
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-describedby={state.error ? "login-error" : undefined}
          className="h-11 rounded-lg border border-border bg-surface-raised px-3 text-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        />
        {state.error ? (
          <p id="login-error" role="alert" className="text-sm text-text">
            {state.error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-lg bg-accent px-4 font-medium text-accent-contrast transition-transform active:scale-[0.98] disabled:opacity-70"
      >
        {pending ? "Đang đăng nhập" : "Đăng nhập"}
      </button>
    </form>
  );
}
```

`web/app/login/page.tsx`:

```tsx
import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth/paths";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Đăng nhập · AudioTruyen" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-[100dvh] place-items-center px-4">
      <section className="w-full max-w-sm">
        <p className="text-sm text-text-muted">AudioTruyen</p>
        <h1 className="mt-1 mb-8 text-3xl font-semibold tracking-tight text-text">Đăng nhập</h1>
        <LoginForm next={safeNextPath(next)} />
      </section>
    </main>
  );
}
```

`web/app/page.tsx`:

```tsx
import { signOut } from "./login/actions";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-text">Thư viện</h1>
      <p className="mt-3 text-text-muted">Đang đăng nhập với {user?.email}. Chưa có truyện nào trong thư viện.</p>
      <form action={signOut} className="mt-8">
        <button type="submit" className="h-10 rounded-lg border border-border px-4 text-text transition-transform active:scale-[0.98]">
          Đăng xuất
        </button>
      </form>
    </main>
  );
}
```

`web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Be_Vietnam_Pro } from "next/font/google";
import "./globals.css";

const beVietnam = Be_Vietnam_Pro({
  subsets: ["vietnamese", "latin"],
  weight: ["400", "500", "600"],
  variable: "--font-be-vietnam",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AudioTruyen",
  description: "Đọc và nghe truyện chữ tiếng Việt",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" className={beVietnam.variable}>
      <body className="min-h-[100dvh] font-sans antialiased">{children}</body>
    </html>
  );
}
```

`web/app/globals.css` (replace entirely):

```css
@import "tailwindcss";

/* Theme tokens (spec 6.4). M1 ships the two default presets; M5 adds the customizer. */
:root {
  /* Giấy: light, cool */
  --bg: #f2f4f5;
  --surface: #f8f9fa;
  --surface-raised: #fdfdfd;
  --text: #15191d;
  --text-muted: #525c66;
  --border: #d5dade;
  --accent: #1f6f78;
  --accent-contrast: #f5fafa;
  --focus: #1f6f78;
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Đêm: dark charcoal */
    --bg: #111417;
    --surface: #171b1f;
    --surface-raised: #1e2328;
    --text: #e3e6e9;
    --text-muted: #9aa3ad;
    --border: #2b3238;
    --accent: #6bb8c0;
    --accent-contrast: #0c1a1c;
    --focus: #6bb8c0;
  }
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-text: var(--text);
  --color-text-muted: var(--text-muted);
  --color-border: var(--border);
  --color-accent: var(--accent);
  --color-accent-contrast: var(--accent-contrast);
  --font-sans: var(--font-be-vietnam), system-ui, sans-serif;
}

body {
  background: var(--bg);
  color: var(--text);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```

`.claude/launch.json` (repo root):

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "web",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev", "--prefix", "web"],
      "port": 3000
    }
  ]
}
```

- [ ] **Step 6: Lint, typecheck, test, build**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen/web"
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder-anon-key-000000 sh -c "npm run lint && npm run typecheck && npm test && npm run build"
```

Expected: all four succeed; the build output lists the `/` and `/login` routes and the proxy; there is no deprecation warning about `middleware`.

- [ ] **Step 7: Manual sign-in check against local Supabase (controller)**

1. Write `web/.env.local` from `npx --yes supabase@2.121.0 status` (API URL, anon key).
2. Create `worker/.env` for local use: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `supabase status`, and placeholder R2 values (`R2_ACCOUNT_ID=local`, `R2_ACCESS_KEY_ID=local`, `R2_SECRET_ACCESS_KEY=local`, `R2_BUCKET=local`) because `create-user` only needs Supabase.
3. Create a local test account `owner@audiotruyen.test` with a generated password (`python -c "import secrets; print(secrets.token_urlsafe(18))"`): `cd worker && uv run worker create-user --email owner@audiotruyen.test`. Record the email and password only in `web/.env.local` as `E2E_EMAIL=` / `E2E_PASSWORD=` (gitignored, for M6 E2E tests). Do not paste them into chat.
4. Start the `web` server with the Browser pane `preview_start` (name `web`), then verify in the pane:
   - `http://localhost:3000/` redirects to `/login?next=%2F`.
   - Wrong password shows "Email hoặc mật khẩu không đúng. Kiểm tra lại rồi thử lại."
   - Correct test credentials land on `/` showing "Thư viện" and the email.
   - "Đăng xuất" returns to `/login`; `/` redirects again.
   - With the OS in dark mode (or `resize_window` `colorScheme: "dark"`), the Đêm tokens apply and the button text stays readable.

- [ ] **Step 8: Commit**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
git add web
git add -f .claude/launch.json
git diff --cached --name-only | grep -E "(^|/)\.env($|\.local$)|node_modules|\.next/" && echo "STOP: forbidden file staged" || true
git commit -m "feat(web): Next.js 16 skeleton with single-user sign-in"
```

`-f` is used only for `.claude/launch.json` (its directory is ignored); never pass `-f` together with `web`, which would force-add `node_modules`, `.next` and `.env.local`. The `grep` line must print nothing before you commit.

---

### Task 8: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run lint|typecheck|test|build` (Task 7), `uv run ruff|pytest` (Tasks 5-6), `supabase test db` (Tasks 2-4), `scripts/supabase-test-env.sh` (Task 6).
- Produces: three required jobs `web`, `worker`, `database`.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main, "rework/**"]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  web:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    env:
      NEXT_PUBLIC_SUPABASE_URL: http://127.0.0.1:54321
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ci-placeholder-anon-key-000000
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  worker:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: worker
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
      - run: uv sync --locked
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run pytest -q -m "not db"

  database:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx --yes supabase@2.121.0 start
      - run: npx --yes supabase@2.121.0 test db
      - run: bash scripts/supabase-test-env.sh >> "$GITHUB_ENV"
      - uses: astral-sh/setup-uv@v6
      - run: uv sync --locked
        working-directory: worker
      - run: uv run pytest -q -m db
        working-directory: worker
```

- [ ] **Step 2: Validate locally what can be validated**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml', encoding='utf-8')); print('yaml ok')" 2>/dev/null || npx --yes yaml-lint .github/workflows/ci.yml
cd worker && uv sync --locked && uv run pytest -q -m "not db"
```

Expected: `yaml ok` (or the linter passes) and the non-db worker suite passes with `--locked`.

- [ ] **Step 3: Commit**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
git add .github/workflows/ci.yml
git commit -m "ci: web, worker and database jobs"
```

- [ ] **Step 4: [USER] Approve pushing the branch to run CI**

Ask the owner: "Push nhánh `rework/m1` lên GitHub để chạy CI?" Only after a yes: `git push -u origin rework/m1`, then watch the run with `gh run watch --exit-status` (or `gh run list --branch rework/m1 --limit 1` then `gh run view <id> --log-failed`). Fix failures in new commits (each fix reviewed like any task change) until all three jobs pass. Record the green run URL.

---

### Task 9: Cloud setup and migration of the owner's project

All steps are owner actions or need the owner's confirmation. The controller prepares commands, explains each step in Vietnamese, and waits.

**Files:**
- Create (owner, gitignored): `worker/.env` (cloud values), `web/.env.local` (cloud values)
- Create (gitignored): `backup/v1-*.sql`

**Interfaces:**
- Consumes: migrations (Tasks 2-4), `worker doctor` / `create-user` / `set-password` (Tasks 5-6), web app (Task 7).
- Produces: owner's Supabase project on the v2 schema, R2 bucket + two tokens, a working cloud `worker doctor`, the owner signed in to the local web app against the cloud project.

- [ ] **Step 1: [USER] Cloudflare R2 bucket and tokens**

In the Cloudflare dashboard (R2 must be enabled on the account):
1. R2 → Create bucket `audiotruyen`, location hint Asia-Pacific, default storage class.
2. R2 → Manage API tokens → Create token "audiotruyen-worker": permission **Object Read & Write**, scoped to bucket `audiotruyen`. Copy Access Key ID and Secret Access Key.
3. Create token "audiotruyen-web": permission **Object Read only**, scoped to `audiotruyen` (used by Vercel in M3/M6; store it in a password manager for now).
4. Note the Account ID (R2 overview page).

The owner pastes the worker token values into `worker/.env` themselves (copy from `worker/.env.example`). The controller never sees these values.

- [ ] **Step 2: [USER] Link the Supabase project and back up v1 data**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen"
npx --yes supabase@2.121.0 login
npx --yes supabase@2.121.0 link --project-ref <project-ref>
mkdir -p backup
npx --yes supabase@2.121.0 db dump --linked -f backup/v1-schema.sql
npx --yes supabase@2.121.0 db dump --linked --data-only -f backup/v1-data.sql
ls -la backup
```

`login` opens a browser; `link` asks for the database password (owner types it). The project ref is in the dashboard URL. Both dump files must be non-empty before continuing; `backup/` is gitignored.

- [ ] **Step 3: [USER] Confirm the destructive migration, then push**

Tell the owner exactly what will happen: the first v2 migration drops the v1 tables `novels` and `reading_progress` and the function `update_updated_at` in the linked project, then creates the v2 schema; v1 data survives only in `backup/`. Ask for an explicit "đồng ý xóa bảng v1". Only after that:

```bash
npx --yes supabase@2.121.0 db push --dry-run
npx --yes supabase@2.121.0 db push
npx --yes supabase@2.121.0 migration list
```

Expected: dry run lists the three v2 migrations; `migration list` shows them applied remotely.

- [ ] **Step 4: [USER] Auth settings and the owner account**

In the Supabase dashboard:
1. Authentication → Sign In / Providers → Email: turn **off** "Allow new users to sign up" (keep the Email provider enabled).
2. Authentication → Users: check whether the owner's email exists.
   - Exists and the owner knows its password: nothing to do.
   - Exists without a usable password (for example created by Google sign-in in v1): owner runs `cd worker && uv run worker set-password --email <owner email>` and types a new password (12+ characters) at the prompt.
   - Does not exist: owner runs `uv run worker create-user --email <owner email>`.

Both commands use `worker/.env` (cloud values) and prompt for the password with hidden input.

- [ ] **Step 5: Verify the cloud setup**

```bash
cd "D:/importantProjects/WorkSpace_Personal Project_ Agents/old/AudioTruyen/worker" && uv run worker doctor
```

Expected:
```
OK   supabase  connected, worker_status readable
OK   r2        put/get/delete ok in bucket audiotruyen
OK   ffmpeg    C:\Users\MSI\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe
```

Then the owner sets `web/.env.local` to the cloud URL and anon key (Settings → API), runs `npm run dev --prefix web`, opens http://localhost:3000 in their own browser, and signs in with their own password. Ask them to confirm they reach "Thư viện" and that "Đăng xuất" works. Restore `web/.env.local` to local values afterwards only if they want local development by default (their choice; record it).

- [ ] **Step 6: Record completion**

In the spec's milestone table (section 8), prefix the M1 exit-criteria cell with `**Done** (<today's date>): v2 schema live on the reused project, CI green (<green run URL from Task 8>).` Commit:

```bash
git add docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md
git commit -m "docs: mark M1 foundation done"
```

---

## M1 exit criteria (spec 8)

- Repo restructured, v1 removed (Task 1).
- Supabase schema + RLS + `claim_job` (and `requeue_expired_jobs`, `begin_chapter_audio`) with pgTAP and db-tier tests (Tasks 2-4, 6).
- Auth with a single user: sign-up disabled, owner signs in on the web app (Tasks 7, 9).
- R2 bucket + two tokens, verified by `worker doctor` (Task 9).
- CI green on GitHub Actions (Task 8).
