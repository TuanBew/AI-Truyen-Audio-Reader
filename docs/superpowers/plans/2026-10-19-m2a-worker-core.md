# M2a Worker Core: Queue, Scraper, Text Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker turns a pasted truyenfull URL into a novel with its full table of contents, fetches chapter text (including ad-locked chapters), segments it, labels speakers/emotions with the heuristic strategy, and runs all of this as fenced, leased jobs from a hardened queue.

**Architecture:** A new migration hardens `jobs` for web writes (spec 7.3.1) and adds fenced worker RPCs. The worker gains four layers, each pure and testable on its own: `sources/` (polite HTTP client + truyenfull parsers on recorded fixtures), `text/` (segmentation on the original text, per-segment TTS normalization), `speakers/` (strategy chain with the heuristic), and `jobs/` (claim loop, heartbeat thread, Realtime wake, handlers). `worker run` wires them; `worker enqueue` lets the owner test without the web app.

**Tech Stack:** Python 3.12, uv, supabase-py 2.32 (PostgREST RPC + `realtime` AsyncRealtimeClient), httpx 0.28, selectolax 1.0 (lexbor backend), vietnormalizer 0.2.3, pytest, ruff 0.17; Supabase Postgres + pgTAP (Supabase CLI 2.121.0).

**Spec:** `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md` (sections 2.1, 4, 5.1-5.4, 5.9, 7.2, 7.3.1, 7.3.2, 7.4, 8). M2 is split: this plan is **M2a**; **M2b** (VieNeu synthesis, quality guard, incremental encode, `r2_objects` ledger and caps, uploads, `full.webm`, ONNX CPU fix) gets its own plan.

## Global Constraints

- Work on branch `rework/m2a` (from `main`). Commit after every task. Never push; the controller merges to `main` and pushes after Task 11.
- Python `>=3.12,<3.13`, managed by uv. From `worker/`: `uv run ruff check . && uv run ruff format --check .` must pass (line length 100, rules E, F, I, UP, B). Run `uv run ruff check --fix . && uv run ruff format .` before each commit.
- New runtime dependencies, exactly: `httpx>=0.28`, `selectolax>=1.0.1`, `realtime>=2.32`, `vietnormalizer==0.2.3` (pinned: its behaviour is asserted by golden tests). selectolax 1.x: import only `from selectolax.lexbor import LexborHTMLParser`; `selectolax.parser` raises ImportError.
- Database rules (CLAUDE.md): never edit applied migrations (`20261015000100/0200/0300`); the new migration is `supabase/migrations/20261019000100_m2a_jobs_hardening.sql`. Every new function: `revoke execute ... from public, anon, authenticated`, then grant only the intended roles; `set search_path = ''`; fully qualified names. pgTAP coverage for every new function.
- Secrets: never print, log or commit the service-role key, R2 secrets or the OpenRouter key. The Realtime client logs its WebSocket URL (which contains the service-role key as `apikey`) at DEBUG, so the `realtime`, `websockets`, `httpx`, `httpcore`, `hpack`, `postgrest` and `supabase` loggers are always clamped to WARNING.
- **`worker/.env` points at the owner's production Supabase project.** Never run `worker run` or `worker enqueue` during development without the local overrides from Task 10 Step 3 (environment variables override `.env`). A git worktree has no `worker/.env`; Task 10 Step 3 also exports dummy R2 values for that case.
- Scraping (spec 2.1, 5.2): only `truyenfull.live` / `www.truyenfull.live`; at least 1.0 s between request starts; never try to solve or bypass a Cloudflare challenge (report `SourceBlocked`).
- Job error messages and CLI output for the owner are Vietnamese; log lines are English.
- Tests: unit tier `uv run pytest -m "not db"` (no network, no database). DB tier `uv run pytest -m db` needs local Supabase (`npx --yes supabase@2.121.0 start`, then `set -a; source <(bash scripts/supabase-test-env.sh); set +a` from the repo root in Git Bash). pgTAP: `npx --yes supabase@2.121.0 test db` from the repo root.
- Fixtures read with `encoding="utf-8"`; never rely on the Windows console code page.
- Do not touch `web/` in this plan.

## Already in the repository (committed with this plan)

- `worker/tests/fixtures/truyenfull/*.html` + `SOURCES.txt`: real pages recorded 2026-10-19 by `worker/scripts/record_truyenfull_fixtures.py` (scripts, styles, the account modal, Cloudflare's encoded contact e-mail and long cover-image tokens removed; chapter bodies cut to a head + tail excerpt because the repository is public). Do not re-record unless a parser test proves the site changed.
- Facts verified while planning (used by the tests below): TOC has 50 chapters per page at `/{slug}/trang-{n}/`, page count in `<input id="total-page">`; chapter bodies end with two hidden `<p style="display: none">` SEO paragraphs; novels with a `-free` slug answer non-browser clients with a Cloudflare managed challenge (`403`, `cf-mitigated: challenge`, `<title>Just a moment...</title>`) while normal pages embed a harmless `cf-turnstile` comment widget; a removed novel answers `301` to `/tim-kiem/?tukhoa=...`; `vietnormalizer`'s built-in word dictionary rewrites Vietnamese words (`nghe` → `nghê`, `long` → `lon`), so it is used with its dictionaries and transliteration off; Realtime delivers a job insert to the worker in 0.1-0.5 s locally.

## File map

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20261019000100_m2a_jobs_hardening.sql` | jobs guard trigger, queue cap, dedupe, policies, default privileges, `claim_job(types)`, `worker_heartbeat`, `finish_job`, `fail_job` | 1 |
| `supabase/tests/04_jobs_guard.test.sql`, `05_worker_rpcs.test.sql`, `06_privileges.test.sql` | pgTAP for the above | 1 |
| `worker/src/audiotruyen_worker/sources/base.py` | data types, errors, `SourceAdapter` protocol | 2 |
| `worker/src/audiotruyen_worker/sources/truyenfull_parse.py` | pure HTML parsers | 2 |
| `worker/src/audiotruyen_worker/sources/http.py` | `PoliteClient`: spacing, retries, challenge/redirect handling | 3 |
| `worker/src/audiotruyen_worker/sources/truyenfull.py` | `TruyenfullAdapter` | 3 |
| `worker/src/audiotruyen_worker/text/normalize.py` (+ `text/data/vietnormalizer_empty.csv`) | TTS normalization | 4 |
| `worker/src/audiotruyen_worker/text/segment.py` | segmentation with original-text offsets | 5 |
| `worker/src/audiotruyen_worker/speakers/base.py`, `speakers/heuristic.py` | strategy contract, chain, heuristic | 6 |
| `worker/src/audiotruyen_worker/jobs/queue.py`, `jobs/runner.py` | RPC wrappers, job loop, heartbeat | 7 |
| `worker/src/audiotruyen_worker/store.py`, `jobs/handlers.py` | DB access for handlers; search/fetch_novel/fetch_chapter | 8 |
| `worker/src/audiotruyen_worker/jobs/wake.py`, `logging_setup.py`, `app.py`, `admin.py`, `cli.py` | Realtime wake, logging, `worker run` / `worker enqueue` | 9 |
| `docs/...spec...md`, `CLAUDE.md` | spec + guidance updates | 10 |

---

### Task 1: Jobs hardening migration (cost prerequisites, worker RPCs, default privileges)

**Files:**
- Create: `supabase/migrations/20261019000100_m2a_jobs_hardening.sql`
- Create: `supabase/tests/04_jobs_guard.test.sql`, `supabase/tests/05_worker_rpcs.test.sql`, `supabase/tests/06_privileges.test.sql`
- Modify: `supabase/tests/03_functions.test.sql` (seed rows only; the new `jobs_synthesize_payload` check needs a payload)

**Interfaces:**
- Produces (SQL, service_role only):
  - `claim_job(p_worker_id text, p_lease_seconds integer default 300, p_types text[] default null) returns setof jobs` (replaces the 2-argument version; existing 2-argument calls keep working through the defaults)
  - `worker_heartbeat(p_worker_id text, p_version text, p_device text, p_job_id uuid default null, p_lease_seconds integer default 300) returns boolean` — false when the worker no longer owns `p_job_id`
  - `finish_job(p_job_id uuid, p_worker_id text, p_status text, p_result jsonb default null, p_error text default null) returns boolean` — `p_status` in `done|cancelled`
  - `fail_job(p_job_id uuid, p_worker_id text, p_error text, p_retryable boolean default true) returns text` — `'queued'` (retry with `run_after = now() + 2^attempts min`), `'failed'`, or null when not owned
  - `jobs.type` accepts `cleanup_r2` (inserted only by database-owned code; M2b adds the triggers and handler)

- [ ] **Step 1: Write the failing pgTAP tests**

Create `supabase/tests/04_jobs_guard.test.sql`:

```sql
begin;
select plan(30);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now());

-- Seed rows as postgres (trusted, guard skipped).
insert into public.jobs (id, user_id, type, status, attempts, error, result, run_after) values
  ('20000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 'queued', 0, null, null, now()),
  ('20000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 'failed', 3, 'boom', '{"x":1}', now() - interval '1 day'),
  ('20000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 'done', 1, null, null, now());

set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';

-- INSERT: server values win
select lives_ok(
  $$insert into public.jobs (id, user_id, type, payload, priority, created_at, run_after)
    values ('99999999-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'fetch_novel',
            '{"url": "https://truyenfull.live/a/"}', 0, now() - interval '1 year', now() - interval '1 year')$$,
  'owner enqueues a valid job'
);
select is((select count(*)::int from public.jobs where id = '99999999-0000-0000-0000-000000000001'), 0, 'client-supplied id is replaced');
select is((select run_after from public.jobs where payload ->> 'url' = 'https://truyenfull.live/a/'), now(), 'run_after is server time');
select is((select created_at from public.jobs where payload ->> 'url' = 'https://truyenfull.live/a/'), now(), 'created_at is server time');

-- INSERT: rejected shapes
select throws_ok($$insert into public.jobs (user_id, type, status) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', 'running')$$, '42501', null, 'cannot insert a running job');
select throws_ok($$insert into public.jobs (user_id, type, attempts) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', 1)$$, '42501', null, 'cannot insert attempts > 0');
select throws_ok($$insert into public.jobs (user_id, type, max_attempts) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', 5)$$, '42501', null, 'cannot raise max_attempts above 3');
select throws_ok($$insert into public.jobs (user_id, type, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', 5)$$, '42501', null, 'priority must be 0, 10 or 20');
select throws_ok($$insert into public.jobs (user_id, type, worker_id) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', 'w')$$, '42501', null, 'cannot pre-assign a worker');
select throws_ok($$insert into public.jobs (user_id, type, result) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', '{}')$$, '42501', null, 'cannot set a result');
select throws_ok($$insert into public.jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'search', jsonb_build_object('q', repeat('x', 9000)))$$, '54000', null, 'payload over 8 KB is rejected');
select throws_ok($$insert into public.jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'cleanup_r2', '{"prefix": "audio/"}')$$, '42501', null, 'web cannot create cleanup_r2 jobs');
select throws_ok($$insert into public.jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'synthesize', '{"chapter_id": "c1"}')$$, '23514', null, 'synthesize needs chapter_id and voice_hash');

-- Dedupe of live synthesize jobs
select lives_ok($$insert into public.jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'synthesize', '{"chapter_id": "c1", "voice_hash": "h1"}')$$, 'first synthesize job');
select throws_ok($$insert into public.jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'synthesize', '{"chapter_id": "c1", "voice_hash": "h1"}')$$, '23505', null, 'duplicate live synthesize job is rejected');
select lives_ok($$insert into public.jobs (user_id, type, payload) values ('11111111-1111-1111-1111-111111111111', 'synthesize', '{"chapter_id": "c1", "voice_hash": "h2"}')$$, 'other voice_hash is a different job');

-- UPDATE transitions
select throws_ok($$update public.jobs set status = 'cancelled', priority = 0 where id = '20000000-0000-0000-0000-000000000001'$$, '42501', null, 'cancel may not change other columns');
select lives_ok($$update public.jobs set status = 'cancelled' where id = '20000000-0000-0000-0000-000000000001'$$, 'queued -> cancelled');
select is((select status from public.jobs where id = '20000000-0000-0000-0000-000000000001'), 'cancelled', 'job is cancelled');
select throws_ok($$update public.jobs set status = 'queued', payload = '{"x": 2}' where id = '20000000-0000-0000-0000-000000000002'$$, '42501', null, 'retry may not change the payload');
select lives_ok($$update public.jobs set status = 'queued' where id = '20000000-0000-0000-0000-000000000002'$$, 'failed -> queued');
select is(
  (select row(attempts, error, result, run_after = now())::text from public.jobs where id = '20000000-0000-0000-0000-000000000002'),
  '(0,,,t)', 'retry resets attempts, error, result and run_after'
);
select throws_ok($$update public.jobs set status = 'running' where id = '20000000-0000-0000-0000-000000000002'$$, '42501', null, 'cannot claim from the web');
select throws_ok($$update public.jobs set status = 'queued' where id = '20000000-0000-0000-0000-000000000003'$$, '42501', null, 'cannot requeue a done job');
select throws_ok($$delete from public.jobs where id = '20000000-0000-0000-0000-000000000003'$$, '42501', null, 'cannot delete jobs');

-- Queue cap: 500 queued jobs per owner (the seed runs as postgres, which the cap exempts)
reset role;
insert into public.jobs (user_id, type, payload)
select '11111111-1111-1111-1111-111111111111', 'fetch_chapter', jsonb_build_object('n', n)
  from generate_series(1, 500 - (select count(*)::int from public.jobs where status = 'queued')) as n;
set local role authenticated;
select is((select count(*)::int from public.jobs where status = 'queued'), 500, '500 jobs queued');
select throws_ok($$insert into public.jobs (user_id, type) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel')$$, '54000', null, 'insert over the cap is rejected');
update public.jobs set status = 'cancelled' where id = (select id from public.jobs where status = 'queued' limit 1);
reset role;
update public.jobs set status = 'failed' where id = '20000000-0000-0000-0000-000000000003';
insert into public.jobs (user_id, type) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel');
set local role authenticated;
select throws_ok($$update public.jobs set status = 'queued' where id = '20000000-0000-0000-0000-000000000003'$$, '54000', null, 'retry over the cap is rejected');
reset role;
set local role service_role;
select lives_ok($$insert into public.jobs (user_id, type) values ('11111111-1111-1111-1111-111111111111', 'check_updates')$$, 'service_role is exempt from the cap');
select is((select count(*)::int from public.jobs where status = 'queued'), 501, 'worker inserts may exceed the cap');

select * from finish();
rollback;
```

Create `supabase/tests/05_worker_rpcs.test.sql`:

```sql
begin;
select plan(22);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now());
insert into public.jobs (id, user_id, type, payload, priority, created_at) values
  ('30000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'synthesize', '{"chapter_id": "c", "voice_hash": "h"}', 0, now() - interval '5 minutes'),
  ('30000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'fetch_chapter', '{}', 10, now() - interval '4 minutes'),
  ('30000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'search', '{}', 10, now() - interval '3 minutes');

set local role service_role;

-- claim_job type filter
select is(
  (select id from public.claim_job('w1', 300, array['fetch_chapter', 'search'])),
  '30000000-0000-0000-0000-000000000002'::uuid, 'type filter skips the higher-priority synthesize job'
);
select is((select id from public.claim_job('w1', 300)), '30000000-0000-0000-0000-000000000001'::uuid, 'no filter claims any type');

-- worker_heartbeat
select is(public.worker_heartbeat('w1', '0.2.0', 'cpu', '30000000-0000-0000-0000-000000000002', 600), true, 'owner extends its lease');
select ok(
  (select lease_until > now() + interval '9 minutes' from public.jobs where id = '30000000-0000-0000-0000-000000000002'),
  'lease extended by p_lease_seconds'
);
select is(
  (select row(version, device, queue_depth, current_job)::text from public.worker_status where worker_id = 'w1'),
  '(0.2.0,cpu,1,30000000-0000-0000-0000-000000000002)', 'worker_status upserted with server-side queue depth'
);
select is(public.worker_heartbeat('w2', '0.2.0', 'cpu', '30000000-0000-0000-0000-000000000002'), false, 'another worker cannot extend the lease');
update public.jobs set lease_until = now() - interval '1 second' where id = '30000000-0000-0000-0000-000000000001';
select is(public.worker_heartbeat('w1', '0.2.0', 'cpu', '30000000-0000-0000-0000-000000000001'), false, 'expired lease is requeued and reported lost');
select is((select status from public.jobs where id = '30000000-0000-0000-0000-000000000001'), 'queued', 'expired job is back in the queue');
select is((select current_job from public.worker_status where worker_id = 'w1'), null, 'lost job is not reported as current');

-- finish_job
select is(public.finish_job('30000000-0000-0000-0000-000000000002', 'w2', 'done'), false, 'non-owner cannot finish');
select is(public.finish_job('30000000-0000-0000-0000-000000000002', 'w1', 'done', '{"ok": true}'), true, 'owner finishes');
select is(
  (select row(status, result, lease_until)::text from public.jobs where id = '30000000-0000-0000-0000-000000000002'),
  '(done,"{""ok"": true}",)', 'done with result and no lease'
);
select is(public.finish_job('30000000-0000-0000-0000-000000000002', 'w1', 'done'), false, 'finishing twice is a no-op');
select throws_ok($$select public.finish_job('30000000-0000-0000-0000-000000000003', 'w1', 'failed')$$, '22023', null, 'finish_job only accepts done or cancelled');

-- fail_job
select is((select id from public.claim_job('w1', 300, array['search'])), '30000000-0000-0000-0000-000000000003'::uuid, 'claim search job (attempt 1)');
select is(public.fail_job('30000000-0000-0000-0000-000000000003', 'w1', 'timeout'), 'queued', 'retryable failure with attempts left is requeued');
select is(
  (select row(worker_id, lease_until, error, run_after = now() + interval '2 minutes')::text from public.jobs where id = '30000000-0000-0000-0000-000000000003'),
  '(,,timeout,t)', 'backoff 2^attempts minutes, worker released'
);
update public.jobs set run_after = now() where id = '30000000-0000-0000-0000-000000000003';
select is((select attempts from public.claim_job('w1', 300, array['search'])), 2, 'claim again (attempt 2)');
select is(public.fail_job('30000000-0000-0000-0000-000000000003', 'w1', 'parser broken', false), 'failed', 'non-retryable failure fails at once');
select is(public.fail_job('30000000-0000-0000-0000-000000000003', 'w1', 'again'), null, 'failing a job you no longer own returns null');
update public.jobs set status = 'running', worker_id = 'w1', attempts = 3 where id = '30000000-0000-0000-0000-000000000003';
select is(public.fail_job('30000000-0000-0000-0000-000000000003', 'w1', 'still broken'), 'failed', 'no attempts left fails');

-- permissions
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select throws_ok($$select public.worker_heartbeat('x', 'v', 'cpu')$$, '42501', null, 'authenticated cannot call worker RPCs');

select * from finish();
rollback;
```

Create `supabase/tests/06_privileges.test.sql`:

```sql
-- Allow-lists for table RLS and function privileges (spec 7.3.1). Extension-owned objects
-- (pgTAP itself) are excluded.
begin;
select plan(7);

select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity$$,
  'every public table has row level security enabled'
);

select is_empty(
  $$select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute'))$$,
  'no public function is executable by anon or authenticated'
);

select set_eq(
  $$select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('service_role', p.oid, 'execute')
       and p.prorettype <> 'trigger'::regtype$$,
  array[
    'claim_job(text,integer,text[])',
    'requeue_expired_jobs()',
    'begin_chapter_audio(uuid,text)',
    'worker_heartbeat(text,text,text,uuid,integer)',
    'finish_job(uuid,text,text,jsonb,text)',
    'fail_job(uuid,text,text,boolean)'
  ],
  'service_role executes exactly the worker allow-list'
);

select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))$$,
  'anon has no table privileges'
);

select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and (has_table_privilege('authenticated', c.oid, 'truncate')
            or has_table_privilege('authenticated', c.oid, 'trigger')
            or has_table_privilege('authenticated', c.oid, 'references'))$$,
  'authenticated has no truncate, trigger or references'
);

select ok(not has_table_privilege('authenticated', 'public.jobs', 'delete'), 'authenticated cannot delete jobs');

select ok(
  not exists (
    select 1 from pg_default_acl a
     where a.defaclrole = 'postgres'::regrole and a.defaclobjtype = 'f'
       and a.defaclnamespace in (0, 'public'::regnamespace)
       and exists (select 1 from aclexplode(a.defaclacl) x
                    where x.privilege_type = 'EXECUTE' and x.grantee in (0, 'anon'::regrole, 'authenticated'::regrole))
  ),
  'future functions by postgres are not executable by PUBLIC, anon or authenticated'
);

select * from finish();
rollback;
```

In `supabase/tests/03_functions.test.sql`, replace the jobs seed (lines 11-14):

```sql
insert into public.jobs (id, user_id, type, priority, created_at, run_after) values
  ('10000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'synthesize', 10, now() - interval '3 minutes', now()),
  ('10000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 0, now() - interval '1 minute', now()),
  ('10000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 0, now() - interval '2 minutes', now() + interval '1 hour');
```

with (adds payloads; nothing else in the file changes):

```sql
insert into public.jobs (id, user_id, type, payload, priority, created_at, run_after) values
  ('10000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'synthesize', '{"chapter_id": "cccccccc-0000-0000-0000-000000000001", "voice_hash": "h1"}', 10, now() - interval '3 minutes', now()),
  ('10000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'fetch_novel', '{}', 0, now() - interval '1 minute', now()),
  ('10000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'fetch_novel', '{}', 0, now() - interval '2 minutes', now() + interval '1 hour');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (repo root, Docker running, local stack started): `npx --yes supabase@2.121.0 db reset && npx --yes supabase@2.121.0 test db`
Expected: 04, 05 and 06 FAIL (guard, RPCs and privilege rules do not exist yet); 01, 02 and 03 pass.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261019000100_m2a_jobs_hardening.sql`:

```sql
-- M2a: job write constraints, queue cap, dedupe, worker job RPCs, default privileges.
-- Spec 5.1 (job loop) and 7.3.1 (cost and abuse protection).

-- 1. Default privileges: functions created later are not executable by PUBLIC, anon or
--    authenticated unless a migration grants it; authenticated never gets truncate/trigger/references.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
revoke truncate, trigger, references on all tables in schema public from authenticated;
alter default privileges for role postgres in schema public revoke truncate, trigger, references on tables from authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- 2. Job shape constraints (all roles).
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (
  type in ('search', 'fetch_novel', 'fetch_chapter', 'synthesize', 'check_updates', 'cleanup_r2')
);
alter table public.jobs add constraint jobs_priority_check check (priority in (0, 10, 20));
alter table public.jobs add constraint jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 10);
alter table public.jobs add constraint jobs_synthesize_payload check (
  type <> 'synthesize'
  or (coalesce(payload ->> 'chapter_id', '') <> '' and coalesce(payload ->> 'voice_hash', '') <> '')
);

-- 3. One live synthesize job per (owner, chapter, voice_hash); fast queue-cap count.
create unique index jobs_synthesize_dedupe on public.jobs (user_id, (payload ->> 'chapter_id'), (payload ->> 'voice_hash'))
  where type = 'synthesize' and status in ('queued', 'running');
create index jobs_owner_queued on public.jobs (user_id) where status = 'queued';

-- 4. Write guard for the web app (role authenticated). The worker (service_role) and database-owned
--    functions (current_user postgres) are trusted and skip it, so the cap never wedges a requeue.
create function public.jobs_guard_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  reset_cols constant text[] := array['status', 'updated_at', 'attempts', 'error', 'result', 'run_after', 'worker_id', 'lease_until'];
  queued integer;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.type = 'cleanup_r2' then
      raise exception 'jobs: cleanup_r2 jobs are created by the database only' using errcode = '42501';
    end if;
    if new.status <> 'queued' or new.attempts <> 0 or new.max_attempts not between 1 and 3
       or new.priority not in (0, 10, 20)
       or new.worker_id is not null or new.lease_until is not null
       or new.result is not null or new.error is not null then
      raise exception 'jobs: a new job must be queued, unclaimed, with attempts 0, max_attempts <= 3 and priority 0, 10 or 20'
        using errcode = '42501';
    end if;
    if octet_length(new.payload::text) > 8192 then
      raise exception 'jobs: payload larger than 8 KB' using errcode = '54000';
    end if;
    new.id := gen_random_uuid();
    new.created_at := now();
    new.updated_at := now();
    new.run_after := now();
  elsif old.status = 'queued' and new.status = 'cancelled' then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'jobs: cancelling may only change status' using errcode = '42501';
    end if;
    return new;
  elsif old.status = 'failed' and new.status = 'queued' then
    if (to_jsonb(new) - reset_cols) is distinct from (to_jsonb(old) - reset_cols) then
      raise exception 'jobs: retrying may only change status' using errcode = '42501';
    end if;
    new.attempts := 0;
    new.error := null;
    new.result := null;
    new.run_after := now();
    new.worker_id := null;
    new.lease_until := null;
  else
    raise exception 'jobs: only queued -> cancelled and failed -> queued are allowed' using errcode = '42501';
  end if;

  -- Queue cap (insert and retry). The advisory lock serializes concurrent enqueues per owner.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  select count(*) into queued from public.jobs j where j.user_id = new.user_id and j.status = 'queued';
  if queued >= 500 then
    raise exception 'jobs: queue limit reached (500 queued jobs)' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke execute on function public.jobs_guard_write() from public, anon, authenticated;

create trigger jobs_guard_write before insert or update on public.jobs
  for each row execute function public.jobs_guard_write();

-- 5. Owner policies split by command; no DELETE for the web app.
drop policy jobs_owner on public.jobs;
create policy jobs_owner_select on public.jobs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy jobs_owner_insert on public.jobs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy jobs_owner_update on public.jobs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke delete on public.jobs from authenticated;

-- 6. claim_job gains a type filter, so a worker only claims job types it can run.
drop function public.claim_job(text, integer);
create function public.claim_job(p_worker_id text, p_lease_seconds integer default 300, p_types text[] default null)
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
        and (p_types is null or q.type = any (p_types))
      order by q.priority, q.created_at
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

-- 7. Worker RPCs. Every job write is fenced by (id, worker_id, status = 'running').

-- Heartbeat: requeue expired leases, extend the current job's lease, upsert worker_status.
-- Returns false when the worker no longer owns p_job_id (lease expired and requeued).
create function public.worker_heartbeat(
  p_worker_id text, p_version text, p_device text, p_job_id uuid default null, p_lease_seconds integer default 300
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  owned boolean := true;
begin
  perform public.requeue_expired_jobs();
  if p_job_id is not null then
    update public.jobs
       set lease_until = now() + make_interval(secs => p_lease_seconds)
     where id = p_job_id and worker_id = p_worker_id and status = 'running';
    owned := found;
  end if;
  insert into public.worker_status as w (worker_id, last_seen, version, device, queue_depth, current_job)
  values (
    p_worker_id, now(), p_version, p_device,
    (select count(*) from public.jobs q where q.status = 'queued' and q.run_after <= now()),
    case when owned then p_job_id end
  )
  on conflict (worker_id) do update
     set last_seen = excluded.last_seen,
         version = excluded.version,
         device = excluded.device,
         queue_depth = excluded.queue_depth,
         current_job = excluded.current_job;
  return owned;
end;
$$;

-- Finish a running job as done or cancelled.
create function public.finish_job(
  p_job_id uuid, p_worker_id text, p_status text, p_result jsonb default null, p_error text default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_status not in ('done', 'cancelled') then
    raise exception 'finish_job: status must be done or cancelled' using errcode = '22023';
  end if;
  update public.jobs
     set status = p_status, result = p_result, error = left(p_error, 2000), lease_until = null
   where id = p_job_id and worker_id = p_worker_id and status = 'running';
  return found;
end;
$$;

-- Fail a running job: retryable failures with attempts left go back to the queue with
-- run_after = now() + 2^attempts minutes; otherwise failed. Returns the new status, or null
-- when this worker no longer owns the job.
create function public.fail_job(p_job_id uuid, p_worker_id text, p_error text, p_retryable boolean default true)
returns text
language plpgsql
set search_path = ''
as $$
declare
  new_status text;
begin
  update public.jobs j
     set status = case when p_retryable and j.attempts < j.max_attempts then 'queued' else 'failed' end,
         run_after = case when p_retryable and j.attempts < j.max_attempts
                          then now() + make_interval(mins => power(2, j.attempts)::integer)
                          else j.run_after end,
         error = left(p_error, 2000),
         worker_id = null,
         lease_until = null
   where j.id = p_job_id and j.worker_id = p_worker_id and j.status = 'running'
  returning j.status into new_status;
  return new_status;
end;
$$;

revoke execute on function public.claim_job(text, integer, text[]) from public, anon, authenticated;
revoke execute on function public.worker_heartbeat(text, text, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.finish_job(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.fail_job(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_job(text, integer, text[]) to service_role;
grant execute on function public.worker_heartbeat(text, text, text, uuid, integer) to service_role;
grant execute on function public.finish_job(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.fail_job(uuid, text, text, boolean) to service_role;
```

Notes for the implementer:
- The guard checks `current_user`, not `auth.role()`: inside `security definer` functions (`claim_job`, `requeue_expired_jobs`, and M2b's cleanup triggers) `current_user` is `postgres`, and worker connections are `service_role`; both are trusted and skip the guard, so the cap can never wedge a requeue.
- BEFORE triggers fire in name order: `jobs_guard_write` runs before `set_updated_at`, which is why the guard ignores `updated_at` when comparing rows.

- [ ] **Step 4: Run all database tests**

Run: `npx --yes supabase@2.121.0 db reset && npx --yes supabase@2.121.0 test db`
Expected: `All tests successful.` (6 files, 113 tests).

Then the existing worker DB tier (it calls the 2-argument `claim_job` by name):
Run (Git Bash, repo root): `set -a; source <(bash scripts/supabase-test-env.sh); set +a; cd worker && uv run pytest -m db -q`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261019000100_m2a_jobs_hardening.sql supabase/tests/03_functions.test.sql supabase/tests/04_jobs_guard.test.sql supabase/tests/05_worker_rpcs.test.sql supabase/tests/06_privileges.test.sql
git commit -m "feat(db): harden jobs for web writes and add fenced worker RPCs (spec 5.1, 7.3.1)"
```

---

### Task 2: Source contract and truyenfull parsers

**Files:**
- Modify: `worker/pyproject.toml` (version and dependencies), `worker/uv.lock` (regenerated)
- Create: `worker/src/audiotruyen_worker/sources/__init__.py` (empty), `sources/base.py`, `sources/truyenfull_parse.py`
- Test: `worker/tests/test_truyenfull_parse.py` (fixtures already in `worker/tests/fixtures/truyenfull/`)

**Interfaces:**
- Produces (`sources/base.py`): exceptions `SourceError`, `SourceBlocked(SourceError)`, `ParserBroken`, `NovelNotFound`; frozen dataclasses `NovelSummary(url, title, author, cover_url, latest_chapter)`, `ChapterRef(index, title, url)`, `NovelInfo(source_novel_id, url, slug, title, author, cover_url, description, status)`, `TocPage(info, page, total_pages, chapters)`, `ChapterContent(title, text)`; `SourceAdapter` protocol with `id`, `matches(url) -> bool`, `search(query) -> list[NovelSummary]`, `toc_pages(url, start_page=1) -> Iterator[TocPage]`, `chapter(url) -> ChapterContent`. (`toc_pages` replaces the spec's `novel()`: pages are yielded one at a time so they can be stored progressively and `check_updates` can start at the last known page.)
- Produces (`sources/truyenfull_parse.py`): `TOC_PAGE_SIZE = 50`, `MIN_CHAPTER_CHARS = 500`, `parse_toc_page(html, page) -> TocPage`, `parse_chapter_page(html) -> ChapterContent`, `parse_search_page(html) -> list[NovelSummary]`, `strip_seo_tail(text) -> str`.
- Chapter text format (used by every later task): original display text, one paragraph per line, lines joined with `"\n"`, no empty lines, whitespace runs collapsed to one space, obfuscated words (`d.ư.ợ.c`) kept as-is.

- [ ] **Step 1: Add dependencies**

In `worker/pyproject.toml` replace the `[project]` table (everything above `[project.scripts]`) with:

```toml
[project]
name = "audiotruyen-worker"
version = "0.2.0"
description = "AudioTruyen v2 worker: scraping, analysis, TTS and uploads"
requires-python = ">=3.12,<3.13"
dependencies = [
  "boto3>=1.35",
  "httpx>=0.28",
  "pydantic>=2.9",
  "pydantic-settings>=2.6",
  "realtime>=2.32",
  "selectolax>=1.0.1",
  "supabase>=2.10",
  "vietnormalizer==0.2.3",
]
```

Run (from `worker/`): `uv lock && uv sync`
Expected: resolves and installs `selectolax`, `vietnormalizer`; `uv run python -c "from selectolax.lexbor import LexborHTMLParser; import vietnormalizer"` prints nothing.

- [ ] **Step 2: Write the failing test**

Create `worker/tests/test_truyenfull_parse.py`:

```python
from pathlib import Path

import pytest

from audiotruyen_worker.sources.base import ParserBroken
from audiotruyen_worker.sources.truyenfull_parse import (
    parse_chapter_page,
    parse_search_page,
    parse_toc_page,
    strip_seo_tail,
)

FIXTURES = Path(__file__).parent / "fixtures" / "truyenfull"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_novel_page_metadata_and_first_toc_page():
    page = parse_toc_page(fixture("novel_full_p1.html"), 1)
    info = page.info
    assert info.source_novel_id == "45719"
    assert info.slug == "thong-phong-cua-quyen-than-linh-lam"
    assert info.url == "https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/"
    assert info.title == "Thông Phòng Của Quyền Thần - Linh Lam"
    assert info.author == "Linh Lam"
    assert info.status == "completed"
    assert info.cover_url == "https://lh3.googleusercontent.com/d/1lCAoA-JMfaV1AaTQaVDEu4XJEP_Mv-Xk"
    assert info.description.startswith("[Quyền thần phong lưu nhưng độc ác")
    assert "truyenfull" not in info.description.lower()  # hidden SEO paragraphs dropped
    assert page.total_pages == 8
    assert len(page.chapters) == 50
    first, last = page.chapters[0], page.chapters[-1]
    assert (first.index, first.title) == (1, "Chương 1")
    assert first.url == "https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/chuong-1/"
    assert (last.index, last.title) == (50, "Chương 50")


def test_last_toc_page_indexes_continue_from_the_page_number():
    page = parse_toc_page(fixture("novel_full_p8.html"), 8)
    assert [c.index for c in page.chapters] == [351, 352, 353, 354]
    assert page.chapters[-1].title == "Chương 354: Hoàn chính văn"


def test_ongoing_status_and_titled_chapters():
    page = parse_toc_page(fixture("novel_ongoing.html"), 1)
    assert page.info.status == "ongoing"
    assert page.info.source_novel_id == "45842"
    assert page.total_pages == 3
    assert page.chapters[0].title == "Chương 1: Cô Là Giày Rách?"


def test_old_novel_page():
    page = parse_toc_page(fixture("novel_old_p1.html"), 1)
    assert (page.info.source_novel_id, page.info.title, page.info.author) == (
        "94",
        "Thế Giới Hoàn Mỹ",
        "Thần Đông",
    )
    assert page.total_pages == 41
    assert page.chapters[0].title == "Chương 1: Đại Hoang"


def test_index_is_toc_position_not_the_url_number():
    page = parse_toc_page(fixture("novel_single_page.html"), 1)
    assert page.total_pages == 1
    assert len(page.chapters) == 19
    assert page.chapters[0].url.endswith("/chuong-1-1/")
    assert (page.chapters[-1].index, page.chapters[-1].title) == (
        19,
        "Chương 17: Thuật phân thân ảnh",
    )


def test_short_middle_page_is_parser_broken():
    with pytest.raises(ParserBroken, match="expected 50"):
        parse_toc_page(fixture("novel_full_p8.html"), 7)


def test_missing_novel_markers_is_parser_broken():
    with pytest.raises(ParserBroken):
        parse_toc_page(fixture("search_results.html"), 1)


@pytest.mark.parametrize(
    ("name", "title", "head", "tail"),
    [
        (
            "chapter_new_2.html",
            "Chương 2",
            "Vì vậy nàng bắt đầu che giấu dung mạo",
            "Có trị tội nàng rình mò không?",
        ),
        (
            "chapter_new_354.html",
            "Chương 354: Hoàn chính văn",
            "Cố Lan Đình trơ mắt nhìn bóng dáng",
            "Ánh sáng trắng triệt để yên diệt.\nChính văn hoàn",
        ),
        (
            "chapter_old_1000.html",
            "Chương 1000: Bảo dịch phong ba",
            "Lôi Kiếp dịch ẩn chứa trong tiên trì này",
            "quả thật không hề thiếu cao thủ!",
        ),
    ],
)
def test_chapter_text(name, title, head, tail):
    content = parse_chapter_page(fixture(name))
    assert content.title == title
    assert content.text.startswith(head)
    assert content.text.endswith(tail)
    assert "truyenfull" not in content.text.lower()
    assert "\n\n" not in content.text  # one paragraph per line
    assert len(content.text) >= 500


def test_chapter_keeps_obfuscated_words_for_display():
    text = parse_chapter_page(fixture("chapter_new_2.html")).text
    assert "thảo d.ư.ợ.c" in text  # display text stays original; TTS normalizes later


def test_ads_are_removed_by_prefix_only():
    filler = "Một câu văn bình thường trong chương truyện. " * 15
    html = (
        '<a class="chapter-title">Chương 9</a><div id="chapter-c">'
        '<div id="ads-chapter-top">QUẢNG CÁO</div>'
        '<div class="text-center ads-holder">QUẢNG CÁO 2</div>'
        f'<p>{filler}<br><br><span class="roads">đường xa</span></p>'
        '<p style="display: none;visibility: hidden;">truyen full</p></div>'
    )
    text = parse_chapter_page(html).text
    assert "QUẢNG CÁO" not in text
    assert "đường xa" in text  # class "roads" contains "ads" but does not start with it


def test_chapter_without_body_is_parser_broken():
    with pytest.raises(ParserBroken, match="#chapter-c"):
        parse_chapter_page("<html><body><p>Không có nội dung</p></body></html>")


def test_short_chapter_with_title_is_parser_broken():
    html = '<a class="chapter-title">Chương 1</a><div id="chapter-c"><p>Quá ngắn.</p></div>'
    with pytest.raises(ParserBroken, match="characters"):
        parse_chapter_page(html)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Hết chương.\ntruyen full, truyenfull, truyenfullvn, truyenfulllive", "Hết chương."),
        ("Hết chương. Truyện Full truyenfull.live", "Hết chương."),
        ("Hắn thích đọc truyện full ở nhà.\nHết.", "Hắn thích đọc truyện full ở nhà.\nHết."),
        ("Cuối cùng là truyện full", "Cuối cùng là truyện full"),
    ],
)
def test_seo_tail_is_end_anchored_and_needs_two_keywords(raw, expected):
    assert strip_seo_tail(raw) == expected


def test_search_results():
    results = parse_search_page(fixture("search_results.html"))
    assert [r.title for r in results] == ["Tiên Nghịch Chi Hậu", "Tiên Nghịch Nhị Bản"]
    first = results[0]
    assert first.url == "https://truyenfull.live/tien-nghich-chi-hau/"
    assert first.author == "Trần Mộc"
    assert first.latest_chapter == "Chương 18"
    assert first.cover_url.startswith("https://static.truyenfull.live/cover/")


def test_search_first_page_and_empty_results():
    assert len(parse_search_page(fixture("search_paged.html"))) == 27
    assert parse_search_page(fixture("search_empty.html")) == []


def test_parser_budget():
    """Perf budget (7.3.2): parsing stays in single-digit milliseconds per page."""
    import time

    html = fixture("novel_full_p1.html")
    start = time.perf_counter()
    for _ in range(20):
        parse_toc_page(html, 1)
    assert (time.perf_counter() - start) / 20 < 0.05
```

- [ ] **Step 3: Run it to verify it fails**

Run: `uv run pytest tests/test_truyenfull_parse.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.sources'`.

- [ ] **Step 4: Write the implementation**

Create `worker/src/audiotruyen_worker/sources/__init__.py` (empty) and `worker/src/audiotruyen_worker/sources/base.py`:

```python
"""Source adapter contract (spec 5.2): data types, errors and the SourceAdapter protocol."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

NovelStatus = Literal["ongoing", "completed"]


class SourceError(Exception):
    """Transient source failure (network, 5xx, rate limit). The job may retry with backoff."""


class SourceBlocked(SourceError):
    """The source answered with an anti-bot challenge (Cloudflare). Never solved by the worker."""


class ParserBroken(Exception):
    """The page no longer matches the parser (markup change). Not retried."""


class NovelNotFound(Exception):
    """The novel does not exist or was removed (truyenfull redirects to its search page)."""


@dataclass(frozen=True)
class NovelSummary:
    url: str
    title: str
    author: str | None
    cover_url: str | None
    latest_chapter: str | None


@dataclass(frozen=True)
class ChapterRef:
    index: int  # 1-based position in the table of contents
    title: str
    url: str


@dataclass(frozen=True)
class NovelInfo:
    source_novel_id: str
    url: str  # canonical novel URL
    slug: str
    title: str
    author: str | None
    cover_url: str | None
    description: str | None
    status: NovelStatus | None


@dataclass(frozen=True)
class TocPage:
    info: NovelInfo
    page: int
    total_pages: int
    chapters: list[ChapterRef] = field(default_factory=list)


@dataclass(frozen=True)
class ChapterContent:
    title: str
    text: str  # original display text: one paragraph per line, joined with "\n"


class SourceAdapter(Protocol):
    id: str

    def matches(self, url: str) -> bool: ...

    def search(self, query: str) -> list[NovelSummary]: ...

    def toc_pages(self, url: str, start_page: int = 1) -> Iterator[TocPage]: ...

    def chapter(self, url: str) -> ChapterContent: ...
```

Create `worker/src/audiotruyen_worker/sources/truyenfull_parse.py`:

```python
"""Pure HTML parsers for truyenfull.live pages (no network). Fixtures: tests/fixtures/truyenfull."""

from __future__ import annotations

import re

from selectolax.lexbor import LexborHTMLParser, LexborNode

from audiotruyen_worker.sources.base import (
    ChapterContent,
    ChapterRef,
    NovelInfo,
    NovelSummary,
    ParserBroken,
    TocPage,
)

TOC_PAGE_SIZE = 50  # chapters per table-of-contents page (verified 2026-10-19)
MIN_CHAPTER_CHARS = 500

_NOISE_TAGS = {"script", "style", "noscript", "iframe"}
_STATUS = {"full": "completed", "đang ra": "ongoing"}
_WS = re.compile(r"[ \t\r\f\v\u00a0\u200b]+")
# Trailing SEO keyword block, e.g. "truyen full, truyenfull, truyenfullvn, truyenfulllive".
# Anchored to the end of the text and requires at least two keywords, so a sentence that merely
# mentions "truyện full" (anywhere, or once at the very end) is never removed.
_SEO_KEYWORD = r"truy[eệ]n\s*full(?:\s*(?:vn|live)|\.(?:vn|live)|vn|live)?"
_SEO_TAIL = re.compile(
    rf"\s*\b{_SEO_KEYWORD}\b(?:[\s,.;:|/-]+{_SEO_KEYWORD}\b)+[\s,.;:|/-]*\Z", re.IGNORECASE
)


def _text(node: LexborNode | None) -> str | None:
    if node is None:
        return None
    value = _WS.sub(" ", node.text(deep=True, separator="", strip=False)).strip()
    return value or None


def _is_hidden(node: LexborNode) -> bool:
    style = (node.attributes.get("style") or "").replace(" ", "").lower()
    return "display:none" in style


def _is_ad(node: LexborNode) -> bool:
    ident = node.attributes.get("id") or ""
    classes = (node.attributes.get("class") or "").split()
    return ident.startswith("ads") or any(c.startswith("ads") for c in classes)


def _drop_noise(root: LexborNode) -> None:
    """Remove ads (id/class prefix "ads", never a substring match) and hidden elements.

    Walks top-down and never visits the children of a removed node.
    """
    stack = [root]
    while stack:
        node = stack.pop()
        for child in list(node.iter(include_text=False)):
            if child.tag in _NOISE_TAGS or _is_ad(child) or _is_hidden(child):
                child.decompose()
            else:
                stack.append(child)


def _block_text(root: LexborNode) -> str:
    """Flatten an element into paragraphs: <br>, <p> and <div> boundaries become line breaks."""
    html = root.html or ""
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    html = re.sub(r"</?(?:p|div)\b[^>]*>", "\n", html, flags=re.IGNORECASE)
    text = LexborHTMLParser(f"<body>{html}</body>").body.text(deep=True, separator="", strip=False)
    lines = (_WS.sub(" ", line).strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line)


def strip_seo_tail(text: str) -> str:
    return _SEO_TAIL.sub("", text).rstrip()


def _input_value(tree: LexborHTMLParser, ident: str) -> str | None:
    node = tree.css_first(f"input#{ident}")
    return (node.attributes.get("value") or None) if node else None


def parse_toc_page(html: str, page: int) -> TocPage:
    tree = LexborHTMLParser(html)
    novel_id = _input_value(tree, "truyen-id")
    slug = _input_value(tree, "truyen-ascii")
    title = _text(tree.css_first('h3.title[itemprop="name"]'))
    if not (novel_id and slug and title):
        raise ParserBroken("novel page: missing truyen-id, truyen-ascii or title")
    total_raw = _input_value(tree, "total-page") or "1"
    if not total_raw.isdigit() or int(total_raw) < 1:
        raise ParserBroken(f"novel page: bad total-page {total_raw!r}")
    total_pages = int(total_raw)

    status_node = tree.css_first(".info span.text-success, .info span.text-primary")
    status = _STATUS.get((_text(status_node) or "").lower())
    cover = tree.css_first(".info-holder .book img")
    desc = tree.css_first(".desc-text")
    description = None
    if desc is not None:
        _drop_noise(desc)
        description = _block_text(desc) or None

    info = NovelInfo(
        source_novel_id=novel_id,
        url=f"https://truyenfull.live/{slug}/",
        slug=slug,
        title=title,
        author=_text(tree.css_first('.info a[itemprop="author"]')),
        cover_url=cover.attributes.get("src") if cover else None,
        description=description,
        status=status,  # type: ignore[arg-type]
    )

    links = tree.css("#list-chapter ul.list-chapter li a")
    first_index = (page - 1) * TOC_PAGE_SIZE + 1
    chapters = []
    for offset, link in enumerate(links):
        href = link.attributes.get("href") or ""
        chapter_title = _text(link)
        if not href.startswith("https://truyenfull.live/") or not chapter_title:
            raise ParserBroken(f"toc page {page}: bad chapter link {href!r}")
        chapters.append(ChapterRef(index=first_index + offset, title=chapter_title, url=href))
    if not chapters:
        raise ParserBroken(f"toc page {page}: no chapters")
    if page < total_pages and len(chapters) != TOC_PAGE_SIZE:
        raise ParserBroken(f"toc page {page}: {len(chapters)} chapters, expected {TOC_PAGE_SIZE}")
    return TocPage(info=info, page=page, total_pages=total_pages, chapters=chapters)


def parse_chapter_page(html: str) -> ChapterContent:
    tree = LexborHTMLParser(html)
    title = _text(tree.css_first("a.chapter-title"))
    body = tree.css_first("#chapter-c")
    if body is None:
        raise ParserBroken("chapter page: #chapter-c not found")
    _drop_noise(body)
    text = strip_seo_tail(_block_text(body))
    if title and len(text) < MIN_CHAPTER_CHARS:
        raise ParserBroken(f"chapter page: only {len(text)} characters of text")
    if not text:
        raise ParserBroken("chapter page: empty text")
    return ChapterContent(title=title or "", text=text)


def parse_search_page(html: str) -> list[NovelSummary]:
    tree = LexborHTMLParser(html)
    results = []
    for row in tree.css("#list-page div.row[itemtype]"):
        link = row.css_first("h3.truyen-title a")
        if link is None:
            continue
        cover = row.css_first("[data-image]")
        latest = row.css_first(".text-info a")
        results.append(
            NovelSummary(
                url=link.attributes.get("href") or "",
                title=_text(link) or "",
                author=_text(row.css_first(".author")),
                cover_url=cover.attributes.get("data-image") if cover else None,
                latest_chapter=_text(latest),
            )
        )
    return results
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_truyenfull_parse.py -q`
Expected: PASS (21 tests).

- [ ] **Step 6: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add pyproject.toml uv.lock src/audiotruyen_worker/sources tests/test_truyenfull_parse.py
git commit -m "feat(worker): truyenfull parsers on recorded fixtures (spec 2.1, 5.2)"
```

---

### Task 3: Polite HTTP client and the truyenfull adapter

**Files:**
- Create: `worker/src/audiotruyen_worker/sources/http.py`, `worker/src/audiotruyen_worker/sources/truyenfull.py`
- Test: `worker/tests/test_truyenfull_adapter.py`

**Interfaces:**
- Consumes: Task 2 types and parsers.
- Produces: `PoliteClient(*, allowed_hosts, transport=None, base_interval=0.7, jitter=(0.3, 0.8), max_retries=3, timeout=20.0, clock=time.monotonic, sleep=time.sleep, rng=random.uniform)` with `get_text(url) -> str` and `close()`; `is_challenge(response) -> bool`; `HOSTS`; `novel_slug(url) -> str` (raises `ValueError`); `TruyenfullAdapter(client=None)` implementing `SourceAdapter` (`id = "truyenfull"`).
- Behaviour: spacing between request starts = `base_interval + rng(*jitter)` (1.0-1.5 s by default); retries timeouts, transport errors, 429 and 5xx with backoff `2^attempt` s (`Retry-After` honoured, capped at 60 s); a challenge raises `SourceBlocked` immediately (no retry); a redirect to `/tim-kiem` or a 404 raises `NovelNotFound`; redirects are followed only to allowed hosts (max 3); any other non-200 raises `SourceError`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_truyenfull_adapter.py`:

```python
from pathlib import Path

import httpx
import pytest

from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError
from audiotruyen_worker.sources.http import PoliteClient
from audiotruyen_worker.sources.truyenfull import HOSTS, TruyenfullAdapter, novel_slug

FIXTURES = Path(__file__).parent / "fixtures" / "truyenfull"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_client(handler, clock: FakeClock | None = None, **kwargs) -> PoliteClient:
    clock = clock or FakeClock()
    return PoliteClient(
        allowed_hosts=HOSTS,
        transport=httpx.MockTransport(handler),
        clock=clock,
        sleep=clock.sleep,
        rng=lambda lo, hi: lo,
        **kwargs,
    )


def test_requests_are_spaced_by_interval_plus_jitter():
    clock = FakeClock()
    client = make_client(lambda request: httpx.Response(200, text="ok"), clock)
    for _ in range(3):
        client.get_text("https://truyenfull.live/a/")
    assert clock.sleeps == [pytest.approx(1.0), pytest.approx(1.0)]


def test_challenge_raises_source_blocked_without_retry():
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(
            403, headers={"cf-mitigated": "challenge"}, text=fixture("challenge_403.html")
        )

    with pytest.raises(SourceBlocked):
        make_client(handler).get_text("https://truyenfull.live/x-free/")
    assert len(calls) == 1


def test_challenge_detected_from_body_without_header():
    handler = lambda request: httpx.Response(403, text=fixture("challenge_403.html"))  # noqa: E731
    with pytest.raises(SourceBlocked):
        make_client(handler).get_text("https://truyenfull.live/x-free/")


def test_normal_page_with_turnstile_widget_is_not_a_challenge():
    html = fixture("chapter_new_2.html")
    assert "cf-turnstile" in html
    client = make_client(lambda request: httpx.Response(200, text=html))
    assert client.get_text("https://truyenfull.live/a/chuong-2/") == html


def test_5xx_is_retried_with_backoff_then_succeeds():
    clock = FakeClock()
    responses = iter(
        [httpx.Response(502), httpx.Response(503, text="busy"), httpx.Response(200, text="ok")]
    )
    client = make_client(lambda request: next(responses), clock)
    assert client.get_text("https://truyenfull.live/a/") == "ok"
    assert 2.0 in clock.sleeps and 4.0 in clock.sleeps


def test_retry_after_is_honoured_and_capped():
    clock = FakeClock()
    responses = iter(
        [httpx.Response(429, headers={"retry-after": "120"}), httpx.Response(200, text="ok")]
    )
    make_client(lambda request: next(responses), clock).get_text("https://truyenfull.live/a/")
    assert 60.0 in clock.sleeps


def test_gives_up_after_max_retries():
    client = make_client(lambda request: httpx.Response(500), max_retries=2)
    with pytest.raises(SourceError, match="HTTP 500"):
        client.get_text("https://truyenfull.live/a/")


def test_timeouts_are_retried():
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) < 3:
            raise httpx.ConnectTimeout("slow")
        return httpx.Response(200, text="ok")

    assert make_client(handler).get_text("https://truyenfull.live/a/") == "ok"
    assert len(attempts) == 3


def test_redirect_to_search_means_novel_removed():
    def handler(request):
        return httpx.Response(
            301, headers={"location": "https://truyenfull.live/tim-kiem/?tukhoa=tien-nghich"}
        )

    with pytest.raises(NovelNotFound):
        make_client(handler).get_text("https://truyenfull.live/tien-nghich/")


def test_redirect_within_site_is_followed():
    def handler(request):
        if request.url.path == "/old/":
            return httpx.Response(301, headers={"location": "/new/"})
        return httpx.Response(200, text="moved")

    assert make_client(handler).get_text("https://truyenfull.live/old/") == "moved"


def test_redirect_to_other_host_is_refused():
    handler = lambda request: httpx.Response(302, headers={"location": "https://evil.example/"})  # noqa: E731
    with pytest.raises(SourceError, match="refusing"):
        make_client(handler).get_text("https://truyenfull.live/a/")


def test_other_hosts_are_refused_before_any_request():
    calls = []
    client = make_client(lambda request: calls.append(1) or httpx.Response(200))
    with pytest.raises(SourceError):
        client.get_text("https://example.com/")
    assert calls == []


@pytest.mark.parametrize(
    ("url", "slug"),
    [
        ("https://truyenfull.live/the-gioi-hoan-my/", "the-gioi-hoan-my"),
        ("https://truyenfull.live/the-gioi-hoan-my/chuong-1000/", "the-gioi-hoan-my"),
        ("https://www.truyenfull.live/the-gioi-hoan-my", "the-gioi-hoan-my"),
    ],
)
def test_novel_slug(url, slug):
    assert novel_slug(url) == slug


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/a/",
        "https://truyenfull.live/",
        "https://truyenfull.live/tim-kiem/?tukhoa=a",
    ],
)
def test_matches_rejects_non_novel_urls(url):
    assert TruyenfullAdapter(make_client(lambda r: httpx.Response(200))).matches(url) is False


def _site(routes: dict[str, tuple[int, str]]):
    seen: list[str] = []

    def handler(request):
        key = request.url.path + (f"?{request.url.query.decode()}" if request.url.query else "")
        seen.append(key)
        status, name = routes[key]
        return httpx.Response(status, text=fixture(name))

    return handler, seen


def test_toc_pages_walks_from_start_page_to_last():
    pages = {
        f"/thong-phong-cua-quyen-than-linh-lam/trang-{n}/": (200, "novel_full_p8.html")
        for n in (7, 8)
    }
    handler, seen = _site(pages)
    # page 7 is served with the page-8 fixture, which is a short page: page 7 of 8 must be full
    adapter = TruyenfullAdapter(make_client(handler))
    with pytest.raises(ParserBroken):
        list(adapter.toc_pages("https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/", 7))
    assert seen == ["/thong-phong-cua-quyen-than-linh-lam/trang-7/"]


def test_toc_pages_single_page_novel():
    handler, seen = _site({"/bao-long-than-tham/": (200, "novel_single_page.html")})
    pages = list(
        TruyenfullAdapter(make_client(handler)).toc_pages(
            "https://truyenfull.live/bao-long-than-tham/chuong-3/"
        )
    )
    assert [p.page for p in pages] == [1]
    assert len(pages[0].chapters) == 19
    assert seen == ["/bao-long-than-tham/"]


def test_toc_pages_last_page_only():
    handler, seen = _site(
        {"/thong-phong-cua-quyen-than-linh-lam/trang-8/": (200, "novel_full_p8.html")}
    )
    pages = list(
        TruyenfullAdapter(make_client(handler)).toc_pages(
            "https://truyenfull.live/thong-phong-cua-quyen-than-linh-lam/", 8
        )
    )
    assert [c.index for c in pages[0].chapters] == [351, 352, 353, 354]


def test_search_and_chapter():
    handler, seen = _site(
        {
            "/tim-kiem/?tukhoa=ti%C3%AAn+ngh%E1%BB%8Bch": (200, "search_results.html"),
            "/the-gioi-hoan-my/chuong-1000/": (200, "chapter_old_1000.html"),
        }
    )
    adapter = TruyenfullAdapter(make_client(handler))
    assert [r.title for r in adapter.search("  tiên nghịch ")] == [
        "Tiên Nghịch Chi Hậu",
        "Tiên Nghịch Nhị Bản",
    ]
    assert (
        adapter.chapter("https://truyenfull.live/the-gioi-hoan-my/chuong-1000/").title
        == "Chương 1000: Bảo dịch phong ba"
    )
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_truyenfull_adapter.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.sources.http'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/sources/http.py`:

```python
"""Polite HTTP client for scraping: request spacing with jitter, retries, challenge detection."""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

import httpx

from audiotruyen_worker.sources.base import NovelNotFound, SourceBlocked, SourceError

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
_CHALLENGE_MARKERS = ("<title>Just a moment...</title>", "challenge-platform", "_cf_chl_opt")
_RETRY_STATUS = {429, 500, 502, 503, 504}
_MAX_REDIRECTS = 3


def is_challenge(response: httpx.Response) -> bool:
    """Cloudflare managed challenge. Normal pages embed a Turnstile comment widget, so
    `cf-turnstile` alone is not a challenge marker; only challenge responses carry these."""
    if response.headers.get("cf-mitigated", "").lower() == "challenge":
        return True
    if response.status_code in (403, 503):
        body = response.text
        return any(marker in body for marker in _CHALLENGE_MARKERS)
    return False


class PoliteClient:
    """GET-only client. Spacing between request starts: base_interval + uniform(jitter)
    (default 0.7 s + 0.3-0.8 s = 1.0-1.5 s, about 1 request/s). Retries timeouts, transport
    errors, 429 and 5xx with exponential backoff (honours Retry-After up to 60 s)."""

    def __init__(
        self,
        *,
        allowed_hosts: frozenset[str],
        transport: httpx.BaseTransport | None = None,
        base_interval: float = 0.7,
        jitter: tuple[float, float] = (0.3, 0.8),
        max_retries: int = 3,
        timeout: float = 20.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        rng: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "vi,en;q=0.8"},
            timeout=timeout,
            follow_redirects=False,
            transport=transport,
        )
        self._allowed_hosts = allowed_hosts
        self._base_interval = base_interval
        self._jitter = jitter
        self._max_retries = max_retries
        self._clock = clock
        self._sleep = sleep
        self._rng = rng
        self._next_at = 0.0

    def close(self) -> None:
        self._client.close()

    def _wait_turn(self) -> None:
        now = self._clock()
        if now < self._next_at:
            self._sleep(self._next_at - now)
        self._next_at = self._clock() + self._base_interval + self._rng(*self._jitter)

    def _check_host(self, url: str) -> None:
        host = (urlsplit(url).hostname or "").lower()
        if host not in self._allowed_hosts:
            raise SourceError(f"refusing to fetch host {host!r}")

    def get_text(self, url: str) -> str:
        """Return the body of a 200 response. Raises NovelNotFound when the site redirects to
        its search page, SourceBlocked on a challenge, SourceError after retries."""
        self._check_host(url)
        for _ in range(_MAX_REDIRECTS + 1):
            response = self._get_with_retries(url)
            if response.is_redirect:
                target = urljoin(url, response.headers.get("location", ""))
                if urlsplit(target).path.startswith("/tim-kiem"):
                    raise NovelNotFound(url)
                self._check_host(target)
                url = target
                continue
            if response.status_code == 404:
                raise NovelNotFound(url)
            if response.status_code != 200:
                raise SourceError(f"HTTP {response.status_code} for {url}")
            return response.text
        raise SourceError(f"too many redirects for {url}")

    def _get_with_retries(self, url: str) -> httpx.Response:
        attempt = 0
        while True:
            self._wait_turn()
            try:
                response = self._client.get(url)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                error: Exception = exc
                retry_after = None
            else:
                if is_challenge(response):
                    raise SourceBlocked(f"Cloudflare challenge for {url}")
                if response.status_code not in _RETRY_STATUS:
                    return response
                error = SourceError(f"HTTP {response.status_code} for {url}")
                retry_after = _retry_after(response)
            attempt += 1
            if attempt > self._max_retries:
                raise SourceError(str(error)) from error
            self._sleep(retry_after if retry_after is not None else 2.0**attempt)


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after", "")
    return min(float(raw), 60.0) if raw.isdigit() else None
```

Create `worker/src/audiotruyen_worker/sources/truyenfull.py`:

```python
"""truyenfull.live adapter (spec 2.1, 5.2)."""

from __future__ import annotations

import re
from collections.abc import Iterator
from urllib.parse import quote_plus, urlsplit

from audiotruyen_worker.sources.base import ChapterContent, NovelSummary, TocPage
from audiotruyen_worker.sources.http import PoliteClient
from audiotruyen_worker.sources.truyenfull_parse import (
    parse_chapter_page,
    parse_search_page,
    parse_toc_page,
)

BASE = "https://truyenfull.live"
HOSTS = frozenset({"truyenfull.live", "www.truyenfull.live"})
_SLUG = re.compile(r"^[a-z0-9-]+$")


def novel_slug(url: str) -> str:
    """First path segment of a truyenfull novel or chapter URL."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() not in HOSTS:
        raise ValueError(f"not a truyenfull URL: {url}")
    segments = [s for s in parts.path.split("/") if s]
    if not segments or not _SLUG.match(segments[0]) or segments[0] in {"tim-kiem", "danh-sach"}:
        raise ValueError(f"not a truyenfull novel URL: {url}")
    return segments[0]


class TruyenfullAdapter:
    id = "truyenfull"

    def __init__(self, client: PoliteClient | None = None) -> None:
        self._client = client or PoliteClient(allowed_hosts=HOSTS)

    def matches(self, url: str) -> bool:
        try:
            novel_slug(url)
        except ValueError:
            return False
        return True

    def search(self, query: str) -> list[NovelSummary]:
        html = self._client.get_text(f"{BASE}/tim-kiem/?tukhoa={quote_plus(query.strip())}")
        return parse_search_page(html)

    def toc_pages(self, url: str, start_page: int = 1) -> Iterator[TocPage]:
        """Yield table-of-contents pages from start_page to the last one, one request each.
        start_page lets check_updates read only the pages that can hold new chapters."""
        slug = novel_slug(url)
        page = max(1, start_page)
        while True:
            page_url = f"{BASE}/{slug}/" if page == 1 else f"{BASE}/{slug}/trang-{page}/"
            toc = parse_toc_page(self._client.get_text(page_url), page)
            yield toc
            if page >= toc.total_pages:
                return
            page += 1

    def chapter(self, url: str) -> ChapterContent:
        novel_slug(url)  # validates host and shape
        return parse_chapter_page(self._client.get_text(url))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_truyenfull_adapter.py tests/test_truyenfull_parse.py -q`
Expected: PASS (22 + 21 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/sources tests/test_truyenfull_adapter.py
git commit -m "feat(worker): polite HTTP client and truyenfull adapter (spec 5.2, 7.2)"
```

---

### Task 4: TTS text normalization

**Files:**
- Create: `worker/src/audiotruyen_worker/text/__init__.py` (empty), `worker/src/audiotruyen_worker/text/normalize.py`
- Create: `worker/src/audiotruyen_worker/text/data/vietnormalizer_empty.csv` (an **empty** file, 0 bytes; passed to vietnormalizer to switch off its built-in dictionaries)
- Test: `worker/tests/test_normalize.py`

**Interfaces:**
- Produces: `deobfuscate(text) -> str`, `uncensor(text) -> str`, `CENSORED: dict[str, str]`, `LexiconRule(pattern, replacement, is_regex=False)`, `apply_lexicon(text, rules) -> str`, `normalize_for_tts(text, rules=()) -> str`.
- Order inside `normalize_for_tts`: NFC → `deobfuscate` → `uncensor` → `apply_lexicon` → vietnormalizer (numbers, dates, money, units; lowercases and drops quote marks). Lexicon runs before vietnormalizer so owner patterns match the displayed text (spec 5.3 updated in Task 10). Display text is never normalized; Task 5 cuts segments from the original text and later stages normalize each segment.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_normalize.py`:

```python
import pytest

from audiotruyen_worker.text.normalize import (
    LexiconRule,
    apply_lexicon,
    deobfuscate,
    normalize_for_tts,
    uncensor,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("thảo d.ư.ợ.c", "thảo dược"),
        ("b.út kẻ", "bút kẻ"),
        ("c.h.ử.i ầm lên.", "chửi ầm lên."),
        ("C.h.ế.t đi", "Chết đi"),
        ("ch.ết", "chết"),
        ("công t.ử", "công tử"),
        ("l.ồ.ng n.g.ự.c", "lồng ngực"),
        ("v.v.", "v.v."),
        ("TP.HCM", "TP.HCM"),
        ("nói.Ai", "nói.Ai"),
        ("là.ta", "là.ta"),
        ("đi.về", "đi.về"),
        ("A.B", "A.B"),
        ("1.000.000 đồng", "1.000.000 đồng"),
    ],
)
def test_deobfuscate(raw, expected):
    assert deobfuscate(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ai g**t ch*t lão", "ai giết chết lão"),
        ("G**t hắn", "Giết hắn"),
        ("đồ đ**m kia", "đồ kia"),
        ("không có sao", "không có sao"),
    ],
)
def test_uncensor(raw, expected):
    assert uncensor(raw) == expected


def test_lexicon_plain_rules_are_whole_word_and_ordered():
    rules = [LexiconRule("Hạo", "Hạo Thiên"), LexiconRule("Hạo Thiên", "Hạo Thiên Đế")]
    assert apply_lexicon("Hạo đến, Hạo Nhi đi", rules) == "Hạo Thiên Đế đến, Hạo Thiên Đế Nhi đi"


def test_lexicon_regex_rule_and_invalid_regex_is_skipped():
    rules = [
        LexiconRule("(", "x", is_regex=True),
        LexiconRule(r"(\d+)\s*lượng", r"\1 lạng", is_regex=True),
    ]
    assert apply_lexicon("trả 5 lượng", rules) == "trả 5 lạng"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "Ta cũng chỉ nghe nói, kia là Xích Viêm Long.",
            "ta cũng chỉ nghe nói, kia là xích viêm long.",
        ),
        ("Năm 1999, hắn 18 tuổi.", "năm một nghìn chín trăm chín mươi chín, hắn mười tám tuổi."),
        ("Trả 50.000đ, cách 3km.", "trả năm mươi nghìn đồng, cách ba ki-lô-mét."),
        ("“Thảo d.ư.ợ.c, g**t hắn!”", "thảo dược, giết hắn!"),
    ],
)
def test_normalize_for_tts(raw, expected):
    assert normalize_for_tts(raw) == expected
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_normalize.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.text'`.

- [ ] **Step 3: Write the implementation**

Create the empty data file (Git Bash, from `worker/`): `mkdir -p src/audiotruyen_worker/text/data && : > src/audiotruyen_worker/text/data/vietnormalizer_empty.csv`

Create `worker/src/audiotruyen_worker/text/__init__.py` (empty) and `worker/src/audiotruyen_worker/text/normalize.py`:

```python
"""TTS input normalization (spec 5.3 step 1). Display text is never changed; segments are cut
from the original text first and each segment's text is normalized here for synthesis."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

_LETTER = r"[^\W\d_]"
# Letter groups of 1-2 letters separated by single dots: "c.h.ử.i", "d.ư.ợ.c", "b.út", "ch.ết".
_DOTTED = re.compile(rf"(?<![\w.])({_LETTER}{{1,2}}(?:\.{_LETTER}{{1,2}})+)(?![\w]|\.\w)")
# Words censored with asterisks, e.g. "g**t ch*t".
_ASTERISK_WORD = re.compile(rf"(?<!\w){_LETTER}*\*+{_LETTER}*(?:\*+{_LETTER}*)*(?!\w)")
CENSORED = {"g**t": "giết", "g*t": "giết", "ch*t": "chết", "ch**t": "chết"}


def _has_vowel(part: str) -> bool:
    base = unicodedata.normalize("NFD", part.lower())
    return any(ch in "aeiouy" for ch in base)


def _join_dotted(match: re.Match[str]) -> str:
    token = match.group(1)
    parts = token.split(".")
    if any(p[1:] != p[1:].lower() for p in parts) or any(p[:1].isupper() for p in parts[1:]):
        return token  # "TP.HCM", "là.Ta": abbreviations or a missing space after a period
    if len(parts) == 2 and _has_vowel(parts[0]):
        return token  # "v.v", "A.B", "là.ta", "đi.về": not one obfuscated word
    joined = "".join(parts)
    return joined if _has_vowel(joined) else token


def deobfuscate(text: str) -> str:
    """'c.h.ử.i' -> 'chửi', 'b.út' -> 'bút'; leaves 'v.v.', 'TP.HCM' and 'là.Ta' alone."""
    return _DOTTED.sub(_join_dotted, text)


def uncensor(text: str) -> str:
    """Restore known asterisk-censored words; drop unknown ones (never read them as noise)."""

    def repl(match: re.Match[str]) -> str:
        word = match.group(0)
        known = CENSORED.get(word.lower())
        if known is None:
            return ""
        return known.capitalize() if word[:1].isupper() else known

    return re.sub(r"[ \t]{2,}", " ", _ASTERISK_WORD.sub(repl, text))


@dataclass(frozen=True)
class LexiconRule:
    pattern: str
    replacement: str
    is_regex: bool = False


def apply_lexicon(text: str, rules: Sequence[LexiconRule]) -> str:
    """Rules apply in the given order (global by position, then novel-level). Plain rules are
    case-sensitive whole-word replacements; regex rules use Python `re` syntax. Invalid regex
    rules are skipped."""
    for rule in rules:
        if rule.is_regex:
            try:
                text = re.sub(rule.pattern, rule.replacement, text)
            except re.error:
                continue
        elif rule.pattern:
            text = re.sub(
                rf"(?<!\w){re.escape(rule.pattern)}(?!\w)", lambda _m, r=rule: r.replacement, text
            )
    return text


_EMPTY_DICT = str(Path(__file__).parent / "data" / "vietnormalizer_empty.csv")


@lru_cache(maxsize=1)
def _vietnormalizer():
    from vietnormalizer import VietnameseNormalizer

    # Its built-in "non-Vietnamese words" dictionary and transliteration rewrite common
    # Vietnamese words ("nghe" -> "nghê", "long" -> "lon", "kia" -> "ki-a"), so both are off and
    # only the number/date/unit rules are used.
    return VietnameseNormalizer(
        non_vietnamese_words_path=_EMPTY_DICT,
        acronyms_path=_EMPTY_DICT,
        enable_transliteration=False,
    )


def normalize_for_tts(text: str, rules: Sequence[LexiconRule] = ()) -> str:
    """NFC -> de-obfuscate -> uncensor -> lexicon -> vietnormalizer (numbers, dates, units,
    abbreviations; lowercases and drops quote marks)."""
    text = unicodedata.normalize("NFC", text)
    text = uncensor(deobfuscate(text))
    text = apply_lexicon(text, rules)
    return _vietnormalizer().normalize(text).strip()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_normalize.py -q`
Expected: PASS (24 tests). If `test_normalize_for_tts` shows `nghê`, `lon` or `ki-a`, the empty dictionary file is missing or not empty.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/text tests/test_normalize.py
git commit -m "feat(worker): TTS normalization with de-obfuscation and lexicon (spec 5.3)"
```

---

### Task 5: Segmentation

**Files:**
- Create: `worker/src/audiotruyen_worker/text/segment.py`
- Test: `worker/tests/test_segment.py`

**Interfaces:**
- Consumes: chapter text format from Task 2.
- Produces: `MAX_CHARS = 250`; frozen dataclass `Segment(i, kind, start, end, text, paragraph, paragraph_end)` where `kind` is `"narration" | "dialogue"`, `start`/`end` are offsets into the ORIGINAL chapter text and `text == original[start:end]`; `segment_text(text) -> list[Segment]` (ids `i` are `0..n-1` in reading order).
- Rules: a paragraph is one line; dialogue is `“…”`, `"…"`, `«…»` (unclosed quote runs to the end of the paragraph; nested `‘…’` stays inside) or a line starting with `-`, `–`, `—` (speech runs to the next spaced dash, the rest is narration); pieces over 250 characters are cut at the last sentence end, else the last clause end (`, ; :`), else the last space, else hard at 250; whitespace is trimmed; pieces without a word character are dropped.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_segment.py`:

```python
from pathlib import Path

from audiotruyen_worker.sources.truyenfull_parse import parse_chapter_page
from audiotruyen_worker.text.segment import MAX_CHARS, segment_text

FIXTURES = Path(__file__).parent / "fixtures" / "truyenfull"


def test_segments_map_back_to_the_original_text():
    text = parse_chapter_page((FIXTURES / "chapter_new_354.html").read_text(encoding="utf-8")).text
    segments = segment_text(text)
    assert segments, "no segments"
    assert [s.i for s in segments] == list(range(len(segments)))
    for s in segments:
        assert text[s.start : s.end] == s.text
        assert len(s.text) <= MAX_CHARS
    starts = [s.start for s in segments]
    assert starts == sorted(starts)


def test_quoted_dialogue_and_narration_in_one_paragraph():
    text = "Hứa Niết nói:\n“Ta không buông.” Hắn gầm lên giận dữ. “Buông ra!”"
    segs = segment_text(text)
    assert [(s.kind, s.text) for s in segs] == [
        ("narration", "Hứa Niết nói:"),
        ("dialogue", "“Ta không buông.”"),
        ("narration", "Hắn gầm lên giận dữ."),
        ("dialogue", "“Buông ra!”"),
    ]
    assert [s.paragraph for s in segs] == [0, 1, 1, 1]
    assert [s.paragraph_end for s in segs] == [True, False, False, True]


def test_straight_quotes_nested_single_quotes_and_unclosed_quote():
    segs = segment_text('Hắn nói: "Nàng bảo ‘đi đi’ rồi." Rồi im lặng.\n"Chưa xong')
    assert [(s.kind, s.text) for s in segs] == [
        ("narration", "Hắn nói:"),
        ("dialogue", '"Nàng bảo ‘đi đi’ rồi."'),
        ("narration", "Rồi im lặng."),
        ("dialogue", '"Chưa xong'),
    ]


def test_dash_led_dialogue():
    segs = segment_text("- Ngươi muốn chết sao? - Lâm Phong quát.\n– Không dám.")
    assert [(s.kind, s.text) for s in segs] == [
        ("dialogue", "- Ngươi muốn chết sao?"),
        ("narration", "- Lâm Phong quát."),
        ("dialogue", "– Không dám."),
    ]


def test_long_paragraph_is_split_at_sentence_ends():
    sentence = "Hắn đi qua cánh rừng già rậm rạp, nghe tiếng gió thổi qua những tán lá cao vút. "
    text = (sentence * 8).strip()
    segs = segment_text(text)
    assert len(segs) > 1
    assert all(len(s.text) <= MAX_CHARS for s in segs)
    assert all(s.text.endswith(".") for s in segs)
    assert "".join(text[s.start : s.end] for s in segs).replace(" ", "") == text.replace(" ", "")


def test_sentence_longer_than_limit_is_cut_at_clause_or_space():
    text = ", ".join(["một đoạn văn rất dài không có dấu chấm"] * 12)
    segs = segment_text(text)
    assert len(segs) > 1 and all(len(s.text) <= MAX_CHARS for s in segs)


def test_punctuation_only_pieces_are_dropped():
    segs = segment_text("“Ừ.” ,\n...")
    assert [s.text for s in segs] == ["“Ừ.”"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_segment.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.text.segment'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/text/segment.py`:

```python
"""Segmentation (spec 5.3 step 2): paragraphs -> dialogue/narration pieces -> pieces of at most
MAX_CHARS split at sentence boundaries. Offsets index the ORIGINAL chapter text."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

MAX_CHARS = 250
Kind = Literal["narration", "dialogue"]

_DASHES = "-–—"
_QUOTE_PAIRS = {"“": "”", '"': '"', "«": "»"}
_SENTENCE_END = re.compile(r"[.!?…]+[\"”’»)\]]*\s+")
_CLAUSE_END = re.compile(r"[,;:]\s+")
_HAS_WORD = re.compile(r"\w")


@dataclass(frozen=True)
class Segment:
    i: int
    kind: Kind
    start: int  # inclusive offset in the original text
    end: int  # exclusive offset
    text: str  # original[start:end]
    paragraph: int
    paragraph_end: bool  # last segment of its paragraph (longer pause)


def _paragraphs(text: str) -> list[tuple[int, int]]:
    spans, pos = [], 0
    for line in text.split("\n"):
        start, end = pos, pos + len(line)
        pos = end + 1
        lead = len(line) - len(line.lstrip())
        trail = len(line.rstrip())
        if trail > lead:
            spans.append((start + lead, start + trail))
    return spans


def _dialogue_spans(text: str, start: int, end: int) -> list[tuple[int, int, Kind]]:
    """Split one paragraph into (start, end, kind) pieces covering it in order."""
    if text[start] in _DASHES:
        # Dash-led dialogue: "- Lời thoại - hắn nói." The speech runs to the next spaced dash.
        sep = re.compile(r"\s[" + _DASHES + r"]\s")
        match = sep.search(text, start + 1, end)
        if match is None:
            return [(start, end, "dialogue")]
        return [(start, match.start(), "dialogue"), (match.start(), end, "narration")]

    pieces: list[tuple[int, int, Kind]] = []
    pos = cursor = start
    while pos < end:
        ch = text[pos]
        closer = _QUOTE_PAIRS.get(ch)
        if closer is None:
            pos += 1
            continue
        close = text.find(closer, pos + 1, end)
        stop = end if close == -1 else close + 1
        if pos > cursor:
            pieces.append((cursor, pos, "narration"))
        pieces.append((pos, stop, "dialogue"))
        cursor = pos = stop
    if cursor < end:
        pieces.append((cursor, end, "narration"))
    return pieces


def _last_boundary(pattern: re.Pattern[str], text: str, start: int, limit: int) -> int | None:
    last = None
    for match in pattern.finditer(text, start, limit + 1):
        if start < match.end() <= limit:
            last = match.end()
    return last


def _split_long(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Greedy: cut at the last sentence end within MAX_CHARS, else the last clause end, else
    the last space, else hard at MAX_CHARS."""
    out: list[tuple[int, int]] = []
    while end - start > MAX_CHARS:
        limit = start + MAX_CHARS
        cut = _last_boundary(_SENTENCE_END, text, start, limit)
        if cut is None:
            cut = _last_boundary(_CLAUSE_END, text, start, limit)
        if cut is None:
            space = text.rfind(" ", start + 1, limit)
            cut = space if space > start else limit
        out.append((start, cut))
        start = cut
    out.append((start, end))
    return out


def _trim(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def segment_text(text: str) -> list[Segment]:
    segments: list[Segment] = []
    for p_index, (p_start, p_end) in enumerate(_paragraphs(text)):
        para: list[tuple[int, int, Kind]] = []
        for start, end, kind in _dialogue_spans(text, p_start, p_end):
            for s, e in _split_long(text, start, end):
                s, e = _trim(text, s, e)
                if e > s and _HAS_WORD.search(text, s, e):
                    para.append((s, e, kind))
        for n, (s, e, kind) in enumerate(para):
            segments.append(
                Segment(
                    i=len(segments),
                    kind=kind,
                    start=s,
                    end=e,
                    text=text[s:e],
                    paragraph=p_index,
                    paragraph_end=n == len(para) - 1,
                )
            )
    return segments
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_segment.py -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/text/segment.py tests/test_segment.py
git commit -m "feat(worker): dialogue/narration segmentation with source offsets (spec 4.1, 5.3)"
```

---

### Task 6: Speaker strategy contract, chain and heuristic

**Files:**
- Create: `worker/src/audiotruyen_worker/speakers/__init__.py` (empty), `speakers/base.py`, `speakers/heuristic.py`
- Test: `worker/tests/test_heuristic.py`

**Interfaces:**
- Consumes: `Segment` from Task 5.
- Produces (`speakers/base.py`): `Gender`, `Emotion` literals; `GENDERS`, `EMOTIONS`; frozen dataclasses `Character(name, gender="unknown", aliases=())` and `SegmentLabel(i, speaker, gender, emotion, intensity)`; `SpeakerStrategy` protocol (`name`, `version`, `analyze(segments, roster) -> list[SegmentLabel]`); `InvalidLabels(ValueError)`; `validate_labels(segments, labels)`; `ChainResult(strategy, version, labels)`; `run_chain(strategies, segments, roster) -> ChainResult` (first valid result wins; raises the last error if all fail).
- Produces (`speakers/heuristic.py`): `HeuristicStrategy` with `name = "heuristic"`, `version = 1`. Narration → `(None, "unknown", "neutral", 0.0)`. Dialogue → speaker and gender from the adjacent narration in the same paragraph (after first, then before) only if it contains a speech verb; roster names/aliases or the earliest pronoun; emotion from cue words (0.5) plus `!` (+0.2 each, max 2; `!!` without a cue → `shout`), trailing `...`/`…` without a cue → `sad` 0.3.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_heuristic.py`:

```python
import pytest

from audiotruyen_worker.speakers.base import Character, InvalidLabels, SegmentLabel, run_chain
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.text.segment import segment_text


def test_heuristic_labels_speaker_gender_and_emotion():
    text = (
        "“Ngươi dám!” Lâm Phong quát.\n"
        "Nàng thì thầm: “Đừng đi...”\n"
        "“Ha ha, tốt lắm!!”\n"
        "Trời tối dần."
    )
    roster = [Character("Lâm Phong", "male")]
    segs = segment_text(text)
    labels = {label.i: label for label in HeuristicStrategy().analyze(segs, roster)}
    by_text = {s.text: labels[s.i] for s in segs}
    assert by_text["“Ngươi dám!”"] == SegmentLabel(0, "Lâm Phong", "male", "angry", 0.7)
    whisper = by_text["“Đừng đi...”"]
    assert (whisper.speaker, whisper.gender, whisper.emotion) == (None, "female", "whisper")
    shout = by_text["“Ha ha, tốt lắm!!”"]
    assert (shout.emotion, shout.intensity) == ("shout", 1.0)
    narration = by_text["Trời tối dần."]
    assert (narration.speaker, narration.gender, narration.emotion, narration.intensity) == (
        None, "unknown", "neutral", 0.0,
    )  # fmt: skip


def test_heuristic_alias_matches_and_speech_verb_is_required():
    roster = [Character("Thạch Uẩn Ngọc", "female", ("Thúy Thúy",))]
    segs = segment_text("Thúy Thúy cười: “Được.”\nThúy Thúy đứng dậy. “Đi thôi.”")
    labels = HeuristicStrategy().analyze(segs, roster)
    dialogue = [label for s, label in zip(segs, labels, strict=True) if s.kind == "dialogue"]
    assert (dialogue[0].speaker, dialogue[0].emotion) == ("Thạch Uẩn Ngọc", "happy")
    assert dialogue[1].speaker is None  # "đứng dậy" is not a speech verb


class _Broken:
    name, version = "broken", 1

    def analyze(self, segments, roster):
        return [SegmentLabel(0, None, "unknown", "neutral", 0.0)]  # misses segments


class _Raises:
    name, version = "raises", 1

    def analyze(self, segments, roster):
        raise RuntimeError("model down")


def test_chain_falls_through_to_the_first_valid_strategy():
    segs = segment_text("“A.” Hắn nói.\nB.")
    result = run_chain([_Raises(), _Broken(), HeuristicStrategy()], segs, [])
    assert (result.strategy, result.version) == ("heuristic", 1)
    assert [label.i for label in result.labels] == [s.i for s in segs]


def test_chain_raises_when_every_strategy_fails():
    with pytest.raises(InvalidLabels):
        run_chain([_Broken()], segment_text("A.\nB."), [])
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_heuristic.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.speakers'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/speakers/__init__.py` (empty) and `worker/src/audiotruyen_worker/speakers/base.py`:

```python
"""Speaker/emotion strategy contract (spec 4.1, 5.4) and the strategy chain."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from audiotruyen_worker.text.segment import Segment

Gender = Literal["male", "female", "unknown"]
Emotion = Literal["neutral", "happy", "sad", "angry", "fearful", "whisper", "shout", "tender"]
GENDERS: frozenset[str] = frozenset({"male", "female", "unknown"})
EMOTIONS: frozenset[str] = frozenset(
    {"neutral", "happy", "sad", "angry", "fearful", "whisper", "shout", "tender"}
)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Character:
    name: str
    gender: Gender = "unknown"
    aliases: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SegmentLabel:
    i: int
    speaker: str | None
    gender: Gender
    emotion: Emotion
    intensity: float


class SpeakerStrategy(Protocol):
    name: str
    version: int

    def analyze(
        self, segments: Sequence[Segment], roster: Sequence[Character]
    ) -> list[SegmentLabel]: ...


class InvalidLabels(ValueError):
    pass


def validate_labels(segments: Sequence[Segment], labels: Sequence[SegmentLabel]) -> None:
    """Accept a strategy result only if it labels every segment exactly once with valid values."""
    if sorted(label.i for label in labels) != [s.i for s in segments]:
        raise InvalidLabels("labels do not cover every segment exactly once")
    for label in labels:
        if label.gender not in GENDERS or label.emotion not in EMOTIONS:
            raise InvalidLabels(f"segment {label.i}: bad gender/emotion")
        if not 0.0 <= label.intensity <= 1.0:
            raise InvalidLabels(f"segment {label.i}: intensity out of range")


@dataclass(frozen=True)
class ChainResult:
    strategy: str
    version: int
    labels: list[SegmentLabel]


def run_chain(
    strategies: Sequence[SpeakerStrategy],
    segments: Sequence[Segment],
    roster: Sequence[Character],
) -> ChainResult:
    """Try strategies in order; the first valid result wins. The last strategy (heuristic) must
    not fail; if every strategy fails, the last error is raised."""
    error: Exception | None = None
    for strategy in strategies:
        try:
            labels = sorted(strategy.analyze(segments, roster), key=lambda label: label.i)
            validate_labels(segments, labels)
        except Exception as exc:  # any strategy failure falls through to the next one
            log.warning("strategy %s failed: %s", strategy.name, exc)
            error = exc
            continue
        return ChainResult(strategy.name, strategy.version, labels)
    raise error or InvalidLabels("no strategies configured")
```

Create `worker/src/audiotruyen_worker/speakers/heuristic.py`:

```python
"""Heuristic speaker/emotion strategy (spec 5.4): attribution verbs and names/pronouns in the
narration next to a dialogue segment; emotion from verbs and punctuation. Never fails."""

from __future__ import annotations

import re
from collections.abc import Sequence

from audiotruyen_worker.speakers.base import Character, Emotion, Gender, SegmentLabel
from audiotruyen_worker.text.segment import Segment

# Ordered: first match wins, so multi-word and stronger cues come first.
_EMOTION_CUES: list[tuple[str, Emotion]] = [
    (r"thì thầm|thầm thì|nói nhỏ|thì thào|khẽ nói|ghé tai", "whisper"),
    (r"gào|hét lớn|thét|rống|la lớn", "shout"),
    (r"quát|gầm|gắt|nổi giận|giận dữ|tức giận|lạnh lùng nói|nghiến răng", "angry"),
    (r"nức nở|nghẹn ngào|khóc|thút thít|bi thương|thở dài", "sad"),
    (r"run rẩy|sợ hãi|hoảng|kinh hãi|run giọng|lắp bắp", "fearful"),
    (r"dịu dàng|ôn nhu|âu yếm|nhẹ nhàng nói|cưng chiều", "tender"),
    (r"cười|vui vẻ|hớn hở|reo|hào hứng", "happy"),
]
_EMOTION_RES = [(re.compile(rf"(?<!\w)(?:{p})(?!\w)", re.IGNORECASE), e) for p, e in _EMOTION_CUES]
_SPEECH_VERB = re.compile(
    r"(?<!\w)(?:nói|hỏi|đáp|quát|gầm|hét|gào|thét|gắt|kêu|lẩm bẩm|thì thầm|thầm thì|cười|"
    r"khóc|lên tiếng|mở miệng|trả lời|hừ|than|thở dài|nhắc|bảo)(?!\w)",
    re.IGNORECASE,
)
_PRONOUNS: dict[str, Gender] = {
    "anh": "male", "hắn": "male", "ông": "male", "gã": "male", "lão": "male", "chàng": "male",
    "cậu": "male", "thằng": "male",
    "cô": "female", "nàng": "female", "bà": "female", "ả": "female",
    "chị": "female", "muội": "female", "cô ấy": "female", "bà ấy": "female",
}  # fmt: skip
_PRONOUN_RE = re.compile(
    r"(?<!\w)(" + "|".join(sorted(map(re.escape, _PRONOUNS), key=len, reverse=True)) + r")(?!\w)",
    re.IGNORECASE,
)


class HeuristicStrategy:
    name = "heuristic"
    version = 1

    def analyze(
        self, segments: Sequence[Segment], roster: Sequence[Character]
    ) -> list[SegmentLabel]:
        names = sorted(
            ((alias, c) for c in roster for alias in (c.name, *c.aliases) if alias),
            key=lambda pair: len(pair[0]),
            reverse=True,
        )
        labels = []
        for seg in segments:
            if seg.kind == "narration":
                labels.append(SegmentLabel(seg.i, None, "unknown", "neutral", 0.0))
                continue
            context = _attribution_context(segments, seg)
            speaker, gender = _find_speaker(context, names)
            emotion, intensity = _emotion(seg.text, context)
            labels.append(SegmentLabel(seg.i, speaker, gender, emotion, intensity))
        return labels


def _attribution_context(segments: Sequence[Segment], seg: Segment) -> str:
    """Narration in the same paragraph right after the dialogue, else right before it.
    Only narration that contains a speech verb counts as attribution."""
    after = segments[seg.i + 1] if seg.i + 1 < len(segments) else None
    before = segments[seg.i - 1] if seg.i > 0 else None
    for cand in (after, before):
        if cand and cand.kind == "narration" and cand.paragraph == seg.paragraph:
            if _SPEECH_VERB.search(cand.text):
                return cand.text
    return ""


def _find_speaker(context: str, names: list[tuple[str, Character]]) -> tuple[str | None, Gender]:
    if not context:
        return None, "unknown"
    best: tuple[int, str | None, Gender] = (len(context) + 1, None, "unknown")
    for alias, character in names:
        pos = context.find(alias)
        if 0 <= pos < best[0]:
            best = (pos, character.name, character.gender)
    match = _PRONOUN_RE.search(context)
    if match and match.start() < best[0]:
        return None, _PRONOUNS[match.group(1).lower()]
    return best[1], best[2]


def _emotion(dialogue: str, context: str) -> tuple[Emotion, float]:
    emotion: Emotion = "neutral"
    intensity = 0.0
    for pattern, label in _EMOTION_RES:
        if context and pattern.search(context):
            emotion, intensity = label, 0.5
            break
    stripped = dialogue.rstrip('"”’» ')
    exclaims = stripped.count("!")
    if exclaims:
        if emotion == "neutral":
            emotion, intensity = ("shout", 0.6) if exclaims >= 2 else ("neutral", 0.3)
        intensity = min(1.0, intensity + 0.2 * min(exclaims, 2))
    elif emotion == "neutral" and stripped.endswith(("...", "…")):
        emotion, intensity = "sad", 0.3
    return emotion, round(intensity, 2)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_heuristic.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/speakers tests/test_heuristic.py
git commit -m "feat(worker): speaker strategy chain with the heuristic strategy (spec 5.4)"
```

---

### Task 7: Job queue wrappers and the job loop

**Files:**
- Create: `worker/src/audiotruyen_worker/jobs/__init__.py` (empty), `jobs/queue.py`, `jobs/runner.py`
- Test: `worker/tests/test_runner.py` (unit), `worker/tests/test_db_jobs.py` (db tier)

**Interfaces:**
- Consumes: Task 1 RPCs; errors from Task 2.
- Produces (`jobs/queue.py`): frozen dataclass `Job(id, user_id, type, payload, priority, attempts, max_attempts)` with `Job.from_row(row)`; `JobQueue(client, worker_id, lease_seconds=300)` with `claim(types) -> Job | None`, `heartbeat(version, device, job_id) -> bool`, `finish(job_id, status, result=None, error=None) -> bool`, `fail(job_id, error, retryable) -> str | None`.
- Produces (`jobs/runner.py`): `SHUTDOWN_MESSAGE`; `JobCancelled`; `PermanentJobError` (Vietnamese message, not retried); `JobContext(job, cancelled)` with `check()`; `Handler = Callable[[Job, JobContext], Mapping | None]`; `describe_failure(exc) -> (message, retryable)`; `Runner(queue, handlers, *, version, device, wake=None, poll_seconds=30.0)` with `run_once() -> bool`, `beat(queue=None)`, `cancel_current()`, `run_forever(stop)`, `current_job_id`, `wake`; `Heartbeat(runner, queue, stop, interval=15.0)` thread.
- Semantics: claims only types that have handlers; success → `finish(done, result)`; `JobCancelled` (lease lost) → no write; other exceptions → `fail(message, retryable)` with the Vietnamese message from `describe_failure` (raw text of unexpected exceptions stays in the log); Ctrl+C inside a handler → `fail(SHUTDOWN_MESSAGE, retryable=True)` then re-raise; a heartbeat that reports the current job as not owned sets its `cancelled` flag.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_runner.py`:

```python
import threading

import pytest

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import (
    SHUTDOWN_MESSAGE,
    JobCancelled,
    JobContext,
    PermanentJobError,
    Runner,
    describe_failure,
)
from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError

USER = "11111111-1111-1111-1111-111111111111"


class FakeQueue:
    worker_id = "w-test"

    def __init__(self, jobs=()):
        self.jobs = list(jobs)
        self.claimed_types: list[list[str]] = []
        self.finished: list[tuple] = []
        self.failed: list[tuple] = []
        self.beats: list[str | None] = []
        self.owned = True

    def claim(self, types):
        self.claimed_types.append(list(types))
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, version, device, job_id):
        self.beats.append(job_id)
        return self.owned

    def finish(self, job_id, status, result=None, error=None):
        self.finished.append((job_id, status, result))
        return True

    def fail(self, job_id, error, retryable):
        self.failed.append((job_id, error, retryable))
        return "queued" if retryable else "failed"


def job(type_="search", payload=None):
    return Job(id="j1", user_id=USER, type=type_, payload=payload or {})


def test_runner_claims_only_handled_types_and_finishes():
    queue = FakeQueue([job()])
    runner = Runner(
        queue,
        {"search": lambda j, c: {"items": []}, "fetch_novel": lambda j, c: None},
        version="v",
        device="cpu",
    )
    assert runner.run_once() is True
    assert queue.claimed_types == [["fetch_novel", "search"]]
    assert queue.finished == [("j1", "done", {"items": []})]
    assert runner.run_once() is False


@pytest.mark.parametrize(
    ("exc", "retryable"),
    [
        (SourceError("HTTP 502"), True),
        (SourceBlocked("challenge"), True),
        (ParserBroken("no #chapter-c"), False),
        (NovelNotFound("x"), False),
        (PermanentJobError("Job thiếu trường 'url'."), False),
        (RuntimeError("bug"), True),
    ],
)
def test_runner_records_failures_with_vietnamese_messages(exc, retryable):
    def boom(j, c):
        raise exc

    queue = FakeQueue([job()])
    Runner(queue, {"search": boom}, version="v", device="cpu").run_once()
    ((job_id, message, was_retryable),) = queue.failed
    assert job_id == "j1" and was_retryable is retryable
    assert message == describe_failure(exc)[0]
    assert "bug" not in message  # raw exception text of unexpected errors stays in the log


def test_lost_lease_cancels_the_running_handler_without_writing():
    queue = FakeQueue([job()])
    started, release = threading.Event(), threading.Event()

    def slow(j, ctx):
        started.set()
        release.wait(5)
        ctx.check()
        return {"never": True}

    runner = Runner(queue, {"search": slow}, version="v", device="cpu")
    worker = threading.Thread(target=runner.run_once)
    worker.start()
    assert started.wait(5)
    queue.owned = False
    runner.beat()
    release.set()
    worker.join(5)
    assert queue.beats == ["j1"]
    assert queue.finished == [] and queue.failed == []


def test_keyboard_interrupt_hands_the_job_back():
    def interrupted(j, c):
        raise KeyboardInterrupt

    queue = FakeQueue([job()])
    with pytest.raises(KeyboardInterrupt):
        Runner(queue, {"search": interrupted}, version="v", device="cpu").run_once()
    assert queue.failed == [("j1", SHUTDOWN_MESSAGE, True)]


def test_heartbeat_without_job_reports_none():
    queue = FakeQueue()
    Runner(queue, {}, version="v", device="cpu").beat()
    assert queue.beats == [None]


def test_context_check_raises_after_cancel():
    ctx = JobContext(job())
    ctx.check()
    ctx.cancelled.set()
    with pytest.raises(JobCancelled):
        ctx.check()
```

Create `worker/tests/test_db_jobs.py`:

```python
import pytest
from postgrest.exceptions import APIError

from audiotruyen_worker.jobs.queue import JobQueue

pytestmark = pytest.mark.db


def test_queue_roundtrip_and_fencing(admin_client, owner):
    queue = JobQueue(admin_client, "w-db-test")
    other = JobQueue(admin_client, "w-other")
    admin_client.table("jobs").insert(
        {"user_id": owner["id"], "type": "search", "payload": {"query": "a"}}
    ).execute()
    job = queue.claim(["search"])
    assert job is not None and job.payload == {"query": "a"} and job.attempts == 1
    assert queue.heartbeat("0.2.0", "cpu", job.id) is True
    assert other.finish(job.id, "done") is False
    try:
        assert queue.fail(job.id, "tạm thời", True) == "queued"
        assert queue.fail(job.id, "tạm thời", True) is None
    finally:  # worker_status has no owner column, so user deletion does not clean it up
        admin_client.table("worker_status").delete().eq("worker_id", "w-db-test").execute()


def test_web_enqueue_is_guarded(owner):
    from supabase import create_client

    from tests.conftest import ANON, URL

    client = create_client(URL, ANON)
    client.auth.sign_in_with_password({"email": owner["email"], "password": owner["password"]})
    client.table("jobs").insert(
        {"user_id": owner["id"], "type": "search", "payload": {"query": "a"}}
    ).execute()
    with pytest.raises(APIError):
        client.table("jobs").insert(
            {"user_id": owner["id"], "type": "search", "status": "running"}
        ).execute()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_runner.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.jobs'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/jobs/__init__.py` (empty) and `worker/src/audiotruyen_worker/jobs/queue.py`:

```python
"""Job queue RPC wrappers (service role). Every write is fenced by (job id, worker id, running)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Job:
    id: str
    user_id: str
    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    priority: int = 10
    attempts: int = 1
    max_attempts: int = 3

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            type=row["type"],
            payload=row.get("payload") or {},
            priority=row["priority"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
        )


class JobQueue:
    def __init__(self, client, worker_id: str, lease_seconds: int = 300) -> None:
        self._client = client
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds

    def _rpc(self, name: str, params: dict[str, Any]) -> Any:
        return self._client.rpc(name, params).execute().data

    def claim(self, types: Sequence[str]) -> Job | None:
        rows = self._rpc(
            "claim_job",
            {
                "p_worker_id": self.worker_id,
                "p_lease_seconds": self.lease_seconds,
                "p_types": list(types),
            },
        )
        return Job.from_row(rows[0]) if rows else None

    def heartbeat(self, version: str, device: str, job_id: str | None) -> bool:
        """Requeues expired leases, extends job_id's lease, updates worker_status.
        Returns False when this worker no longer owns job_id."""
        return bool(
            self._rpc(
                "worker_heartbeat",
                {
                    "p_worker_id": self.worker_id,
                    "p_version": version,
                    "p_device": device,
                    "p_job_id": job_id,
                    "p_lease_seconds": self.lease_seconds,
                },
            )
        )

    def finish(
        self, job_id: str, status: str, result: dict | None = None, error: str | None = None
    ) -> bool:
        return bool(
            self._rpc(
                "finish_job",
                {
                    "p_job_id": job_id,
                    "p_worker_id": self.worker_id,
                    "p_status": status,
                    "p_result": result,
                    "p_error": error,
                },
            )
        )

    def fail(self, job_id: str, error: str, retryable: bool) -> str | None:
        """Returns the job's new status ('queued' or 'failed'), or None if no longer owned."""
        return self._rpc(
            "fail_job",
            {
                "p_job_id": job_id,
                "p_worker_id": self.worker_id,
                "p_error": error,
                "p_retryable": retryable,
            },
        )
```

Create `worker/src/audiotruyen_worker/jobs/runner.py`:

```python
"""Job loop (spec 5.1): one job at a time, Realtime wake with polling fallback, heartbeat thread
that extends the lease and cancels the running handler when the lease is lost."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError

log = logging.getLogger(__name__)


SHUTDOWN_MESSAGE = "Worker đã dừng giữa chừng; job sẽ được chạy lại."


class JobCancelled(Exception):
    """Raised by JobContext.check() when the job must stop (lease lost or shutdown)."""


class PermanentJobError(Exception):
    """A failure that retrying cannot fix. The message is shown to the owner (Vietnamese)."""


@dataclass
class JobContext:
    job: Job
    cancelled: threading.Event = field(default_factory=threading.Event)

    def check(self) -> None:
        if self.cancelled.is_set():
            raise JobCancelled(self.job.id)


Handler = Callable[[Job, JobContext], Mapping[str, Any] | None]


class Queue(Protocol):
    worker_id: str

    def claim(self, types: list[str]) -> Job | None: ...
    def heartbeat(self, version: str, device: str, job_id: str | None) -> bool: ...
    def finish(
        self, job_id: str, status: str, result: dict | None = None, error: str | None = None
    ) -> bool: ...
    def fail(self, job_id: str, error: str, retryable: bool) -> str | None: ...


def describe_failure(exc: BaseException) -> tuple[str, bool]:
    """(Vietnamese message for the owner, retryable)."""
    if isinstance(exc, PermanentJobError):
        return str(exc), False
    if isinstance(exc, NovelNotFound):
        return "Không tìm thấy truyện trên truyenfull (truyện có thể đã bị gỡ).", False
    if isinstance(exc, ParserBroken):
        return f"Không đọc được trang truyenfull, có thể trang đã đổi cấu trúc ({exc}).", False
    if isinstance(exc, SourceBlocked):
        return (
            "Truyenfull đang chặn truy cập tự động (Cloudflare) cho trang này. "
            "Worker sẽ thử lại sau.",
            True,
        )
    if isinstance(exc, SourceError):
        return f"Không tải được trang truyenfull ({exc}). Worker sẽ thử lại sau.", True
    return (
        f"Lỗi không mong muốn trong worker ({type(exc).__name__}). Xem worker/logs/worker.log.",
        True,
    )


class Runner:
    def __init__(
        self,
        queue: Queue,
        handlers: Mapping[str, Handler],
        *,
        version: str,
        device: str,
        wake: threading.Event | None = None,
        poll_seconds: float = 30.0,
    ) -> None:
        self.queue = queue
        self.handlers = dict(handlers)
        self.version = version
        self.device = device
        self.wake = wake or threading.Event()
        self.poll_seconds = poll_seconds
        self._current: JobContext | None = None
        self._lock = threading.Lock()

    @property
    def current_job_id(self) -> str | None:
        with self._lock:
            return self._current.job.id if self._current else None

    def run_once(self) -> bool:
        """Claim and run one job. Returns False when the queue had nothing for us."""
        job = self.queue.claim(sorted(self.handlers))
        if job is None:
            return False
        ctx = JobContext(job)
        with self._lock:
            self._current = ctx
        try:
            self._execute(job, ctx)
        finally:
            with self._lock:
                self._current = None
        return True

    def _execute(self, job: Job, ctx: JobContext) -> None:
        log.info(
            "job %s %s started (attempt %d/%d)", job.id, job.type, job.attempts, job.max_attempts
        )
        try:
            result = self.handlers[job.type](job, ctx)
        except JobCancelled:
            log.warning("job %s stopped: lease lost", job.id)
            return  # the job was requeued by requeue_expired_jobs; nothing to write
        except KeyboardInterrupt:
            # Ctrl+C: hand the job back now instead of waiting for its lease to expire.
            self.queue.fail(job.id, SHUTDOWN_MESSAGE, True)
            raise
        except Exception as exc:  # every failure is recorded on the job row
            message, retryable = describe_failure(exc)
            log.exception("job %s failed (retryable=%s)", job.id, retryable)
            status = self.queue.fail(job.id, message, retryable)
            log.info("job %s -> %s", job.id, status)
            return
        if not self.queue.finish(job.id, "done", dict(result) if result else None):
            log.warning("job %s finished but the lease was already lost", job.id)
        else:
            log.info("job %s done", job.id)

    def cancel_current(self) -> None:
        with self._lock:
            if self._current:
                self._current.cancelled.set()

    def beat(self, queue: Queue | None = None) -> None:
        """One heartbeat (from the heartbeat thread, with its own client). Cancels the running
        job when its lease was lost."""
        job_id = self.current_job_id
        owned = (queue or self.queue).heartbeat(self.version, self.device, job_id)
        if job_id and not owned:
            log.warning("lease lost for job %s; stopping it", job_id)
            self.cancel_current()

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                ran = self.run_once()
            except Exception:  # network blip talking to Supabase: back off, keep the loop alive
                log.exception("job loop error")
                ran = False
                stop.wait(5)
            if not ran:
                self.wake.wait(self.poll_seconds)
                self.wake.clear()


class Heartbeat(threading.Thread):
    def __init__(
        self, runner: Runner, queue: Queue, stop: threading.Event, interval: float = 15.0
    ) -> None:
        super().__init__(name="heartbeat", daemon=True)
        self.runner = runner
        self.queue = queue
        self.stop = stop
        self.interval = interval

    def run(self) -> None:
        while True:
            try:
                self.runner.beat(self.queue)
            except Exception:  # keep beating; the next beat may succeed
                log.exception("heartbeat failed")
            if self.stop.wait(self.interval):
                return
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_runner.py -q`
Expected: PASS (11 tests).

Run the DB tier (local Supabase with Task 1 applied; Git Bash from the repo root: `set -a; source <(bash scripts/supabase-test-env.sh); set +a`, then from `worker/`): `uv run pytest tests/test_db_jobs.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/jobs tests/test_runner.py tests/test_db_jobs.py
git commit -m "feat(worker): fenced job queue wrappers, job loop and heartbeat (spec 5.1)"
```

---

### Task 8: Store and job handlers (search, fetch_novel, fetch_chapter)

**Files:**
- Create: `worker/src/audiotruyen_worker/store.py`, `worker/src/audiotruyen_worker/jobs/handlers.py`
- Test: `worker/tests/test_handlers.py` (unit), `worker/tests/test_db_store.py` (db tier)

**Interfaces:**
- Consumes: Tasks 2-7.
- Produces (`store.py`): `SOURCE = "truyenfull"`; frozen dataclass `ChapterRow(id, user_id, novel_id, index, url, text_hash)`; `Store(client)` with `upsert_novel(user_id, info) -> novel_id`, `upsert_chapters(user_id, novel_id, chapters)` (upsert on `(novel_id, index)`, batches of 500, never deletes, never touches `text`), `finish_toc(novel_id, chapter_count)`, `chapter(chapter_id, user_id) -> ChapterRow | None` (scoped to the owner), `save_chapter_text(chapter_id, text, text_hash)`, `roster(novel_id) -> list[Character]`, `has_analysis(chapter_id, text_hash, strategy, version) -> bool`, `save_analysis(user_id, chapter_id, text_hash, strategy, version, segments)`.
- Produces (`jobs/handlers.py`): `MAX_SEARCH_RESULTS = 30`, `MAX_QUERY_CHARS = 100`, `text_hash(text) -> str` (sha256 hex), `analysis_document(segments, labels) -> list[dict]`, `make_handlers(adapter, store, strategies) -> dict[str, Handler]` with keys `search`, `fetch_novel`, `fetch_chapter`.
- Payloads and results: `search {query}` → `{items: [NovelSummary as dict, ≤30]}`; `fetch_novel {url}` → `{novel_id, chapter_count}` (each TOC page is stored before the next is requested); `fetch_chapter {chapter_id}` → `{chars, segments, strategy}`. `chapter_analysis.segments` entries: `{i, kind, src: [start, end], p, pe, speaker, gender, emotion, intensity}` (spec 4.1 minus voice and timing, which M2b adds to `chapter_audio.segments`).

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_handlers.py`:

```python
from pathlib import Path

import pytest

from audiotruyen_worker.jobs.handlers import analysis_document, make_handlers, text_hash
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobCancelled, JobContext, PermanentJobError
from audiotruyen_worker.sources.base import (
    ChapterContent,
    ChapterRef,
    NovelInfo,
    NovelSummary,
    TocPage,
)
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.store import ChapterRow

USER = "11111111-1111-1111-1111-111111111111"
CHAPTER = "cccccccc-0000-0000-0000-000000000001"


def job(type_="search", payload=None):
    return Job(id="j1", user_id=USER, type=type_, payload=payload or {})


INFO = NovelInfo(
    "45719", "https://truyenfull.live/a/", "a", "Truyện A", "Tác giả", None, None, "ongoing"
)


class FakeAdapter:
    id = "truyenfull"

    def __init__(self, pages=None, text="", events=None):
        self.pages = pages or []
        self.text = text
        self.events = events if events is not None else []

    def matches(self, url):
        return url.startswith("https://truyenfull.live/")

    def search(self, query):
        self.events.append(("search", query))
        return [
            NovelSummary(f"https://truyenfull.live/n{i}/", f"N{i}", None, None, None)
            for i in range(40)
        ]

    def toc_pages(self, url, start_page=1):
        for page in self.pages:
            self.events.append(("page", page.page))
            yield page

    def chapter(self, url):
        self.events.append(("chapter", url))
        return ChapterContent("Chương 1", self.text)


class FakeStore:
    def __init__(self, events=None, chapter_row=None, analysis=False):
        self.events = events if events is not None else []
        self.chapter_row = chapter_row
        self.analysis = analysis
        self.saved_text = None
        self.saved_analysis = None

    def upsert_novel(self, user_id, info):
        self.events.append(("novel", info.source_novel_id))
        return "novel-uuid"

    def upsert_chapters(self, user_id, novel_id, chapters):
        self.events.append(("chapters", [c.index for c in chapters]))

    def finish_toc(self, novel_id, count):
        self.events.append(("finish", count))

    def chapter(self, chapter_id, user_id):
        return self.chapter_row if user_id == USER else None

    def save_chapter_text(self, chapter_id, text, digest):
        self.saved_text = (chapter_id, text, digest)

    def roster(self, novel_id):
        return []

    def has_analysis(self, chapter_id, digest, strategy, version):
        return self.analysis

    def save_analysis(self, user_id, chapter_id, digest, strategy, version, segments):
        self.saved_analysis = (strategy, version, segments)


def _page(n, indexes, total):
    return TocPage(
        INFO,
        n,
        total,
        [ChapterRef(i, f"Chương {i}", f"https://truyenfull.live/a/chuong-{i}/") for i in indexes],
    )


def test_search_caps_results_and_validates_query():
    handlers = make_handlers(FakeAdapter(), FakeStore(), [HeuristicStrategy()])
    result = handlers["search"](job("search", {"query": " kiếm "}), JobContext(job()))
    assert len(result["items"]) == 30
    assert result["items"][0]["url"] == "https://truyenfull.live/n0/"
    with pytest.raises(PermanentJobError):
        handlers["search"](job("search", {"query": "x" * 101}), JobContext(job()))


def test_fetch_novel_commits_each_page_before_reading_the_next():
    events: list = []
    adapter = FakeAdapter([_page(1, range(1, 51), 2), _page(2, range(51, 54), 2)], events=events)
    handlers = make_handlers(adapter, FakeStore(events), [HeuristicStrategy()])
    result = handlers["fetch_novel"](
        job("fetch_novel", {"url": "https://truyenfull.live/a/"}), JobContext(job())
    )
    assert result == {"novel_id": "novel-uuid", "chapter_count": 53}
    assert [e[0] for e in events] == ["page", "novel", "chapters", "page", "chapters", "finish"]


def test_fetch_novel_rejects_foreign_urls():
    handlers = make_handlers(FakeAdapter(), FakeStore(), [HeuristicStrategy()])
    with pytest.raises(PermanentJobError):
        handlers["fetch_novel"](
            job("fetch_novel", {"url": "https://example.com/a/"}), JobContext(job())
        )


def test_fetch_novel_stops_between_pages_when_cancelled():
    adapter = FakeAdapter([_page(1, range(1, 51), 2), _page(2, range(51, 54), 2)])
    store = FakeStore()
    ctx = JobContext(job())
    ctx.cancelled.set()
    with pytest.raises(JobCancelled):
        make_handlers(adapter, store, [HeuristicStrategy()])["fetch_novel"](
            job("fetch_novel", {"url": "https://truyenfull.live/a/"}), ctx
        )
    assert store.events == []


TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần."


def test_fetch_chapter_saves_text_and_analysis():
    row = ChapterRow(CHAPTER, USER, "novel-uuid", 1, "https://truyenfull.live/a/chuong-1/", None)
    store = FakeStore(chapter_row=row)
    handlers = make_handlers(FakeAdapter(text=TEXT), store, [HeuristicStrategy()])
    result = handlers["fetch_chapter"](
        job("fetch_chapter", {"chapter_id": CHAPTER}), JobContext(job())
    )
    assert result == {"chars": len(TEXT), "segments": 3, "strategy": "heuristic"}
    assert store.saved_text == (CHAPTER, TEXT, text_hash(TEXT))
    strategy, version, segments = store.saved_analysis
    assert (strategy, version) == ("heuristic", 1)
    assert segments[0] == {
        "i": 0, "kind": "dialogue", "src": [0, 12], "p": 0, "pe": False,
        "speaker": None, "gender": "unknown", "emotion": "angry", "intensity": 0.7,
    }  # fmt: skip
    assert [s["src"] for s in segments] == [[0, 12], [13, 28], [29, 42]]


def test_fetch_chapter_skips_unchanged_text_and_existing_analysis():
    row = ChapterRow(CHAPTER, USER, "novel-uuid", 1, "u", text_hash(TEXT))
    store = FakeStore(chapter_row=row, analysis=True)
    make_handlers(FakeAdapter(text=TEXT), store, [HeuristicStrategy()])["fetch_chapter"](
        job("fetch_chapter", {"chapter_id": CHAPTER}), JobContext(job())
    )
    assert store.saved_text is None and store.saved_analysis is None


@pytest.mark.parametrize(
    "payload",
    [{}, {"chapter_id": "not-a-uuid"}, {"chapter_id": "dddddddd-0000-0000-0000-000000000009"}],
)
def test_fetch_chapter_rejects_bad_or_foreign_chapter_ids(payload):
    handlers = make_handlers(
        FakeAdapter(text=TEXT), FakeStore(chapter_row=None), [HeuristicStrategy()]
    )
    with pytest.raises(PermanentJobError):
        handlers["fetch_chapter"](job("fetch_chapter", payload), JobContext(job()))


def test_analysis_document_matches_segments():
    from audiotruyen_worker.text.segment import segment_text

    segs = segment_text(TEXT)
    labels = HeuristicStrategy().analyze(segs, [])
    doc = analysis_document(segs, labels)
    assert [d["i"] for d in doc] == [0, 1, 2]
    assert all(TEXT[d["src"][0] : d["src"][1]] == s.text for d, s in zip(doc, segs, strict=True))


def test_pipeline_budget_on_a_real_chapter():
    """Perf budget (7.3.2): parse + segment + heuristic for one chapter stays far below 100 ms."""
    import time

    from audiotruyen_worker.sources.truyenfull_parse import parse_chapter_page
    from audiotruyen_worker.text.segment import segment_text

    html = (Path(__file__).parent / "fixtures" / "truyenfull" / "chapter_new_354.html").read_text(
        encoding="utf-8"
    )
    start = time.perf_counter()
    for _ in range(10):
        segs = segment_text(parse_chapter_page(html).text)
        HeuristicStrategy().analyze(segs, [])
    assert (time.perf_counter() - start) / 10 < 0.1
```

Create `worker/tests/test_db_store.py`:

```python
import pytest

from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.store import Store

pytestmark = pytest.mark.db


INFO = NovelInfo(
    "45719", "https://truyenfull.live/a/", "a", "Truyện A", "Tác giả", None, "Giới thiệu", "ongoing"
)


def _refs(indexes, suffix=""):
    return [
        ChapterRef(i, f"Chương {i}{suffix}", f"https://truyenfull.live/a/chuong-{i}/")
        for i in indexes
    ]


def test_store_upserts_are_idempotent_and_never_delete(admin_client, owner):
    store = Store(admin_client)
    novel_id = store.upsert_novel(owner["id"], INFO)
    assert store.upsert_novel(owner["id"], INFO) == novel_id
    store.upsert_chapters(owner["id"], novel_id, _refs(range(1, 4)))
    first = store.chapter(
        admin_client.table("chapters")
        .select("id")
        .eq("novel_id", novel_id)
        .eq("index", 1)
        .execute()
        .data[0]["id"],
        owner["id"],
    )
    store.save_chapter_text(first.id, "nội dung", "h1")
    # A re-read TOC with a renamed chapter and fewer entries: titles refresh, text and rows stay.
    store.upsert_chapters(owner["id"], novel_id, _refs([1], " (sửa)"))
    rows = (
        admin_client.table("chapters")
        .select("index,title,text")
        .eq("novel_id", novel_id)
        .order("index")
        .execute()
        .data
    )
    assert [r["index"] for r in rows] == [1, 2, 3]
    assert rows[0]["title"] == "Chương 1 (sửa)" and rows[0]["text"] == "nội dung"
    store.finish_toc(novel_id, 3)
    novel = (
        admin_client.table("novels")
        .select("chapter_count,last_checked_at")
        .eq("id", novel_id)
        .execute()
        .data[0]
    )
    assert novel["chapter_count"] == 3 and novel["last_checked_at"] is not None


def test_store_chapter_is_scoped_to_the_owner(admin_client, owner):
    store = Store(admin_client)
    novel_id = store.upsert_novel(owner["id"], INFO)
    store.upsert_chapters(owner["id"], novel_id, _refs([1]))
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    assert store.chapter(chapter_id, owner["id"]) is not None
    assert store.chapter(chapter_id, "22222222-2222-2222-2222-222222222222") is None


def test_store_analysis_roundtrip(admin_client, owner):
    store = Store(admin_client)
    novel_id = store.upsert_novel(owner["id"], INFO)
    store.upsert_chapters(owner["id"], novel_id, _refs([1]))
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    assert store.has_analysis(chapter_id, "h", "heuristic", 1) is False
    store.save_analysis(owner["id"], chapter_id, "h", "heuristic", 1, [{"i": 0}])
    store.save_analysis(owner["id"], chapter_id, "h", "heuristic", 1, [{"i": 0}])  # idempotent
    assert store.has_analysis(chapter_id, "h", "heuristic", 1) is True
    admin_client.table("characters").insert(
        {
            "user_id": owner["id"],
            "novel_id": novel_id,
            "name": "Lâm Phong",
            "gender": "male",
            "aliases": ["Phong ca"],
        }
    ).execute()
    (character,) = store.roster(novel_id)
    assert (character.name, character.gender, character.aliases) == (
        "Lâm Phong",
        "male",
        ("Phong ca",),
    )
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_handlers.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.jobs.handlers'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/store.py`:

```python
"""Database access for job handlers (service role, so every query scopes by user_id itself)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from postgrest.types import ReturnMethod

from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.speakers.base import Character

SOURCE = "truyenfull"
_CHAPTER_BATCH = 500


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class ChapterRow:
    id: str
    user_id: str
    novel_id: str
    index: int
    url: str
    text_hash: str | None


class Store:
    def __init__(self, client) -> None:
        self._db = client

    def upsert_novel(self, user_id: str, info: NovelInfo) -> str:
        row = {
            "user_id": user_id,
            "source": SOURCE,
            "source_novel_id": info.source_novel_id,
            "url": info.url,
            "slug": info.slug,
            "title": info.title,
            "author": info.author,
            "cover_url": info.cover_url,
            "description": info.description,
            "status": info.status,
        }
        data = (
            self._db.table("novels")
            .upsert(row, on_conflict="user_id,source,source_novel_id")
            .execute()
            .data
        )
        return data[0]["id"]

    def upsert_chapters(self, user_id: str, novel_id: str, chapters: Sequence[ChapterRef]) -> None:
        """Insert new TOC entries and refresh title/url of existing ones on (novel_id, index).
        Never deletes and never touches fetched text."""
        rows = [
            {
                "user_id": user_id,
                "novel_id": novel_id,
                "index": c.index,
                "title": c.title,
                "url": c.url,
            }
            for c in chapters
        ]
        for start in range(0, len(rows), _CHAPTER_BATCH):
            self._db.table("chapters").upsert(
                rows[start : start + _CHAPTER_BATCH],
                on_conflict="novel_id,index",
                returning=ReturnMethod.minimal,
            ).execute()

    def finish_toc(self, novel_id: str, chapter_count: int) -> None:
        self._db.table("novels").update(
            {"chapter_count": chapter_count, "last_checked_at": _now()}
        ).eq("id", novel_id).execute()

    def chapter(self, chapter_id: str, user_id: str) -> ChapterRow | None:
        data = (
            self._db.table("chapters")
            .select("id,user_id,novel_id,index,url,text_hash")
            .eq("id", chapter_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
            .data
        )
        return ChapterRow(**data[0]) if data else None

    def save_chapter_text(self, chapter_id: str, text: str, text_hash: str) -> None:
        self._db.table("chapters").update(
            {"text": text, "text_hash": text_hash, "fetched_at": _now()}
        ).eq("id", chapter_id).execute()

    def roster(self, novel_id: str) -> list[Character]:
        data = (
            self._db.table("characters")
            .select("name,gender,aliases")
            .eq("novel_id", novel_id)
            .execute()
            .data
        )
        return [Character(r["name"], r["gender"], tuple(r["aliases"] or ())) for r in data]

    def has_analysis(self, chapter_id: str, text_hash: str, strategy: str, version: int) -> bool:
        data = (
            self._db.table("chapter_analysis")
            .select("chapter_id")
            .eq("chapter_id", chapter_id)
            .eq("text_hash", text_hash)
            .eq("strategy", strategy)
            .eq("strategy_version", version)
            .limit(1)
            .execute()
            .data
        )
        return bool(data)

    def save_analysis(
        self,
        user_id: str,
        chapter_id: str,
        text_hash: str,
        strategy: str,
        version: int,
        segments: list[dict[str, Any]],
    ) -> None:
        self._db.table("chapter_analysis").upsert(
            {
                "user_id": user_id,
                "chapter_id": chapter_id,
                "text_hash": text_hash,
                "strategy": strategy,
                "strategy_version": version,
                "segments": segments,
            },
            on_conflict="chapter_id,text_hash,strategy,strategy_version",
            returning=ReturnMethod.minimal,
        ).execute()
```

Create `worker/src/audiotruyen_worker/jobs/handlers.py`:

```python
"""M2a job handlers: search, fetch_novel, fetch_chapter (spec 5.1-5.4)."""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Sequence
from dataclasses import asdict
from typing import Any

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import Handler, JobContext, PermanentJobError
from audiotruyen_worker.sources.base import SourceAdapter
from audiotruyen_worker.speakers.base import SegmentLabel, SpeakerStrategy, run_chain
from audiotruyen_worker.store import Store
from audiotruyen_worker.text.segment import Segment, segment_text

log = logging.getLogger(__name__)

MAX_SEARCH_RESULTS = 30
MAX_QUERY_CHARS = 100


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def analysis_document(
    segments: Sequence[Segment], labels: Sequence[SegmentLabel]
) -> list[dict[str, Any]]:
    """chapter_analysis.segments: spec 4.1 fields known before synthesis (no voice, no timing)."""
    by_i = {label.i: label for label in labels}
    return [
        {
            "i": s.i,
            "kind": s.kind,
            "src": [s.start, s.end],
            "p": s.paragraph,
            "pe": s.paragraph_end,
            "speaker": by_i[s.i].speaker,
            "gender": by_i[s.i].gender,
            "emotion": by_i[s.i].emotion,
            "intensity": by_i[s.i].intensity,
        }
        for s in segments
    ]


def _payload_str(job: Job, key: str, max_len: int = 2000) -> str:
    value = job.payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise PermanentJobError(f"Job thiếu hoặc sai trường '{key}'.")
    return value.strip()


def make_handlers(
    adapter: SourceAdapter, store: Store, strategies: Sequence[SpeakerStrategy]
) -> dict[str, Handler]:
    def search(job: Job, ctx: JobContext) -> dict[str, Any]:
        query = _payload_str(job, "query", MAX_QUERY_CHARS)
        items = adapter.search(query)[:MAX_SEARCH_RESULTS]
        return {"items": [asdict(item) for item in items]}

    def fetch_novel(job: Job, ctx: JobContext) -> dict[str, Any]:
        url = _payload_str(job, "url")
        if not adapter.matches(url):
            raise PermanentJobError("Đường dẫn không phải một truyện trên truyenfull.live.")
        novel_id: str | None = None
        count = 0
        for page in adapter.toc_pages(url):
            ctx.check()
            if novel_id is None:
                novel_id = store.upsert_novel(job.user_id, page.info)
            # Each page is committed as soon as it is read, so the first 50 chapters are
            # readable while the rest of a long table of contents is still loading.
            store.upsert_chapters(job.user_id, novel_id, page.chapters)
            count = page.chapters[-1].index
        assert novel_id is not None  # toc_pages yields at least one page or raises
        store.finish_toc(novel_id, count)
        return {"novel_id": novel_id, "chapter_count": count}

    def fetch_chapter(job: Job, ctx: JobContext) -> dict[str, Any]:
        chapter_id = _payload_str(job, "chapter_id", 64)
        try:
            uuid.UUID(chapter_id)
        except ValueError as exc:
            raise PermanentJobError("Job có chapter_id không hợp lệ.") from exc
        row = store.chapter(chapter_id, job.user_id)
        if row is None:
            raise PermanentJobError("Không tìm thấy chương này trong thư viện.")
        content = adapter.chapter(row.url)
        ctx.check()
        digest = text_hash(content.text)
        if digest != row.text_hash:
            store.save_chapter_text(row.id, content.text, digest)
        segments = segment_text(content.text)
        result = run_chain(strategies, segments, store.roster(row.novel_id))
        if not store.has_analysis(row.id, digest, result.strategy, result.version):
            store.save_analysis(
                job.user_id, row.id, digest, result.strategy, result.version,
                analysis_document(segments, result.labels),
            )  # fmt: skip
        return {"chars": len(content.text), "segments": len(segments), "strategy": result.strategy}

    return {"search": search, "fetch_novel": fetch_novel, "fetch_chapter": fetch_chapter}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_handlers.py -q`
Expected: PASS (11 tests).

Run (DB tier env loaded as in Task 7): `uv run pytest tests/test_db_store.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/store.py src/audiotruyen_worker/jobs/handlers.py tests/test_handlers.py tests/test_db_store.py
git commit -m "feat(worker): search, fetch_novel and fetch_chapter handlers with progressive TOC (spec 5.1-5.4)"
```

---

### Task 9: Realtime wake, logging, `worker run` and `worker enqueue`

**Files:**
- Create: `worker/src/audiotruyen_worker/jobs/wake.py`, `worker/src/audiotruyen_worker/logging_setup.py`, `worker/src/audiotruyen_worker/app.py`
- Modify: `worker/src/audiotruyen_worker/admin.py` (append two functions), `worker/src/audiotruyen_worker/cli.py` (full replacement below)
- Test: `worker/tests/test_cli_logging.py` (unit), `worker/tests/test_db_wake.py` (db tier, perf budget)

**Interfaces:**
- Consumes: Tasks 7-8.
- Produces: `RealtimeWake(supabase_url, api_key, wake, stop, *, check_seconds=5.0, max_backoff=60.0)` thread with `subscribed` event (sets `wake` on job INSERTs and on UPDATEs to `status=queued`, and once after every (re)subscribe; reconnects forever with backoff); `RedactingFormatter(fmt, secrets)`, `setup_logging(level, log_dir, secrets)`, `NOISY_LOGGERS`; `app.WORKER_VERSION`, `app.DEVICE = "cpu"`, `build_runner(settings) -> Runner`, `run_worker(settings, *, once=False)`; `admin.resolve_owner_id(client, email | None) -> str`, `admin.ENQUEUE_PAYLOAD_KEYS`, `admin.enqueue_job(client, user_id, job_type, value, priority=0) -> str`; CLI `worker run [--once]`, `worker enqueue {search,fetch-novel,fetch-chapter} VALUE [--email E] [--priority 0|10|20]`; `cli.LOG_DIR` = `worker/logs`.
- Perf budget (spec 7.3.2): enqueue → claim < 2 s while the worker is online, asserted by `test_db_wake.py` after a warm-up (a fresh Realtime server can miss the first changes; the 30 s poll covers that).

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_cli_logging.py`:

```python
import logging

import pytest

from audiotruyen_worker import cli
from audiotruyen_worker.admin import enqueue_job, resolve_owner_id
from audiotruyen_worker.logging_setup import RedactingFormatter, setup_logging

SECRET = "service-role-secret-value-123"


def test_formatter_redacts_messages_and_tracebacks():
    formatter = RedactingFormatter("%(message)s", [SECRET, "short"])
    try:
        raise RuntimeError(f"connect wss://x/realtime/v1/websocket?apikey={SECRET}")
    except RuntimeError:
        record = logging.LogRecord("t", logging.ERROR, __file__, 1, "key=%s", (SECRET,), None)
        import sys

        record.exc_info = sys.exc_info()
    text = formatter.format(record)
    assert SECRET not in text
    assert text.count("[redacted]") == 2
    assert "short" not in formatter._secrets  # secrets under 8 chars are ignored


def test_setup_logging_writes_file_and_silences_noisy_loggers(tmp_path):
    setup_logging("DEBUG", tmp_path, [SECRET])
    logging.getLogger("audiotruyen_worker.test").info("xin chào %s", SECRET)
    for handler in logging.getLogger().handlers:
        handler.flush()
    content = (tmp_path / "worker.log").read_text(encoding="utf-8")
    assert "xin chào [redacted]" in content and SECRET not in content
    assert logging.getLogger("realtime").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    setup_logging("INFO", tmp_path, [])  # idempotent: replaces handlers instead of stacking
    assert len(logging.getLogger().handlers) == 2
    for handler in logging.getLogger().handlers:
        handler.close()
    logging.getLogger().handlers.clear()


class _User:
    def __init__(self, id_, email):
        self.id, self.email = id_, email


class _Admin:
    def __init__(self, users):
        self.users = users

    def list_users(self, page, per_page):
        start = (page - 1) * per_page
        return self.users[start : start + per_page]


class _Client:
    def __init__(self, users):
        self.auth = type("A", (), {"admin": _Admin(users)})()
        self.inserted = []

    def table(self, name):
        client = self

        class _T:
            def insert(self, row):
                client.inserted.append((name, row))
                return self

            def execute(self):
                return type("R", (), {"data": [{"id": "job-1"}]})()

        return _T()


def test_resolve_owner_id_single_account_or_email():
    assert resolve_owner_id(_Client([_User("u1", "a@x")]), None) == "u1"
    two = _Client([_User("u1", "a@x"), _User("u2", "b@x")])
    with pytest.raises(LookupError):
        resolve_owner_id(two, None)
    assert resolve_owner_id(two, "B@x") == "u2"


def test_enqueue_job_builds_the_payload():
    client = _Client([])
    assert enqueue_job(client, "u1", "fetch_novel", "https://truyenfull.live/a/") == "job-1"
    assert client.inserted == [
        (
            "jobs",
            {
                "user_id": "u1",
                "type": "fetch_novel",
                "payload": {"url": "https://truyenfull.live/a/"},
                "priority": 0,
            },
        )
    ]
    with pytest.raises(ValueError):
        enqueue_job(client, "u1", "synthesize", "x")


def test_cli_dispatches_run_and_enqueue(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "_run", lambda once: calls.append(("run", once)) or 0)
    monkeypatch.setattr(cli, "_enqueue", lambda *a: calls.append(("enqueue", *a)) or 0)
    assert cli.main(["run", "--once"]) == 0
    assert cli.main(["enqueue", "fetch-novel", "https://truyenfull.live/a/"]) == 0
    assert calls == [
        ("run", True),
        ("enqueue", "fetch-novel", "https://truyenfull.live/a/", None, 0),
    ]


def test_log_dir_is_worker_logs():
    assert (cli.LOG_DIR.parent.name, cli.LOG_DIR.name) == ("worker", "logs")
```

Create `worker/tests/test_db_wake.py`:

```python
import threading
import time

import pytest

from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.wake import RealtimeWake

pytestmark = pytest.mark.db


def test_enqueue_to_claim_under_two_seconds_with_realtime(admin_client, owner):
    """Perf budget (7.3.2): enqueue -> claim < 2 s while the worker is online."""
    from tests.conftest import SERVICE, URL

    wake, stop = threading.Event(), threading.Event()
    listener = RealtimeWake(URL, SERVICE, wake, stop)
    listener.start()
    try:
        assert listener.subscribed.wait(20), "realtime subscription failed"
        queue = JobQueue(admin_client, "w-latency")
        # Warm-up: right after Realtime starts (fresh `supabase start`) the first changes can be
        # missed; the 30 s poll covers that in production. Wait for one real change event.
        # (SUBSCRIBED itself sets the event, so clear it before every warm-up insert.)
        warmed = False
        deadline = time.monotonic() + 30
        while not warmed and time.monotonic() < deadline:
            wake.clear()
            admin_client.table("jobs").insert(
                {"user_id": owner["id"], "type": "search", "payload": {"query": "warm"}}
            ).execute()
            warmed = wake.wait(3)
        assert warmed, "realtime never delivered a job change"
        while queue.claim(["search"]):
            pass
        for n in range(3):
            wake.clear()
            start = time.perf_counter()
            admin_client.table("jobs").insert(
                {"user_id": owner["id"], "type": "search", "payload": {"query": str(n)}}
            ).execute()
            assert wake.wait(2), "no realtime wake within 2 s"
            claimed = queue.claim(["search"])
            elapsed = time.perf_counter() - start
            assert claimed is not None and elapsed < 2.0, f"enqueue->claim took {elapsed:.2f}s"
    finally:
        stop.set()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_cli_logging.py -q`
Expected: FAIL with `ImportError` (`resolve_owner_id` / `logging_setup` do not exist).

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/jobs/wake.py`:

```python
"""Realtime wake-up (spec 5.1, 7.3.2): a background thread subscribes to queued-job inserts and
updates and sets an Event, so the loop claims within ~1 s instead of waiting for the 30 s poll.
Reconnects with backoff forever; polling keeps working while it is down."""

from __future__ import annotations

import asyncio
import logging
import threading

from realtime import AsyncRealtimeClient, RealtimeSubscribeStates

log = logging.getLogger(__name__)


class RealtimeWake(threading.Thread):
    def __init__(
        self,
        supabase_url: str,
        api_key: str,
        wake: threading.Event,
        stop: threading.Event,
        *,
        check_seconds: float = 5.0,
        max_backoff: float = 60.0,
    ) -> None:
        super().__init__(name="realtime-wake", daemon=True)
        self._url = supabase_url.rstrip("/") + "/realtime/v1"
        self._key = api_key
        self.wake = wake
        self.stop = stop
        self.subscribed = threading.Event()
        self._check_seconds = check_seconds
        self._max_backoff = max_backoff

    def run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        backoff = 1.0
        while not self.stop.is_set():
            try:
                await self._session()
                backoff = 1.0
            except Exception as exc:  # network or server error: retry with backoff
                log.warning(
                    "realtime wake disconnected (%s); polling continues", type(exc).__name__
                )
            self.subscribed.clear()
            if self.stop.wait(0):
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff)

    async def _session(self) -> None:
        client = AsyncRealtimeClient(self._url, token=self._key, auto_reconnect=False)
        try:
            await client.connect()
            channel = client.channel("worker-jobs")
            on_change = lambda _payload: self.wake.set()  # noqa: E731
            channel.on_postgres_changes("INSERT", on_change, table="jobs", schema="public")
            channel.on_postgres_changes(
                "UPDATE", on_change, table="jobs", schema="public", filter="status=eq.queued"
            )

            def on_state(state: RealtimeSubscribeStates, error: Exception | None) -> None:
                if state == RealtimeSubscribeStates.SUBSCRIBED:
                    self.subscribed.set()
                    self.wake.set()  # catch anything queued while we were disconnected
                    log.info("realtime wake subscribed")
                elif error is not None:
                    log.warning("realtime wake state %s: %s", state.value, type(error).__name__)

            await channel.subscribe(on_state)
            while not self.stop.is_set() and client.is_connected:
                await asyncio.sleep(self._check_seconds)
        finally:
            try:
                await client.close()
            except Exception:  # closing a dead socket may fail; nothing to clean up
                pass
```

Create `worker/src/audiotruyen_worker/logging_setup.py`:

```python
"""Worker logging: console + rotating file, with secrets redacted from every line."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Libraries that log URLs or payloads at DEBUG/INFO. The Realtime client logs its WebSocket URL,
# which carries the service-role key as `apikey`, so these never go below WARNING.
NOISY_LOGGERS = ("realtime", "websockets", "httpx", "httpcore", "hpack", "postgrest", "supabase")
FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


class RedactingFormatter(logging.Formatter):
    """Replaces known secret values in the fully formatted record (message and traceback)."""

    def __init__(self, fmt: str, secrets: Iterable[str]) -> None:
        super().__init__(fmt)
        self._secrets = sorted({s for s in secrets if s and len(s) >= 8}, key=len, reverse=True)

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        for secret in self._secrets:
            text = text.replace(secret, "[redacted]")
        return text


def setup_logging(level: str, log_dir: Path, secrets: Iterable[str]) -> None:
    secrets = list(secrets)
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()
    root.setLevel(level.upper())
    log_dir.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(
            log_dir / "worker.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8"
        ),
        logging.StreamHandler(),
    ]
    for handler in handlers:
        handler.setFormatter(RedactingFormatter(FORMAT, secrets))
        root.addHandler(handler)
    for name in NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
```

Create `worker/src/audiotruyen_worker/app.py`:

```python
"""`worker run`: wires the job loop, heartbeat and Realtime wake for the M2a job types."""

from __future__ import annotations

import logging
import threading
from importlib.metadata import version

from audiotruyen_worker.config import Settings
from audiotruyen_worker.db import make_client
from audiotruyen_worker.jobs.handlers import make_handlers
from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.runner import Heartbeat, Runner
from audiotruyen_worker.jobs.wake import RealtimeWake
from audiotruyen_worker.sources.truyenfull import TruyenfullAdapter
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.store import Store

log = logging.getLogger(__name__)

WORKER_VERSION = version("audiotruyen-worker")
DEVICE = "cpu"  # M2b reports cuda once VieNeu loads


def build_runner(settings: Settings) -> Runner:
    client = make_client(settings)
    handlers = make_handlers(TruyenfullAdapter(), Store(client), [HeuristicStrategy()])
    return Runner(
        JobQueue(client, settings.worker_id), handlers, version=WORKER_VERSION, device=DEVICE
    )


def run_worker(settings: Settings, *, once: bool = False) -> None:
    """Run until Ctrl+C. With once=True, drain the queue and return (no Realtime, no heartbeat)."""
    runner = build_runner(settings)
    if once:
        runner.beat()
        while runner.run_once():
            pass
        return
    stop = threading.Event()
    key = settings.supabase_service_role_key.get_secret_value()
    Heartbeat(runner, JobQueue(make_client(settings), settings.worker_id), stop).start()
    RealtimeWake(settings.supabase_url, key, runner.wake, stop).start()
    log.info("worker %s %s started (%s)", settings.worker_id, WORKER_VERSION, DEVICE)
    try:
        runner.run_forever(stop)
    finally:
        stop.set()
        log.info("worker stopped")
```

Append to `worker/src/audiotruyen_worker/admin.py` (after `set_password`, two blank lines between functions):

```python
def resolve_owner_id(client, email: str | None) -> str:
    """The owner's user id: by email, or the only account when email is None (single-user app)."""
    if email:
        return _find_user_id(client, email)
    users = client.auth.admin.list_users(page=1, per_page=2)
    if len(users) != 1:
        raise LookupError("expected exactly one account; pass --email")
    return users[0].id


ENQUEUE_PAYLOAD_KEYS = {"search": "query", "fetch_novel": "url", "fetch_chapter": "chapter_id"}


def enqueue_job(client, user_id: str, job_type: str, value: str, priority: int = 0) -> str:
    """Insert a job as the worker would (service role) and return its id."""
    key = ENQUEUE_PAYLOAD_KEYS.get(job_type)
    if key is None:
        raise ValueError(f"cannot enqueue job type {job_type!r}")
    row = {"user_id": user_id, "type": job_type, "payload": {key: value}, "priority": priority}
    return client.table("jobs").insert(row).execute().data[0]["id"]
```

Replace `worker/src/audiotruyen_worker/cli.py` with:

```python
"""Command-line entry point: `uv run worker <command>`."""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

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


LOG_DIR = Path(__file__).resolve().parents[2] / "logs"  # worker/logs (gitignored)


def _run(once: bool) -> int:
    from audiotruyen_worker.app import run_worker
    from audiotruyen_worker.logging_setup import setup_logging

    settings = load_settings()
    setup_logging(
        settings.log_level,
        LOG_DIR,
        [
            settings.supabase_service_role_key.get_secret_value(),
            settings.r2_secret_access_key.get_secret_value(),
        ],
    )
    try:
        run_worker(settings, once=once)
    except KeyboardInterrupt:
        print("Đã dừng worker.")
    return 0


def _enqueue(kind: str, value: str, email: str | None, priority: int) -> int:
    from audiotruyen_worker.admin import enqueue_job, resolve_owner_id
    from audiotruyen_worker.db import make_client

    client = make_client(load_settings())
    job_id = enqueue_job(
        client, resolve_owner_id(client, email), kind.replace("-", "_"), value, priority
    )
    print(f"Đã thêm job {kind} ({job_id}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):  # Vietnamese text on any Windows console or pipe
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="worker", description="AudioTruyen worker")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("doctor", help="check Supabase, R2 and ffmpeg connectivity")
    run = sub.add_parser("run", help="run the job loop until Ctrl+C")
    run.add_argument("--once", action="store_true", help="drain the queue once and exit")
    enqueue = sub.add_parser(
        "enqueue", help="add a job for the owner (testing without the web app)"
    )
    enqueue.add_argument("kind", choices=["search", "fetch-novel", "fetch-chapter"])
    enqueue.add_argument("value", help="search query, novel URL or chapter id")
    enqueue.add_argument("--email", help="owner email (default: the only account)")
    enqueue.add_argument("--priority", type=int, choices=[0, 10, 20], default=0)
    create = sub.add_parser("create-user", help="create the owner account (password prompted)")
    create.add_argument("--email", required=True)
    reset = sub.add_parser("set-password", help="set a new password for an existing account")
    reset.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    if args.command == "run":
        return _run(args.once)
    if args.command == "enqueue":
        return _enqueue(args.kind, args.value, args.email, args.priority)
    if args.command == "create-user":
        return _create_user(args.email)
    if args.command == "set-password":
        return _set_password(args.email)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -m "not db" -q`
Expected: PASS (all unit tests; 106 new + the 17 from M1).

Run (DB tier env loaded): `uv run pytest -m db -q`
Expected: PASS (6 from M1 + 2 + 3 + 1 = 12 tests). The wake test takes a few seconds.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/jobs/wake.py src/audiotruyen_worker/logging_setup.py src/audiotruyen_worker/app.py src/audiotruyen_worker/admin.py src/audiotruyen_worker/cli.py tests/test_cli_logging.py tests/test_db_wake.py
git commit -m "feat(worker): worker run with Realtime wake and redacted logging; worker enqueue (spec 5.1, 5.9, 7.3.2)"
```

---

### Task 10: Spec and CLAUDE.md updates, full verification, local end-to-end smoke test

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md`, `CLAUDE.md`

- [ ] **Step 1: Update the spec**

Apply these edits to `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md`:

1. Section 2.1: after the bullet that starts with "The page embeds Cloudflare Turnstile", add:

```markdown
- Re-verified 2026-10-19 while planning M2a (fixtures in `worker/tests/fixtures/truyenfull/`):
  - Current novels wrap the chapter in one `<p>` with `<br><br>` between paragraphs; older novels put text nodes directly in `#chapter-c`. Both end with two hidden `<p style="display: none">` SEO paragraphs, which the parser drops as hidden elements; the end-anchored keyword strip stays as a fallback.
  - The table of contents has 50 chapters per page at `/{slug}/trang-{n}/`; the page count is `<input id="total-page">` and the slug `<input id="truyen-ascii">`. Chapter URLs are not always `chuong-{n}` (e.g. `chuong-1-1`), so `chapters.index` is the TOC position.
  - A removed novel answers `301` to `/tim-kiem/?tukhoa=...` (reported as "not found"). Search is `/tim-kiem/?tukhoa=` with about 27 results per page.
  - Novels whose slug ends in `-free` (`...-zhihu-free`, `...-truyenfull-ai-free`) answer every non-browser request with a Cloudflare managed challenge (`403`, `cf-mitigated: challenge`, `<title>Just a moment...</title>`), even from the residential IP. The worker never tries to solve challenges, so these novels fail with `SourceBlocked` (known limitation). Normal pages embed a Turnstile comment widget (`cf-turnstile`), which is not a challenge.
  - Besides dotted obfuscation, some chapters censor words with asterisks (`g**t ch*t`).
```

2. Section 4, after the paragraph that starts with "`claim_job(worker_id text, lease_seconds int)`", add:

```markdown
M2a (migration `20261019000100`) replaces it with `claim_job(worker_id, lease_seconds, types text[] default null)` so a worker claims only job types it can run, and adds `worker_heartbeat(worker_id, version, device, job_id, lease_seconds)` (requeues expired leases, extends the current lease, upserts `worker_status`; returns false when the lease was lost), `finish_job(...)` (done/cancelled) and `fail_job(...)` (retry with `2^attempts` minutes backoff or fail). Every worker write is fenced by job id + worker id + `status = 'running'`. All are service-role only.
```

3. Section 5.1: replace the bullet "Heartbeat every 15 s: updates `worker_status`, extends `lease_until` of the current job, calls `requeue_expired_jobs()`." with:

```markdown
- Heartbeat every 15 s from its own thread: one `worker_heartbeat` RPC updates `worker_status`, extends `lease_until` of the current job and calls `requeue_expired_jobs()`. If it reports the lease as lost, the running handler is stopped at its next checkpoint and writes nothing. Ctrl+C hands the running job back to the queue (retryable) instead of waiting for the lease to expire.
- The worker claims only job types it has handlers for (M2a: `search`, `fetch_novel`, `fetch_chapter`; M2b adds `synthesize` and `cleanup_r2`).
```

4. Section 5.2: replace the line `    def novel(self, url: str) -> NovelDetail: ...          # metadata + full TOC` with `    def toc_pages(self, url: str, start_page: int = 1) -> Iterator[TocPage]: ...  # one TOC page at a time`, and replace the adapter bullets "`httpx` with a desktop browser User-Agent, ..." and "TOC: paginate ..." with:

```markdown
- `httpx` with a desktop browser User-Agent; request starts spaced 0.7 s + 0.3-0.8 s jitter (1.0-1.5 s); timeouts, transport errors, 429 and 5xx retried 3 times with 2/4/8 s backoff (`Retry-After` honoured up to 60 s); redirects followed only within truyenfull hosts.
- TOC: `toc_pages` yields one page at a time; `fetch_novel` stores each page (upsert on `(novel_id, index)`, never delete) before requesting the next, so the first 50 chapters are readable within about a second while a long TOC (41 pages for 2,000 chapters, about 50 s) keeps loading. `check_updates` (M5) starts at the page holding the last known chapter.
```

and add to the "Validation" bullet: "`ParserBroken` also when a TOC page before the last one does not hold exactly 50 chapters (protects chapter indexes); `NovelNotFound` on a redirect to the search page or a 404."

5. Section 5.3: before the numbered list, add:

```markdown
Order as implemented (M2a): segments are cut from the ORIGINAL text first, so `src` ranges are exact by construction, and each segment's text is normalized for TTS afterwards; this replaces the offset map. Normalization: NFC → de-obfuscate dotted words → restore known asterisk-censored words (unknown ones are dropped, never read as noise) → lexicon rules (before VietNormalizer, so patterns match the displayed text) → `vietnormalizer` 0.2.3 with its non-Vietnamese-word dictionary, acronym dictionary and transliteration disabled (they rewrite Vietnamese words: `nghe` → `nghê`, `long` → `lon`, `kia` → `ki-a`).
```

6. Section 5.9: replace "`uv run worker` (foreground)" with "`uv run worker run` (foreground; `--once` drains the queue and exits; `uv run worker enqueue fetch-novel <url>` adds a job for testing without the web app)".

7. Section 8, M2 row: append "Split into M2a (`docs/superpowers/plans/2026-10-19-m2a-worker-core.md`: queue hardening, job loop, truyenfull adapter, text pipeline, heuristic) and M2b (synthesis, encode, R2 ledger and uploads)."

- [ ] **Step 2: Update CLAUDE.md**

In the "Commands" section, after `uv run worker doctor ...`, add:

```
    uv run worker run             # job loop (search, fetch_novel, fetch_chapter); Ctrl+C to stop
    uv run worker run --once      # drain the queue once and exit
    uv run worker enqueue fetch-novel https://truyenfull.live/<slug>/   # test without the web app
```

and add this paragraph after the commands block:

```markdown
`worker/.env` points at the production Supabase project. To run the worker against local Supabase, override it in the shell (environment variables win over `.env`): `set -a; source <(bash scripts/supabase-test-env.sh); set +a; export SUPABASE_URL=$TEST_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$TEST_SUPABASE_SERVICE_ROLE_KEY WORKER_ID=local-dev`. In a worktree without `worker/.env`, also export dummy `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (the worker reads R2 settings at startup; nothing uploads before M2b).
```

In "Rules", add: "- Scraping goes through `sources/http.py` `PoliteClient` only (1.0-1.5 s spacing, allowed hosts); never add code that solves or bypasses Cloudflare challenges."

- [ ] **Step 3: Full verification and local smoke test**

Run from the repo root (Git Bash):

```bash
npx --yes supabase@2.121.0 db reset && npx --yes supabase@2.121.0 test db
cd worker && uv run ruff check . && uv run ruff format --check . && uv run pytest -m "not db" -q
cd .. && set -a; source <(bash scripts/supabase-test-env.sh); set +a; cd worker && uv run pytest -m db -q -rs
```

Expected: pgTAP `All tests successful.`; ruff clean; unit tier all pass; DB tier 12 passed, 0 skipped.

Smoke test against **local** Supabase and the live site (one novel with 19 chapters, two requests):

```bash
export SUPABASE_URL=$TEST_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$TEST_SUPABASE_SERVICE_ROLE_KEY WORKER_ID=local-smoke
export R2_ACCOUNT_ID=local R2_ACCESS_KEY_ID=local R2_SECRET_ACCESS_KEY=local-unused R2_BUCKET=local  # M2a never touches R2
uv run python -c "import os,secrets; from supabase import create_client; from audiotruyen_worker.admin import create_owner; c=create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY']); print(create_owner(c, 'smoke@audiotruyen.test', secrets.token_urlsafe(18)))"
uv run worker enqueue fetch-novel https://truyenfull.live/bao-long-than-tham/ --email smoke@audiotruyen.test
uv run worker run --once
```

Expected: the log shows `fetch_novel ... done`; in Supabase Studio (http://127.0.0.1:54323) `novels` has "Bảo Long Thần Thám" with `chapter_count = 19`, `status = ongoing`. Then copy the id of chapter index 1 from `chapters` and run:

```bash
uv run worker enqueue fetch-chapter <chapter-id> --email smoke@audiotruyen.test
uv run worker run --once
```

Expected: `fetch_chapter ... done`; the chapter has `text` (about 6,900 characters) and `chapter_analysis` has one `heuristic` v1 row with about 55 segments. Finally `npx --yes supabase@2.121.0 db reset` from the repo root to drop the smoke data. Record the observed numbers in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md CLAUDE.md
git commit -m "docs: M2a spec updates (truyenfull findings, worker RPCs, text pipeline order) and worker commands"
```

---

### Task 11 (controller only, not a subagent): cloud apply, merge and push

- [ ] **Step 1:** Ask the owner for approval to apply `20261019000100_m2a_jobs_hardening.sql` to the production project (CLAUDE.md "Applying migrations to cloud", step 0). Do not continue without a clear yes.
- [ ] **Step 2:** Pre-check on cloud (read-only query through the Management API): `select count(*) from public.jobs where (type = 'synthesize' and (coalesce(payload->>'chapter_id','') = '' or coalesce(payload->>'voice_hash','') = '')) or priority not in (0,10,20) or max_attempts not between 1 and 10;` must be 0 (otherwise the new checks fail and nothing is applied).
- [ ] **Step 3:** Apply per CLAUDE.md steps 1-4 (local `test db` green; list applied versions; POST the file plus `insert into supabase_migrations.schema_migrations (version, name) values ('20261019000100', 'm2a_jobs_hardening') on conflict do nothing;` in one request; verify the version, RLS on every public table, function ACLs = allow-list, no anon grants). Token only through a header file, deleted right after.
- [ ] **Step 4:** Update CLAUDE.md "Database rules" applied list to include `20261019000100`; commit on the branch.
- [ ] **Step 5:** Final review of the whole branch, merge `rework/m2a` into `main` locally, scan the diff for secrets (`.env`, keys, tokens), push `main`, confirm CI is green.
