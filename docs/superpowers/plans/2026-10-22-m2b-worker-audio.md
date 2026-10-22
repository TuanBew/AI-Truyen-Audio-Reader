# M2b Worker Audio: VieNeu Synthesis, Live Encode, R2 Uploads with Cost Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `synthesize` job turns a chapter into narrated audio: VieNeu speaks every segment (quality-guarded), one long-lived ffmpeg/libopus encoder streams WebM clusters that are uploaded to R2 while synthesis continues, and the row ends `ready` with a seekable `full.webm`; every upload is capped and ledgered, deletions clean R2, and stale audio is garbage-collected.

**Architecture:** A new migration adds the `r2_objects` ledger with an atomic reserve-before-PUT function and the monthly PUT counter, delete triggers that enqueue `cleanup_r2`, `chapter_audio.text_hash` binding audio to the chapter text, `current_voice_hash()` (spec 4.2, one implementation for worker and web) and GC candidates. The worker gains `tts/` (VieNeu provider with its own model cache, fake provider), `audio/` (incremental WebM splitter, live encoder, quality guard, post-processing, chapter renderer), `storage/guard.py` (kill switch + caps), `audio_store.py`, and the `synthesize` / `cleanup_r2` handlers; `worker run` preloads VieNeu so the first cluster is uploaded within the 10 s budget.

**Tech Stack:** Python 3.12, uv (extras `tts` / `cuda`, PyTorch cu128 index), vieneu 3.8.3 (v3 Turbo), torch 2.8.0+cu128, numpy, soundfile, boto3 (R2), ffmpeg ≥ 6 with libopus, supabase-py 2.32, pytest + moto; Supabase Postgres + pgTAP (CLI 2.121.0).

**Spec:** `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md` (sections 2.2, 4, 4.1-4.3, 5.1, 5.3 step 4, 5.6, 5.9, 5.10, 7.2, 7.3.1, 7.3.2, 7.4, 8, 9). M0 results: `docs/superpowers/spikes/2026-10-14-m0-results.md` (S2 encoder flags, S3 speed, quality metric). M2a plan (`2026-10-19-m2a-worker-core.md`) is done and merged.

## Global Constraints

- Work on branch `rework/m2b` (from `main`). Commit after every task. Never push; the controller merges to `main` and pushes after Task 12.
- Python `>=3.12,<3.13` via uv. From `worker/`: `uv run ruff check . && uv run ruff format --check .` must pass (line length 100, E/F/I/UP/B). Run `uv run ruff check --fix . && uv run ruff format .` before each commit.
- Base runtime dependencies gain exactly `numpy>=2.0` and `soundfile>=0.12`. VieNeu is optional: extra `tts = ["vieneu==3.8.3"]` (CPU/ONNX) and extra `cuda` (`vieneu[cuda]==3.8.3`, `torch==2.8.0`, `torchaudio==2.8.0`, `transformers==4.57.6`, torch/torchaudio from the `https://download.pytorch.org/whl/cu128` index). CI runs `uv sync --locked` **without** extras: no unit or DB test may import `vieneu` or `torch` (the fake provider and monkeypatched modules cover them).
- Encoder (spec 5.6, changed by this plan): `-c:a libopus -b:a 48k -ar 48000 -ac 1 -f webm -live 1 -cluster_time_limit 10000 -cluster_size_limit 50000000 -flush_packets 1`. **10 s clusters** (not 30 s): measured on the GTX 1650, 30 s clusters put the first upload at 10.75 s after job start (over the 7.3.2 budget), 10 s clusters at 5.05 s. Owner decision 2026-10-22: keep both the cluster segments and `full.webm`, 48 kbps (≈ 724 KB per audio minute, ≈ 1,300 chapters in 8 GiB).
- R2 keys (spec 4.3): `audio/{novel_id}/{chapter_id}/{voice_hash}/{attempt}/init.webm`, `.../seg-{0000}.webm`, `.../full.webm`; content type `audio/webm`; `Cache-Control: public, max-age=31536000, immutable`.
- Cost protection (spec 7.3.1) is binding: every PUT goes through `GuardedStorage.put` (kill switch `R2_UPLOADS_ENABLED`, `R2_MAX_BYTES` default 8 GiB, `R2_MAX_PUTS_PER_MONTH` default 800,000), reserved in Postgres **before** the PUT; ledger rows are never deleted; the only update sets `deleted_at` once.
- Database rules (CLAUDE.md): never edit applied migrations (`20261015000100/0200/0300`, `20261019000100/0200/0300`); the new migration is `supabase/migrations/20261022000100_m2b_audio.sql`. New functions: `revoke execute ... from public, anon, authenticated`, then grant only the intended roles; `set search_path = ''`; fully qualified names; pgTAP for every new table and function. `security definer` only where stated (cleanup trigger, `begin_chapter_audio`).
- Secrets: never print, log or commit the service-role key or R2 secrets. **`worker/.env` points at production (Supabase and R2).** Never run `worker run` / `enqueue` / `init-voices` / `gc` during development without the local overrides from Task 11 Step 3. VRAM: VieNeu is the only GPU model (≈ 0.8 GB torch peak).
- Owner-facing job errors and CLI output are Vietnamese; log lines are English. Raw exception text never reaches `jobs.error`.
- Tests: unit tier `uv run pytest -m "not db"` (needs ffmpeg with libopus on PATH; no network, no database); DB tier `uv run pytest -m db` with local Supabase (`set -a; source <(bash scripts/supabase-test-env.sh); set +a` from the repo root). pgTAP: `npx --yes supabase@2.121.0 test db` from the repo root.
- Do not touch `web/`.

## Measured while planning (2026-10-22, GTX 1650, worker scratch build of this exact code)

| What | Result |
|---|---|
| VieNeu load (warm HF cache) | GPU 28.9 s (import 6 s + load 24 s); CPU/ONNX 13.9 s |
| RTF preset "Đức Trí" | GPU 0.21-0.24; CPU ONNX fp32 0.67-0.75 |
| RTF clone (`ref_audio` narrator_angry) | GPU 0.37-0.39 (first segment 5-7 s: reference enrolment); CPU 0.97 |
| ONNX CPU load fix | Works with a dedicated HF cache (`HF_HUB_CACHE=worker/models/hf`, huggingface_hub 0.36): per-repo blob folders pass onnxruntime's external-data check; the shared hub-2.x cache does not (spike S3 failure reproduced) |
| Peak VRAM (torch) | 773 MiB |
| Live encode | ffmpeg 9.0.2 writes each finished Cluster with its size; init + cluster 0 appear together once 10 s of audio is in; decoded samples == fed samples; remux adds Duration + Cues |
| Full chapter, real VieNeu (local Supabase + local S3) | 509.6 s audio, 55 segments, 17 clusters at 30 s; ledger bytes == uploaded bytes; 724 KB per audio minute (segments + full.webm) |
| First cluster after job start (model preloaded) | 30 s clusters: 10.75 s; **10 s clusters: 5.05 s** |
| Quality guard (narrator, 60 raw takes) | ratio median 0.73e-3, p95 1.48e-3; threshold 2.5 x 0.56e-3 re-synthesizes 7 % of takes |
| R2 (real bucket) | `DeleteObjects` (Quiet, missing keys ok) and `Cache-Control` work; local Supabase S3 rejects `DeleteObjects` (so tests use moto) |

## File map

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20261022000100_m2b_audio.sql`, `supabase/tests/09_m2b_audio.test.sql`, `06_privileges.test.sql` | ledger, reserve/mark/usage/live-keys/GC functions, cleanup triggers, `chapter_audio.text_hash`, `begin_chapter_audio` v2, `current_voice_hash` | 1 |
| `worker/pyproject.toml`, `uv.lock`, `config.py`, `storage/r2.py`, `storage/guard.py`, `.env.example`, `.gitignore`, `.github/workflows/ci.yml` | deps/extras, settings, R2 API, cost guard, CI ffmpeg | 2 |
| `audio/webm_split.py`, `audio/encoder.py` | incremental WebM splitter, live encoder | 3 |
| `tts/base.py`, `tts/fake.py`, `tts/vieneu_provider.py`, `scripts/bench_tts.py` | provider contract, `--fake-tts`, VieNeu | 4 |
| `audio/quality.py`, `audio/post.py`, `audio/baselines.py` | guard metric, trim/normalize/pauses, per-voice baselines | 5 |
| `audio/render.py` | pipelined chapter renderer | 6 |
| `store.py`, `jobs/handlers.py`, `audio_store.py`, `admin.py` (init_voices) | chapter preparation shared with synthesize, audio DB access | 7 |
| `jobs/runner.py`, `jobs/synthesize.py` | `JobSkipped`, dynamic device, failure messages; synthesize handler | 8 |
| `jobs/cleanup.py` | `cleanup_r2` handler, GC | 9 |
| `app.py`, `cli.py`, `admin.py` (enqueue_synthesize), `doctor.py` | wiring, preload, CLI commands, libopus check | 10 |
| spec, CLAUDE.md | docs | 11 |

---

### Task 1: Audio migration (R2 ledger and caps, cleanup triggers, text binding, voice hash, GC)

**Files:**
- Create: `supabase/migrations/20261022000100_m2b_audio.sql`, `supabase/tests/09_m2b_audio.test.sql`
- Modify: `supabase/tests/06_privileges.test.sql` (full replacement below: new allow-lists)

**Interfaces (SQL; produces what Tasks 2, 7, 9, 10 call):**
- Tables (worker-only, RLS on, no access for anon/authenticated): `r2_objects (key text pk check (key ~ '^(audio|voices)/'), bytes bigint, created_at, deleted_at)`, `r2_monthly_puts (month date pk, puts bigint)`.
- `r2_reserve_upload(p_key text, p_bytes bigint, p_max_bytes bigint, p_max_puts bigint) returns text` → `'ok' | 'bytes_cap' | 'puts_cap'`; raises 23505 when the key was deleted before (never reused).
- `r2_mark_deleted(p_keys text[]) returns integer`; `r2_usage() returns table(live_bytes bigint, live_objects bigint, month_puts bigint)`; `r2_live_keys(p_prefix text, p_after text default '', p_limit integer default 1000) returns setof text`; `r2_gc_candidates(p_stale_after interval default '30 days', p_limit integer default 1000) returns table(key text, chapter_audio_id uuid, stale boolean)` — all service_role only.
- AFTER DELETE triggers on `novels`, `chapters`, `voices` enqueue one `cleanup_r2` job (priority 20, payload `{prefix}`) when the ledger has live keys under `audio/{novel}/`, `audio/{novel}/{chapter}/` or `voices/{voice}/`; skipped during cascades (novel gone / user gone).
- `chapter_audio.text_hash text` (new column); `begin_chapter_audio(uuid, text)` (same signature) records the chapter's `text_hash` and starts a new attempt when a `ready` row's text changed.
- `current_voice_hash(p_novel_id uuid) returns text` (16 hex chars; security invoker; executable by `authenticated` and `service_role`). Pipeline version string `m2b-1` lives here only.

- [ ] **Step 1: Write the failing pgTAP tests**

Create `supabase/tests/09_m2b_audio.test.sql`:

```sql
begin;
select plan(39);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@audiotruyen.test', '{}', '{}', now(), now());
insert into public.novels (id, user_id, source, source_novel_id, url, title) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'truyenfull', '1', 'u', 'Truyện A'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'truyenfull', '2', 'u2', 'Truyện B'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'truyenfull', '3', 'u3', 'Truyện C');
insert into public.chapters (id, user_id, novel_id, index, title, url, text, text_hash) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'C1', 'u1', 'một', 't1'),
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 2, 'C2', 'u2', 'hai', 't2'),
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 1, 'B1', 'b1', 'ba', 't3');
insert into public.voices (id, user_id, name, kind, preset_name, gender, is_default_narrator, is_default_male, is_default_female) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Đức Trí', 'preset', 'Đức Trí', 'male', true, false, false),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Thái Sơn', 'preset', 'Thái Sơn', 'male', false, true, false),
  ('dddddddd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Mỹ Duyên', 'preset', 'Mỹ Duyên', 'female', false, false, true);

-- Ledger guard
insert into public.r2_objects (key, bytes) values ('audio/x/y/h/1/init.webm', 10);
select throws_ok($$delete from public.r2_objects where key = 'audio/x/y/h/1/init.webm'$$, '42501', null, 'ledger rows cannot be deleted');
select throws_ok($$update public.r2_objects set bytes = 1 where key = 'audio/x/y/h/1/init.webm'$$, '42501', null, 'ledger bytes cannot change');
select lives_ok($$update public.r2_objects set deleted_at = now() where key = 'audio/x/y/h/1/init.webm'$$, 'deleted_at can be set once');
select throws_ok($$update public.r2_objects set deleted_at = now() where key = 'audio/x/y/h/1/init.webm'$$, '42501', null, 'deleted_at cannot be set twice');
select throws_ok($$insert into public.r2_objects (key, bytes) values ('other/k', 1)$$, '23514', null, 'keys live under audio/ or voices/');

-- Reserve: caps, idempotent bytes, deleted keys. The ledger and the PUT counter persist across
-- test runs (rows are never deleted), so caps and totals are relative to this snapshot.
create temporary table base as select * from public.r2_usage();
select is(public.r2_reserve_upload('audio/n/c/h/1/seg-0000.webm', 600, (select live_bytes from base) + 1000, (select month_puts from base) + 3), 'ok', 'first reservation ok');
select is(public.r2_reserve_upload('audio/n/c/h/1/seg-0001.webm', 500, (select live_bytes from base) + 1000, (select month_puts from base) + 3), 'bytes_cap', 'over the byte cap is refused');
select is((select count(*)::int from public.r2_objects where key = 'audio/n/c/h/1/seg-0001.webm'), 0, 'a refused upload is not recorded');
select is(public.r2_reserve_upload('audio/n/c/h/1/seg-0000.webm', 600, (select live_bytes from base) + 1000, (select month_puts from base) + 3), 'ok', 'retrying a live key is allowed');
select is((select live_bytes from public.r2_usage()), (select live_bytes from base) + 600, 'a retried key is not counted twice');
select is((select month_puts from public.r2_usage()), (select month_puts from base) + 2, 'every reservation counts a PUT');
select is(public.r2_reserve_upload('audio/n/c/h/1/seg-0002.webm', 1, (select live_bytes from base) + 1000, (select month_puts from base) + 3), 'ok', 'third PUT ok');
select is(public.r2_reserve_upload('audio/n/c/h/1/seg-0003.webm', 1, (select live_bytes from base) + 1000, (select month_puts from base) + 3), 'puts_cap', 'over the PUT cap is refused');
select throws_ok($$select public.r2_reserve_upload('audio/x/y/h/1/init.webm', 10, 1000, 100)$$, '23505', null, 'a deleted key is never reused');

-- mark deleted, live keys
select is(public.r2_mark_deleted(array['audio/n/c/h/1/seg-0000.webm', 'audio/n/c/h/1/missing']), 1, 'marks only live keys');
select is((select live_bytes from public.r2_usage()), (select live_bytes from base) + 1, 'usage drops after delete');
insert into public.r2_objects (key, bytes)
select 'audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000001/h/1/seg-' || lpad(n::text, 4, '0') || '.webm', 1
  from generate_series(0, 4) n;
select is(
  (select count(*)::int from public.r2_live_keys('audio/aaaaaaaa-0000-0000-0000-000000000001/', '', 3)), 3,
  'live keys are paged by limit'
);
select is(
  (select array_agg(k) from public.r2_live_keys('audio/aaaaaaaa-0000-0000-0000-000000000001/',
     'audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000001/h/1/seg-0002.webm', 10) k),
  array['audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000001/h/1/seg-0003.webm',
        'audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000001/h/1/seg-0004.webm'],
  'live keys continue after the given key'
);

-- Cleanup triggers
delete from public.chapters where id = 'cccccccc-0000-0000-0000-000000000002';
select is((select count(*)::int from public.jobs where type = 'cleanup_r2' and user_id = '11111111-1111-1111-1111-111111111111'), 0, 'deleting a chapter without audio enqueues nothing');
delete from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001';
select is(
  (select payload ->> 'prefix' from public.jobs where type = 'cleanup_r2' and user_id = '11111111-1111-1111-1111-111111111111'),
  'audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000001/',
  'deleting a chapter with audio enqueues its prefix'
);
select is((select row(priority, status, user_id)::text from public.jobs where type = 'cleanup_r2' and user_id = '11111111-1111-1111-1111-111111111111'),
  '(20,queued,11111111-1111-1111-1111-111111111111)', 'cleanup job is a background job of the owner');
delete from public.jobs where user_id = '11111111-1111-1111-1111-111111111111';
insert into public.r2_objects (key, bytes) values
  ('audio/aaaaaaaa-0000-0000-0000-000000000002/cccccccc-0000-0000-0000-000000000003/h/1/init.webm', 5);
delete from public.novels where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select is(
  (select array_agg(payload ->> 'prefix') from public.jobs where type = 'cleanup_r2' and user_id = '11111111-1111-1111-1111-111111111111'),
  array['audio/aaaaaaaa-0000-0000-0000-000000000002/'],
  'deleting a novel enqueues one job for the novel, none per chapter'
);
delete from public.jobs where user_id = '11111111-1111-1111-1111-111111111111';
insert into public.r2_objects (key, bytes) values ('voices/dddddddd-0000-0000-0000-000000000003/happy.wav', 5);
delete from public.voices where id = 'dddddddd-0000-0000-0000-000000000003';
select is((select payload ->> 'prefix' from public.jobs where type = 'cleanup_r2' and user_id = '11111111-1111-1111-1111-111111111111'),
  'voices/dddddddd-0000-0000-0000-000000000003/', 'deleting a voice enqueues its prefix');
insert into public.r2_objects (key, bytes) values ('audio/aaaaaaaa-0000-0000-0000-000000000003/zz/h/1/init.webm', 5);
select lives_ok($$delete from auth.users where id = '22222222-2222-2222-2222-222222222222'$$, 'deleting a user with audio does not fail');

-- Authenticated users cannot touch cleanup jobs or the ledger
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select throws_ok($$update public.jobs set status = 'cancelled' where type = 'cleanup_r2'$$, '42501', null, 'web cannot cancel cleanup jobs');
select throws_ok($$select count(*) from public.r2_objects$$, '42501', null, 'web cannot read the ledger');
reset role;

-- begin_chapter_audio binds audio to the chapter text
insert into public.chapters (id, user_id, novel_id, index, title, url, text, text_hash) values
  ('cccccccc-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 9, 'C9', 'u9', 'chín', 'h-old');
select is((select row(attempt, status)::text from public.begin_chapter_audio('cccccccc-0000-0000-0000-000000000009', 'vh')), '(1,queued)', 'new row');
select is((select text_hash from public.chapter_audio where chapter_id = 'cccccccc-0000-0000-0000-000000000009'), 'h-old', 'row records the text hash');
update public.chapter_audio set status = 'ready' where chapter_id = 'cccccccc-0000-0000-0000-000000000009';
select is((select row(attempt, status)::text from public.begin_chapter_audio('cccccccc-0000-0000-0000-000000000009', 'vh')), '(1,ready)', 'ready row for the same text is reused');
update public.chapters set text = 'chín mới', text_hash = 'h-new' where id = 'cccccccc-0000-0000-0000-000000000009';
select is((select row(attempt, status)::text from public.begin_chapter_audio('cccccccc-0000-0000-0000-000000000009', 'vh')), '(2,queued)', 'changed text starts a new attempt');
select is((select text_hash from public.chapter_audio where chapter_id = 'cccccccc-0000-0000-0000-000000000009'), 'h-new', 'new attempt records the new hash');

-- current_voice_hash
select is(length(public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001')), 16, 'voice hash has 16 hex chars');
create temporary table vh as select public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001') as h;
grant select on vh to authenticated;
select is(public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001'), (select h from vh), 'voice hash is deterministic');
insert into public.lexicon (user_id, pattern, replacement) values ('11111111-1111-1111-1111-111111111111', 'TP', 'thành phố');
select isnt(public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001'), (select h from vh), 'a lexicon rule changes the hash');
update public.lexicon set enabled = false;
select is(public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001'), (select h from vh), 'disabled rules do not count');
update public.voices set is_default_narrator = false;
select isnt(public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001'), (select h from vh), 'changing the default narrator changes the hash');
update public.voices set is_default_narrator = true where id = 'dddddddd-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select is(public.current_voice_hash('aaaaaaaa-0000-0000-0000-000000000001'), (select h from vh), 'the owner gets the same hash as the worker');
reset role;

-- GC candidates
insert into public.r2_objects (key, bytes) values
  ('audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000009/vh/1/init.webm', 1),
  ('audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000009/vh/2/init.webm', 1);
select is(
  (select array_agg(key || ':' || stale) from public.r2_gc_candidates()
    where key like 'audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000009/%'),
  array['audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000009/vh/1/init.webm:false'],
  'the superseded attempt is a GC candidate, the current one is not'
);
alter table public.chapter_audio disable trigger set_updated_at;
update public.chapter_audio set updated_at = now() - interval '31 days' where chapter_id = 'cccccccc-0000-0000-0000-000000000009';
alter table public.chapter_audio enable trigger set_updated_at;
select is(
  (select count(*)::int from public.r2_gc_candidates()
    where stale and key like 'audio/aaaaaaaa-0000-0000-0000-000000000001/cccccccc-0000-0000-0000-000000000009/%'),
  2, 'every key of a row older than 30 days with an outdated voice hash is stale'
);

select * from finish();
rollback;
```

Replace `supabase/tests/06_privileges.test.sql` with:

```sql
-- Allow-lists for table RLS and function privileges (spec 7.3.1). Extension-owned objects
-- (pgTAP itself) are excluded.
begin;
select plan(9);

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
       and has_function_privilege('anon', p.oid, 'execute')$$,
  'no public function is executable by anon'
);

select set_eq(
  $$select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('authenticated', p.oid, 'execute')$$,
  array['current_voice_hash(uuid)'],
  'authenticated executes exactly the web allow-list'
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
    'fail_job(uuid,text,text,boolean)',
    'r2_reserve_upload(text,bigint,bigint,bigint)',
    'r2_mark_deleted(text[])',
    'r2_usage()',
    'r2_live_keys(text,text,integer)',
    'r2_gc_candidates(interval,integer)',
    'current_voice_hash(uuid)'
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

select is_empty(
  $$select t || ':' || priv from unnest(array['public.r2_objects', 'public.r2_monthly_puts']) as t,
         unnest(array['select', 'insert', 'update', 'delete']) as priv
     where has_table_privilege('authenticated', t, priv)$$,
  'authenticated has no access to the R2 ledger tables'
);

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

- [ ] **Step 2: Run them to verify they fail**

Run (repo root, Docker + local stack running): `npx --yes supabase@2.121.0 db reset && npx --yes supabase@2.121.0 test db`
Expected: 09 FAILS (tables/functions do not exist), 06 FAILS on the new allow-lists; 01-05, 07, 08 pass.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261022000100_m2b_audio.sql`:

```sql
-- M2b: R2 object ledger, upload caps, cleanup on delete, audio/text binding, voice hash.
-- Spec 4.2, 4.3, 5.1, 5.6, 7.3.1.

-- 1. R2 object ledger (worker-only). Rows are never deleted; the only update sets deleted_at.
create table public.r2_objects (
  key text primary key check (key ~ '^(audio|voices)/'),
  bytes bigint not null check (bytes >= 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index r2_objects_live_prefix on public.r2_objects (key text_pattern_ops) include (bytes)
  where deleted_at is null;
alter table public.r2_objects enable row level security;
revoke all on public.r2_objects from anon, authenticated;

create function public.r2_objects_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'r2_objects rows are never deleted' using errcode = '42501';
  end if;
  if old.deleted_at is not null or new.deleted_at is null
     or new.key is distinct from old.key or new.bytes is distinct from old.bytes
     or new.created_at is distinct from old.created_at then
    raise exception 'r2_objects: only setting deleted_at once is allowed' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.r2_objects_guard() from public, anon, authenticated;
create trigger r2_objects_guard before update or delete on public.r2_objects
  for each row execute function public.r2_objects_guard();

-- 2. Monthly PUT counter (UTC calendar month; worker-only).
create table public.r2_monthly_puts (
  month date primary key,
  puts bigint not null default 0 check (puts >= 0)
);
alter table public.r2_monthly_puts enable row level security;
revoke all on public.r2_monthly_puts from anon, authenticated;

-- Reserve one upload: checks both caps and records the object and the PUT atomically, before the
-- PUT is sent (a failed PUT is counted, which errs on the safe side). Returns 'ok', 'bytes_cap'
-- or 'puts_cap'. Re-reserving a live key (a retried PUT) counts the PUT but not the bytes again.
create function public.r2_reserve_upload(p_key text, p_bytes bigint, p_max_bytes bigint, p_max_puts bigint)
returns text
language plpgsql
set search_path = ''
as $$
declare
  this_month date := date_trunc('month', now() at time zone 'utc')::date;
  existing public.r2_objects;
  is_new boolean;
  live bigint;
  puts bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('r2_reserve_upload', 0));
  select * into existing from public.r2_objects o where o.key = p_key;
  is_new := not found;
  if not is_new and existing.deleted_at is not null then
    raise exception 'r2 key % was deleted and must not be reused', p_key using errcode = '23505';
  end if;
  select coalesce(m.puts, 0) into puts from public.r2_monthly_puts m where m.month = this_month;
  if coalesce(puts, 0) + 1 > p_max_puts then
    return 'puts_cap';
  end if;
  if is_new then
    select coalesce(sum(o.bytes), 0) into live from public.r2_objects o where o.deleted_at is null;
    if live + p_bytes > p_max_bytes then
      return 'bytes_cap';
    end if;
    insert into public.r2_objects (key, bytes) values (p_key, p_bytes);
  end if;
  insert into public.r2_monthly_puts as m (month, puts) values (this_month, 1)
    on conflict (month) do update set puts = m.puts + 1;
  return 'ok';
end;
$$;

create function public.r2_mark_deleted(p_keys text[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  update public.r2_objects o set deleted_at = now()
   where o.key = any (p_keys) and o.deleted_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.r2_usage()
returns table (live_bytes bigint, live_objects bigint, month_puts bigint)
language sql
set search_path = ''
as $$
  select (select coalesce(sum(o.bytes), 0)::bigint from public.r2_objects o where o.deleted_at is null),
         (select count(*) from public.r2_objects o where o.deleted_at is null),
         (select coalesce(sum(m.puts), 0)::bigint from public.r2_monthly_puts m
           where m.month = date_trunc('month', now() at time zone 'utc')::date);
$$;

-- Live keys under a prefix, for cleanup_r2 (paged by key).
create function public.r2_live_keys(p_prefix text, p_after text default '', p_limit integer default 1000)
returns setof text
language sql
set search_path = ''
as $$
  select o.key from public.r2_objects o
   where o.deleted_at is null and o.key like p_prefix || '%' and o.key > p_after
   order by o.key
   limit least(greatest(p_limit, 1), 1000);
$$;

-- 3. Deleting a novel, chapter or voice enqueues one cleanup_r2 job for its prefix, if the
--    ledger has live objects there. Runs as postgres (security definer), which the jobs guard
--    trusts; skips when the parent novel or the owner is already gone (cascades), so deleting a
--    novel enqueues one job, not one per chapter, and deleting a user never fails on the FK.
create function public.enqueue_r2_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefix text;
begin
  if tg_table_name = 'novels' then
    prefix := 'audio/' || old.id || '/';
  elsif tg_table_name = 'chapters' then
    if not exists (select 1 from public.novels n where n.id = old.novel_id) then
      return null;
    end if;
    prefix := 'audio/' || old.novel_id || '/' || old.id || '/';
  else
    prefix := 'voices/' || old.id || '/';
  end if;
  if not exists (select 1 from auth.users u where u.id = old.user_id) then
    return null;
  end if;
  if exists (select 1 from public.r2_objects o where o.deleted_at is null and o.key like prefix || '%') then
    insert into public.jobs (user_id, type, payload, priority)
    values (old.user_id, 'cleanup_r2', jsonb_build_object('prefix', prefix), 20);
  end if;
  return null;
end;
$$;
revoke execute on function public.enqueue_r2_cleanup() from public, anon, authenticated;
create trigger novels_enqueue_r2_cleanup after delete on public.novels
  for each row execute function public.enqueue_r2_cleanup();
create trigger chapters_enqueue_r2_cleanup after delete on public.chapters
  for each row execute function public.enqueue_r2_cleanup();
create trigger voices_enqueue_r2_cleanup after delete on public.voices
  for each row execute function public.enqueue_r2_cleanup();

-- 4. Audio is bound to the chapter text it was made from. A ready row whose text_hash no longer
--    matches the chapter (re-fetched text, url reset) is re-synthesized as a new attempt.
alter table public.chapter_audio add column text_hash text;

create or replace function public.begin_chapter_audio(p_chapter_id uuid, p_voice_hash text)
returns table (id uuid, attempt integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r public.chapter_audio;
  current_hash text;
begin
  select c.text_hash into current_hash from public.chapters c where c.id = p_chapter_id;
  if not found then
    raise exception 'chapter % not found', p_chapter_id using errcode = 'no_data_found';
  end if;

  insert into public.chapter_audio (user_id, chapter_id, voice_hash, status, attempt, text_hash)
  select c.user_id, c.id, p_voice_hash, 'queued', 1, c.text_hash
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

  if r.status <> 'ready' or r.text_hash is distinct from current_hash then
    update public.chapter_audio a
       set attempt = a.attempt + 1,
           status = 'queued',
           text_hash = current_hash,
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
revoke execute on function public.begin_chapter_audio(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_chapter_audio(uuid, text) to service_role;

-- 5. voice_hash (spec 4.2), computed in one place for the worker and the web app. Security
--    invoker: the web app only sees its own rows through RLS.
create function public.current_voice_hash(p_novel_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  owner uuid;
  canonical text;
begin
  select n.user_id into owner from public.novels n where n.id = p_novel_id;
  if owner is null then
    raise exception 'novel % not found', p_novel_id using errcode = 'no_data_found';
  end if;
  select concat_ws('|',
    'pipeline=m2b-1',
    'narrator=' || coalesce((select v.id::text from public.voices v where v.user_id = owner and v.is_default_narrator), ''),
    'male=' || coalesce((select v.id::text from public.voices v where v.user_id = owner and v.is_default_male), ''),
    'female=' || coalesce((select v.id::text from public.voices v where v.user_id = owner and v.is_default_female), ''),
    'cast=' || coalesce((
      select string_agg(c.name || '=' || c.voice_id::text, ',' order by c.name)
        from public.characters c where c.novel_id = p_novel_id and c.voice_id is not null), ''),
    'lexicon=' || coalesce((
      select string_agg(
               concat_ws(':', coalesce(l.novel_id::text, '*'), l.position, l.is_regex, l.pattern, l.replacement),
               E'\n' order by l.novel_id nulls first, l.position, l.id)
        from public.lexicon l
       where l.user_id = owner and l.enabled and (l.novel_id is null or l.novel_id = p_novel_id)), '')
  ) into canonical;
  return left(encode(pg_catalog.sha256(convert_to(canonical, 'UTF8')), 'hex'), 16);
end;
$$;
revoke execute on function public.current_voice_hash(uuid) from public, anon, authenticated;
grant execute on function public.current_voice_hash(uuid) to authenticated, service_role;

-- Worker-only RPCs.
revoke execute on function public.r2_reserve_upload(text, bigint, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.r2_mark_deleted(text[]) from public, anon, authenticated;
revoke execute on function public.r2_usage() from public, anon, authenticated;
revoke execute on function public.r2_live_keys(text, text, integer) from public, anon, authenticated;
grant execute on function public.r2_reserve_upload(text, bigint, bigint, bigint) to service_role;
grant execute on function public.r2_mark_deleted(text[]) to service_role;
grant execute on function public.r2_usage() to service_role;
grant execute on function public.r2_live_keys(text, text, integer) to service_role;

-- 6. GC candidates (spec 4.2): live audio keys of attempts older than the row's current attempt
--    (abandoned re-runs), and every key of a row that is older than p_stale_after and no longer
--    has the novel's current voice_hash. stale = true marks rows the worker drops afterwards.
create function public.r2_gc_candidates(p_stale_after interval default interval '30 days', p_limit integer default 1000)
returns table (key text, chapter_audio_id uuid, stale boolean)
language sql
stable
set search_path = ''
as $$
  with live as (
    select o.key, split_part(o.key, '/', 3) as chapter_id, split_part(o.key, '/', 4) as voice_hash,
           split_part(o.key, '/', 5) as attempt
      from public.r2_objects o
     where o.deleted_at is null and o.key like 'audio/%'
  ), rows as (
    select a.id, a.chapter_id, a.voice_hash, a.attempt,
           a.updated_at < now() - p_stale_after
             and a.voice_hash <> public.current_voice_hash(c.novel_id) as stale
      from public.chapter_audio a
      join public.chapters c on c.id = a.chapter_id
  )
  select l.key, r.id, r.stale
    from live l
    join rows r on r.chapter_id::text = l.chapter_id and r.voice_hash = l.voice_hash
   where r.stale or (l.attempt ~ '^[0-9]+$' and l.attempt::integer < r.attempt)
   order by l.key
   limit least(greatest(p_limit, 1), 1000);
$$;
revoke execute on function public.r2_gc_candidates(interval, integer) from public, anon, authenticated;
grant execute on function public.r2_gc_candidates(interval, integer) to service_role;
```

Notes: in `r2_reserve_upload`, `is_new` is captured right after the first lookup because PL/pgSQL's `FOUND` is overwritten by the next `SELECT INTO` (a test failed exactly this way while planning). The cleanup trigger is `security definer` so its `jobs` insert runs as `postgres`, which `jobs_guard_write` trusts; the web app still cannot create, cancel or retry `cleanup_r2` jobs (migration 20261019000300).

- [ ] **Step 4: Run all database tests**

Run: `npx --yes supabase@2.121.0 db reset && npx --yes supabase@2.121.0 test db`
Expected: `All tests successful.` (9 files, 175 tests).
Then the worker DB tier (Git Bash, repo root): `set -a; source <(bash scripts/supabase-test-env.sh); set +a; cd worker && uv run pytest -m db -q` → 13 passed (M1/M2a tests; `begin_chapter_audio` keeps its contract for chapters without text).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261022000100_m2b_audio.sql supabase/tests/06_privileges.test.sql supabase/tests/09_m2b_audio.test.sql
git commit -m "feat(db): R2 ledger with reserve-before-PUT caps, cleanup triggers, audio text binding, voice hash (spec 4.2, 7.3.1)"
```

---

### Task 2: Dependencies, settings, R2 storage API and the cost guard

**Files:**
- Modify: `worker/pyproject.toml` (full replacement), `worker/uv.lock` (regenerated), `worker/src/audiotruyen_worker/config.py` (full replacement), `worker/src/audiotruyen_worker/storage/r2.py` (full replacement), `worker/.env.example` (append), `.gitignore` (append), `.github/workflows/ci.yml` (two inserted steps)
- Create: `worker/src/audiotruyen_worker/storage/guard.py`
- Test: `worker/tests/test_config.py` (append), `worker/tests/test_r2.py` (append), `worker/tests/test_storage_guard.py` (create)

**Interfaces:**
- `config.WORKER_ROOT: Path` (= `worker/`); `Settings` gains `r2_uploads_enabled: bool = True`, `r2_max_bytes: int = 8 GiB`, `r2_max_puts_per_month: int = 800_000`, `tts_device: Literal["auto","cuda","cpu"] = "auto"`, `models_dir: Path = WORKER_ROOT / "models"`.
- `R2Storage.put_bytes(key, data, content_type, cache_control=None) -> int`; `R2Storage.delete_many(keys: list[str]) -> None` (≤ 1000 keys, missing keys ok).
- `storage/guard.py`: `IMMUTABLE`, `UploadBlocked(Exception)` (message for the owner), `GuardedStorage(storage, client, *, enabled, max_bytes, max_puts)` with `check_enabled()` and `put(key, data, content_type) -> int` (calls RPC `r2_reserve_upload` first).

- [ ] **Step 1: Dependencies**

Replace `worker/pyproject.toml` with:

```toml
[project]
name = "audiotruyen-worker"
version = "0.3.0"
description = "AudioTruyen v2 worker: scraping, analysis, TTS and uploads"
requires-python = ">=3.12,<3.13"
dependencies = [
  "boto3>=1.35",
  "httpx>=0.28",
  "numpy>=2.0",
  "pydantic>=2.9",
  "pydantic-settings>=2.6",
  "realtime>=2.32",
  "selectolax>=1.0.1",
  "soundfile>=0.12",
  "supabase>=2.10",
  "vietnormalizer==0.2.3",
]

[project.optional-dependencies]
# Local TTS (spec 5.6). Not installed in CI: unit tests use the fake provider.
tts = ["vieneu==3.8.3"]
cuda = [
  "vieneu[cuda]==3.8.3",
  "torch==2.8.0",
  "torchaudio==2.8.0",
  "transformers==4.57.6",
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

[tool.uv.sources]
torch = [{ index = "pytorch-cu128", extra = "cuda" }]
torchaudio = [{ index = "pytorch-cu128", extra = "cuda" }]

[[tool.uv.index]]
name = "pytorch-cu128"
url = "https://download.pytorch.org/whl/cu128"
explicit = true
```

Run (from `worker/`): `uv lock && uv sync`
Expected: adds numpy and soundfile; the lock also resolves the `tts`/`cuda` extras (torch `2.8.0+cu128` from the PyTorch index, huggingface-hub 0.36.x). `uv sync` without extras installs neither vieneu nor torch.

Append to `.gitignore` (after the `worker/logs/` line under "# Worker runtime"):

```
worker/models/
```

Append to `worker/.env.example`:

```text
# Cost protection (spec 7.3.1): uploads stop when off or when a cap is reached.
R2_UPLOADS_ENABLED=true
R2_MAX_BYTES=8589934592
R2_MAX_PUTS_PER_MONTH=800000
# TTS (spec 5.6): auto (CUDA if available, else ONNX on CPU) | cuda | cpu.
# Model files download to worker/models on first use (about 1 GB).
TTS_DEVICE=auto
# MODELS_DIR=
```

In `.github/workflows/ci.yml`, insert this step right after `- uses: astral-sh/setup-uv@v6` in **both** the `worker` job and the `database` job:

```yaml
      - name: ffmpeg (libopus) for the audio tests
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg
```

- [ ] **Step 2: Write the failing tests**

Append to `worker/tests/test_config.py`:

```python
def test_cost_and_tts_defaults(env):
    from audiotruyen_worker.config import WORKER_ROOT

    settings = load_settings(_env_file=None)
    assert settings.r2_uploads_enabled is True
    assert settings.r2_max_bytes == 8 * 1024**3
    assert settings.r2_max_puts_per_month == 800_000
    assert settings.tts_device == "auto"
    assert settings.models_dir == WORKER_ROOT / "models"
    assert (WORKER_ROOT / "pyproject.toml").exists()


def test_kill_switch_and_device_from_env(env):
    env.setenv("R2_UPLOADS_ENABLED", "false")
    env.setenv("TTS_DEVICE", "cpu")
    settings = load_settings(_env_file=None)
    assert settings.r2_uploads_enabled is False and settings.tts_device == "cpu"
    env.setenv("TTS_DEVICE", "tpu")
    with pytest.raises(ValidationError):
        load_settings(_env_file=None)
```

Append to `worker/tests/test_r2.py`:

```python
def test_put_bytes_returns_size_and_sets_cache_control(storage):
    assert (
        storage.put_bytes("a.webm", b"12345", "audio/webm", cache_control="public, max-age=60") == 5
    )
    head = storage.client.head_object(Bucket="audiotruyen", Key="a.webm")
    assert head["CacheControl"] == "public, max-age=60"


def test_delete_many_removes_keys_and_ignores_missing(storage):
    for key in ("k1", "k2"):
        storage.put_bytes(key, b"1", "text/plain")
    storage.delete_many(["k1", "k2", "missing"])
    assert not storage.exists("k1") and not storage.exists("k2")
    storage.delete_many([])
    with pytest.raises(ValueError):
        storage.delete_many([f"k{i}" for i in range(1001)])
```

Create `worker/tests/test_storage_guard.py`:

```python
import pytest

from audiotruyen_worker.storage.guard import IMMUTABLE, GuardedStorage, UploadBlocked


class FakeStorage:
    def __init__(self):
        self.puts: list[tuple] = []

    def put_bytes(self, key, data, content_type, cache_control=None):
        self.puts.append((key, data, content_type, cache_control))
        return len(data)


class FakeClient:
    def __init__(self, verdict):
        self.verdict = verdict
        self.calls: list[tuple] = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        client = self

        class _R:
            def execute(self):
                return type("D", (), {"data": client.verdict})()

        return _R()


def guarded(verdict="ok", enabled=True):
    storage, client = FakeStorage(), FakeClient(verdict)
    return (
        GuardedStorage(storage, client, enabled=enabled, max_bytes=8 * 1024**3, max_puts=800_000),
        storage,
        client,
    )


def test_ok_reserves_then_puts_with_immutable_cache():
    g, storage, client = guarded()
    assert g.put("audio/a/b/h/1/init.webm", b"abc", "audio/webm") == 3
    assert client.calls == [
        (
            "r2_reserve_upload",
            {
                "p_key": "audio/a/b/h/1/init.webm",
                "p_bytes": 3,
                "p_max_bytes": 8 * 1024**3,
                "p_max_puts": 800_000,
            },
        )
    ]
    assert storage.puts == [("audio/a/b/h/1/init.webm", b"abc", "audio/webm", IMMUTABLE)]


@pytest.mark.parametrize(("verdict", "text"), [("bytes_cap", "8 GiB"), ("puts_cap", "800,000")])
def test_caps_refuse_before_any_put(verdict, text):
    g, storage, _ = guarded(verdict)
    with pytest.raises(UploadBlocked, match=text):
        g.put("audio/k", b"x", "audio/webm")
    assert storage.puts == []


def test_kill_switch_refuses_without_touching_the_database():
    g, storage, client = guarded(enabled=False)
    with pytest.raises(UploadBlocked, match="R2_UPLOADS_ENABLED"):
        g.put("audio/k", b"x", "audio/webm")
    assert client.calls == [] and storage.puts == []


def test_unexpected_verdict_is_an_error():
    g, _, _ = guarded("weird")
    with pytest.raises(RuntimeError):
        g.put("audio/k", b"x", "audio/webm")
```

- [ ] **Step 3: Run them to verify they fail**

Run: `uv run pytest tests/test_config.py tests/test_r2.py tests/test_storage_guard.py -q`
Expected: FAIL (`WORKER_ROOT` / `delete_many` / `storage.guard` missing).

- [ ] **Step 4: Write the implementation**

Replace `worker/src/audiotruyen_worker/config.py` with:

```python
"""Worker configuration from environment variables and worker/.env."""

from __future__ import annotations

import socket
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

WORKER_ROOT = Path(__file__).resolve().parents[2]  # worker/


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,  # never echo env values (secrets) in validation errors
    )

    supabase_url: str
    supabase_service_role_key: SecretStr
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: SecretStr
    r2_bucket: str
    r2_endpoint_url: str | None = None
    worker_id: str = Field(default_factory=socket.gethostname)
    log_level: str = "INFO"
    # Cost protection (spec 7.3.1): kill switch and caps checked before every R2 upload.
    r2_uploads_enabled: bool = True
    r2_max_bytes: int = 8 * 1024**3
    r2_max_puts_per_month: int = 800_000
    # TTS (spec 5.6): "auto" uses CUDA when available, else ONNX on CPU.
    tts_device: Literal["auto", "cuda", "cpu"] = "auto"
    models_dir: Path = WORKER_ROOT / "models"

    @property
    def r2_endpoint(self) -> str:
        return self.r2_endpoint_url or f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


def load_settings(**overrides) -> Settings:
    return Settings(**overrides)
```

Replace `worker/src/audiotruyen_worker/storage/r2.py` with:

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
            config=Config(
                signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}
            ),
        )
        return cls(client, settings.r2_bucket)

    def put_bytes(
        self, key: str, data: bytes, content_type: str, cache_control: str | None = None
    ) -> int:
        """Upload one object; returns its size in bytes."""
        extra = {"CacheControl": cache_control} if cache_control else {}
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, **extra
        )
        return len(data)

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

    def delete_many(self, keys: list[str]) -> None:
        """Delete up to 1000 keys in one request; missing keys are not an error."""
        if not keys:
            return
        if len(keys) > 1000:
            raise ValueError("delete_many takes at most 1000 keys")
        response = self.client.delete_objects(
            Bucket=self.bucket,
            Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True},
        )
        errors = response.get("Errors") or []
        if errors:
            first = errors[0]
            raise RuntimeError(f"R2 delete failed for {len(errors)} keys ({first.get('Code')})")
```

Create `worker/src/audiotruyen_worker/storage/guard.py`:

```python
"""Cost guard for every R2 upload (spec 7.3.1): kill switch, storage cap and monthly PUT cap.
Each upload is reserved in Postgres (`r2_reserve_upload`) before the PUT is sent, so the
`r2_objects` ledger never misses an object and concurrent uploads cannot overshoot the caps."""

from __future__ import annotations

IMMUTABLE = "public, max-age=31536000, immutable"


class UploadBlocked(Exception):
    """An upload was refused by the kill switch or a cap. The message is for the owner."""


class GuardedStorage:
    def __init__(self, storage, client, *, enabled: bool, max_bytes: int, max_puts: int) -> None:
        self._storage = storage
        self._client = client
        self.enabled = enabled
        self.max_bytes = max_bytes
        self.max_puts = max_puts

    def check_enabled(self) -> None:
        if not self.enabled:
            raise UploadBlocked(
                "Đang tắt upload lên R2 (R2_UPLOADS_ENABLED=false trong worker/.env). "
                "Bật lại rồi bấm Thử lại."
            )

    def put(self, key: str, data: bytes, content_type: str) -> int:
        self.check_enabled()
        verdict = (
            self._client.rpc(
                "r2_reserve_upload",
                {
                    "p_key": key,
                    "p_bytes": len(data),
                    "p_max_bytes": self.max_bytes,
                    "p_max_puts": self.max_puts,
                },
            )
            .execute()
            .data
        )
        if verdict == "bytes_cap":
            gib = self.max_bytes / 1024**3
            raise UploadBlocked(
                f"Kho audio trên R2 đã chạm giới hạn {gib:g} GiB. "
                "Xóa bớt truyện hoặc tăng R2_MAX_BYTES rồi bấm Thử lại."
            )
        if verdict == "puts_cap":
            raise UploadBlocked(
                f"Đã chạm giới hạn {self.max_puts:,} lần ghi R2 trong tháng này. "
                "Chờ sang tháng hoặc tăng R2_MAX_PUTS_PER_MONTH."
            )
        if verdict != "ok":
            raise RuntimeError(f"unexpected r2_reserve_upload result {verdict!r}")
        return self._storage.put_bytes(key, data, content_type, cache_control=IMMUTABLE)
```

- [ ] **Step 5: Run the tests to verify they pass, then lint and commit**

Run: `uv run pytest tests/test_config.py tests/test_r2.py tests/test_storage_guard.py -q` → PASS; `uv run pytest -m "not db" -q` → all pass.

```bash
uv run ruff check --fix . && uv run ruff format .
git add pyproject.toml uv.lock .env.example src/audiotruyen_worker/config.py src/audiotruyen_worker/storage tests/test_config.py tests/test_r2.py tests/test_storage_guard.py ../.gitignore ../.github/workflows/ci.yml
git commit -m "feat(worker): TTS extras, cost settings, R2 cache-control and batch delete, upload guard (spec 7.3.1)"
```

---

### Task 3: Incremental WebM splitter and live encoder

**Files:**
- Create: `worker/src/audiotruyen_worker/audio/__init__.py` (empty), `audio/webm_split.py`, `audio/encoder.py`
- Test: `worker/tests/test_webm_split.py`, `worker/tests/test_encoder.py`

**Interfaces:**
- `webm_split`: `WebmError(ValueError)`, `InitSegment(data)`, `ClusterSegment(index, data, timestamp_ms)`, `WebmSplitter` with `feed(bytes) -> Iterator[...]` and `finish() -> Iterator[...]`. Handles both known-size Clusters (what ffmpeg 9 writes) and unknown-size Clusters; drops emitted bytes (bounded memory).
- `encoder`: `SAMPLE_RATE = 48_000`, `CLUSTER_MS = 10_000`, `FFMPEG_ARGS` (spec 5.6 flags with 10 s clusters), `EncoderError(RuntimeError)`, `StreamEncoder(ffmpeg="ffmpeg")` with `start()`, `write(pcm)`, `close()`, `kill()`, `segments(timeout=None) -> Iterator[InitSegment | ClusterSegment]`, `samples_written`. A reader thread drains stdout; a reader failure kills ffmpeg so `write` can never block forever (this hung while planning).

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_webm_split.py`:

```python
import subprocess

import numpy as np
import pytest

from audiotruyen_worker.audio.encoder import FFMPEG_ARGS
from audiotruyen_worker.audio.webm_split import (
    ClusterSegment,
    InitSegment,
    WebmError,
    WebmSplitter,
)


def _vint(value: int, length: int) -> bytes:
    return ((1 << (7 * length)) | value).to_bytes(length, "big")


def _element(elem_id: bytes, payload: bytes) -> bytes:
    return elem_id + _vint(len(payload), 4) + payload


UNKNOWN = b"\x01\xff\xff\xff\xff\xff\xff\xff"
EBML = _element(b"\x1a\x45\xdf\xa3", b"\x42\x86\x81\x01")
INFO = _element(b"\x15\x49\xa9\x66", b"\x2a\xd7\xb1\x83\x0f\x42\x40")


def _cluster(timestamp: int, block: bytes, known: bool) -> bytes:
    body = _element(b"\xe7", timestamp.to_bytes(2, "big")) + _element(b"\xa3", block)
    if known:
        return _element(b"\x1f\x43\xb6\x75", body)
    return b"\x1f\x43\xb6\x75" + UNKNOWN + body


def _stream(known: bool) -> tuple[bytes, list[bytes]]:
    clusters = [_cluster(t, bytes([t % 251]) * 40, known) for t in (0, 10_000, 20_000)]
    return EBML + b"\x18\x53\x80\x67" + UNKNOWN + INFO, clusters


def _split(data: bytes, step: int) -> list:
    splitter = WebmSplitter()
    out = []
    for start in range(0, len(data), step):
        out.extend(splitter.feed(data[start : start + step]))
    out.extend(splitter.finish())
    return out


@pytest.mark.parametrize("known", [True, False])
@pytest.mark.parametrize("step", [1, 7, 4096])
def test_split_init_and_clusters_in_any_chunking(known, step):
    init, clusters = _stream(known)
    parts = _split(init + b"".join(clusters), step)
    assert isinstance(parts[0], InitSegment) and parts[0].data == init
    assert [p.data for p in parts[1:]] == clusters
    assert [(p.index, p.timestamp_ms) for p in parts[1:]] == [(0, 0), (1, 10_000), (2, 20_000)]


def test_known_size_cluster_is_emitted_as_soon_as_it_is_complete():
    init, clusters = _stream(known=True)
    splitter = WebmSplitter()
    first = list(splitter.feed(init + clusters[0]))
    assert [type(p) for p in first] == [InitSegment, ClusterSegment]


def test_unknown_size_cluster_waits_for_the_next_level1_element():
    init, clusters = _stream(known=False)
    splitter = WebmSplitter()
    assert [type(p) for p in splitter.feed(init + clusters[0])] == [InitSegment]
    assert [p.index for p in splitter.feed(clusters[1])] == [0]
    assert [p.index for p in splitter.finish()] == [1]


def test_errors():
    with pytest.raises(WebmError, match="not an EBML"):
        list(WebmSplitter().feed(b"\x42\x86\x81\x01" * 4))
    splitter = WebmSplitter()
    list(splitter.feed(EBML + b"\x18\x53\x80\x67" + UNKNOWN))
    with pytest.raises(WebmError, match="before the first Cluster"):
        list(splitter.finish())


def test_real_ffmpeg_live_output_round_trips():
    pcm = (0.3 * np.sin(2 * np.pi * 440 * np.arange(25 * 48_000) / 48_000)).astype("<f4")
    data = subprocess.run(
        ["ffmpeg", *FFMPEG_ARGS], input=pcm.tobytes(), capture_output=True, check=True
    ).stdout
    parts = _split(data, 3000)
    assert b"".join(p.data for p in parts) == data
    stamps = [p.timestamp_ms for p in parts[1:]]
    assert len(stamps) == 3 and stamps[0] == 0
    assert all(0 <= 10_000 * k - ts < 50 for k, ts in enumerate(stamps))  # ffmpeg cuts ~19 ms early
```

Create `worker/tests/test_encoder.py`:

```python
import json
import subprocess
import threading

import numpy as np
import pytest

from audiotruyen_worker.audio.encoder import EncoderError, StreamEncoder
from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment


def sine(seconds: float) -> np.ndarray:
    n = int(seconds * 48_000)
    return (0.3 * np.sin(2 * np.pi * 440 * np.arange(n) / 48_000)).astype(np.float32)


def test_segments_arrive_while_writing_and_decode_to_every_sample(tmp_path):
    encoder = StreamEncoder()
    encoder.start()
    seen: list = []
    fed_at_emit: list[int] = []

    def consume() -> None:
        for segment in encoder.segments(timeout=30):
            seen.append(segment)
            fed_at_emit.append(encoder.samples_written)

    reader = threading.Thread(target=consume)
    reader.start()
    for _ in range(13):  # 26 s in 2 s pieces
        encoder.write(sine(2.0))
    encoder.close()
    reader.join(30)

    assert isinstance(seen[0], InitSegment)
    clusters = [s for s in seen if isinstance(s, ClusterSegment)]
    stamps = [c.timestamp_ms for c in clusters]
    assert len(stamps) == 3 and stamps[0] == 0
    assert all(0 <= 10_000 * k - ts < 50 for k, ts in enumerate(stamps))  # cut ~19 ms early
    assert fed_at_emit[1] < encoder.samples_written  # cluster 0 left before input ended
    data = b"".join(s.data for s in seen)
    (tmp_path / "concat.webm").write_bytes(data)
    decoded = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(tmp_path / "concat.webm"),
         "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    assert len(decoded) // 4 == encoder.samples_written == 26 * 48_000
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
         str(tmp_path / "concat.webm")],
        capture_output=True, text=True, check=True,
    ).stdout  # fmt: skip
    assert "duration" not in json.loads(probe)["format"]  # live output: no Duration


def test_broken_ffmpeg_raises_instead_of_hanging():
    encoder = StreamEncoder(ffmpeg="ffmpeg")
    encoder._cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "nope", "-i", "pipe:0"]
    encoder.start()
    with pytest.raises(EncoderError):
        for _ in range(50):
            encoder.write(sine(1.0))
        encoder.close()
        list(encoder.segments(timeout=30))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_webm_split.py tests/test_encoder.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.audio'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/audio/__init__.py` (empty) and `worker/src/audiotruyen_worker/audio/webm_split.py`:

```python
"""Incremental WebM splitter (spec 4.3, 5.6): turns the live encoder's byte stream into the
shared init segment (everything before the first Cluster) and one media segment per Cluster,
each emitted as soon as it is complete. Cut points and timestamps come from the muxed stream."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

EBML_HEADER_ID = 0x1A45DFA3
SEGMENT_ID = 0x18538067
CLUSTER_ID = 0x1F43B675
TIMESTAMP_ID = 0xE7
# Segment children (level 1). Any of them ends an unknown-size Cluster.
LEVEL1_IDS = frozenset(
    {CLUSTER_ID, 0x1C53BB6B, 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1254C367, 0x1043A770, 0x1941A469}
)


class WebmError(ValueError):
    pass


@dataclass(frozen=True)
class InitSegment:
    data: bytes


@dataclass(frozen=True)
class ClusterSegment:
    index: int
    data: bytes
    timestamp_ms: int


def _vint_len(first: int) -> int:
    for length in range(1, 9):
        if first & (0x80 >> (length - 1)):
            return length
    raise WebmError("invalid EBML vint")


def _read_id(buf: bytes | bytearray, pos: int) -> tuple[int, int] | None:
    if pos >= len(buf):
        return None
    length = _vint_len(buf[pos])
    if pos + length > len(buf):
        return None
    return int.from_bytes(buf[pos : pos + length], "big"), pos + length


def _read_size(buf: bytes | bytearray, pos: int) -> tuple[int | None, int] | None:
    if pos >= len(buf):
        return None
    length = _vint_len(buf[pos])
    if pos + length > len(buf):
        return None
    value = int.from_bytes(buf[pos : pos + length], "big") & ((1 << (7 * length)) - 1)
    unknown = value == (1 << (7 * length)) - 1
    return (None if unknown else value), pos + length


def _cluster_timestamp(buf: bytes | bytearray, pos: int, end: int) -> int:
    """Timestamp child of a complete Cluster (0 if absent)."""
    while pos < end:
        head = _read_id(buf, pos)
        size = _read_size(buf, head[1]) if head else None
        if head is None or size is None or size[0] is None:
            raise WebmError("malformed Cluster child")
        if head[0] == TIMESTAMP_ID:
            return int.from_bytes(buf[size[1] : size[1] + size[0]], "big")
        pos = size[1] + size[0]
    return 0


class WebmSplitter:
    """Feed bytes with `feed()`; it yields InitSegment once, then ClusterSegment per finished
    Cluster. Call `finish()` at end of stream to flush the last Cluster."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0  # parse position in _buf
        self._state = "header"
        self._init_end: int | None = None
        self._cluster_start: int | None = None
        self._cluster_ts = 0
        self._index = 0

    def feed(self, data: bytes) -> Iterator[InitSegment | ClusterSegment]:
        self._buf += data
        yield from self._parse()

    def finish(self) -> Iterator[InitSegment | ClusterSegment]:
        yield from self._parse()
        if self._state != "segment" or self._init_end is None:
            raise WebmError("stream ended before the first Cluster")
        if self._cluster_start is not None:
            if self._pos != len(self._buf):
                raise WebmError("stream ended inside a Cluster child element")
            yield self._emit_cluster(len(self._buf))

    def _emit_cluster(self, end: int) -> ClusterSegment:
        assert self._cluster_start is not None
        segment = ClusterSegment(
            self._index, bytes(self._buf[self._cluster_start : end]), self._cluster_ts
        )
        self._index += 1
        # Drop emitted bytes so memory stays bounded for long chapters.
        del self._buf[:end]
        self._pos = max(0, self._pos - end)
        self._cluster_start = None
        return segment

    def _parse(self) -> Iterator[InitSegment | ClusterSegment]:
        buf = self._buf
        while True:
            if self._state == "header":
                head = _read_id(buf, self._pos)
                if head is None:
                    return
                elem_id, after = head
                if elem_id != EBML_HEADER_ID:
                    raise WebmError("not an EBML stream")
                size = _read_size(buf, after)
                if size is None or size[0] is None or size[1] + size[0] > len(buf):
                    return
                self._pos = size[1] + size[0]
                self._state = "segment_header"
            elif self._state == "segment_header":
                head = _read_id(buf, self._pos)
                if head is None:
                    return
                elem_id, after = head
                if elem_id != SEGMENT_ID:
                    raise WebmError(f"expected Segment, got 0x{elem_id:X}")
                size = _read_size(buf, after)
                if size is None:
                    return
                self._pos = size[1]
                self._state = "segment"
            else:
                head = _read_id(buf, self._pos)
                if head is None:
                    return
                elem_id, after = head
                size = _read_size(buf, after)
                if size is None:
                    return
                length, data_start = size
                if self._cluster_start is not None and elem_id in LEVEL1_IDS:
                    yield self._emit_cluster(self._pos)
                    continue  # re-read this element at its new position
                if elem_id == CLUSTER_ID:
                    if self._init_end is None:
                        self._init_end = self._pos
                        init = InitSegment(bytes(buf[: self._pos]))
                        del buf[: self._pos]
                        self._pos = 0
                        yield init
                        continue
                    if length is not None:
                        # ffmpeg writes each finished Cluster in one piece with its size.
                        if data_start + length > len(buf):
                            return
                        self._cluster_start = self._pos
                        self._cluster_ts = _cluster_timestamp(buf, data_start, data_start + length)
                        yield self._emit_cluster(data_start + length)
                        continue
                    self._cluster_start = self._pos
                    self._cluster_ts = 0
                    self._pos = data_start
                    continue
                if length is None:
                    raise WebmError(f"unknown-size element 0x{elem_id:X}")
                if data_start + length > len(buf):
                    return
                if elem_id == TIMESTAMP_ID and self._cluster_start is not None:
                    self._cluster_ts = int.from_bytes(buf[data_start : data_start + length], "big")
                if self._cluster_start is None and self._init_end is not None:
                    raise WebmError(
                        f"unexpected level-1 element 0x{elem_id:X} after the init segment"
                    )
                self._pos = data_start + length
```

Create `worker/src/audiotruyen_worker/audio/encoder.py`:

```python
"""Long-lived ffmpeg/libopus encoder (spec 5.6): float32 mono 48 kHz PCM in on stdin, live WebM
out on stdout, split into init + cluster segments as they appear."""

from __future__ import annotations

import queue
import subprocess
import threading
from collections.abc import Iterator

import numpy as np

from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment, WebmSplitter

SAMPLE_RATE = 48_000
CLUSTER_MS = 10_000

FFMPEG_ARGS = [
    "-hide_banner", "-loglevel", "error",
    "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
    "-c:a", "libopus", "-b:a", "48k", "-ar", str(SAMPLE_RATE), "-ac", "1",
    "-f", "webm", "-live", "1",
    "-cluster_time_limit", str(CLUSTER_MS), "-cluster_size_limit", "50000000",
    "-flush_packets", "1", "pipe:1",
]  # fmt: skip

_DONE = object()


class EncoderError(RuntimeError):
    pass


class StreamEncoder:
    """Start with `start()`, `write(pcm)` segments in order, then `close()`. Finished segments
    are read from `segments()` (blocking iterator, ends after close). A reader thread drains
    stdout so writes can never deadlock on a full pipe."""

    def __init__(self, ffmpeg: str = "ffmpeg") -> None:
        self._cmd = [ffmpeg, *FFMPEG_ARGS]
        self._proc: subprocess.Popen[bytes] | None = None
        self._out: queue.Queue[object] = queue.Queue()
        self._reader: threading.Thread | None = None
        self._stderr = b""
        self.samples_written = 0

    def start(self) -> None:
        self._proc = subprocess.Popen(
            self._cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self._reader = threading.Thread(target=self._read, name="encoder-reader", daemon=True)
        self._reader.start()

    def _read(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        splitter = WebmSplitter()
        try:
            while chunk := self._proc.stdout.read1(65536):
                for segment in splitter.feed(chunk):
                    self._out.put(segment)
            for segment in splitter.finish():
                self._out.put(segment)
        except Exception as exc:  # surfaced to the consumer of segments()
            self._out.put(exc)
            self.kill()  # nobody drains stdout any more; never leave the writer blocked
        finally:
            self._out.put(_DONE)

    def write(self, pcm: np.ndarray) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        data = np.ascontiguousarray(pcm, dtype="<f4").tobytes()
        try:
            self._proc.stdin.write(data)
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise EncoderError(f"ffmpeg stopped: {self._drain_stderr()}") from exc
        self.samples_written += len(pcm)

    def close(self) -> None:
        """Signal end of input. Segments keep arriving until the iterator ends."""
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.close()

    def kill(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.kill()

    def _drain_stderr(self) -> str:
        if self._proc and self._proc.stderr and not self._stderr:
            try:
                self._stderr = self._proc.stderr.read() or b""
            except (OSError, ValueError):
                pass
        return self._stderr.decode("utf-8", "replace").strip()[-500:]

    def segments(self, timeout: float | None = None) -> Iterator[InitSegment | ClusterSegment]:
        while True:
            item = self._out.get(timeout=timeout)
            if item is _DONE:
                break
            if isinstance(item, Exception):
                raise EncoderError(str(item)) from item
            yield item  # type: ignore[misc]
        assert self._proc is not None
        code = self._proc.wait()
        if code != 0:
            raise EncoderError(f"ffmpeg exited with {code}: {self._drain_stderr()}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_webm_split.py tests/test_encoder.py -q`
Expected: PASS (12 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/audio tests/test_webm_split.py tests/test_encoder.py
git commit -m "feat(worker): live Opus encoder with incremental WebM cluster splitting (spec 5.6)"
```

---

### Task 4: TTS providers (contract, fake, VieNeu) and the benchmark script

**Files:**
- Create: `worker/src/audiotruyen_worker/tts/__init__.py` (empty), `tts/base.py`, `tts/fake.py`, `tts/vieneu_provider.py`, `worker/scripts/bench_tts.py`
- Test: `worker/tests/test_tts.py`

**Interfaces:**
- `tts/base.py`: `SAMPLE_RATE`, `NEUTRAL_TEMPERATURE = 0.8`, `MAX_TEMPERATURE = 0.95`, `VoiceRef(voice_id, preset=None, ref_path=None)`, `TTSProvider` protocol (`name`, `sample_rate`, `device`, `synthesize(text, voice, emotion, intensity) -> np.ndarray` float32 mono 48 kHz), `temperature_for(emotion, intensity) -> float`.
- `tts/fake.py`: `FakeTTS` (`name = "fake"`, `device = "fake"`): sine tone, 0.055 s per character (min 0.3 s), frequency stable per voice.
- `tts/vieneu_provider.py`: `TTSUnavailable(RuntimeError)`; `VieneuProvider(models_dir, device="auto")` with `load()` (thread-safe, once; sets `HF_HUB_CACHE=models_dir/hf` before importing vieneu; `cuda` → `Vieneu(device="cuda", backend="pytorch")`, `cpu` → `Vieneu(device="cpu", backend="onnx")`), `device` (`"loading"` until loaded), `synthesize` (`voice=` preset or `ref_audio=` clone; temperature from `temperature_for`).

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_tts.py`:

```python
import os
import sys
import types

import numpy as np
import pytest

from audiotruyen_worker.tts.base import VoiceRef, temperature_for
from audiotruyen_worker.tts.fake import FakeTTS
from audiotruyen_worker.tts.vieneu_provider import TTSUnavailable, VieneuProvider


def test_fake_tts_length_follows_text_and_tone_is_stable_per_voice():
    tts = FakeTTS()
    short = tts.synthesize("a", VoiceRef("v1"), "neutral", 0.0)
    long = tts.synthesize("x" * 100, VoiceRef("v1"), "neutral", 0.0)
    assert len(short) == int(0.3 * 48_000)
    assert len(long) == int(5.5 * 48_000)
    assert short.dtype == np.float32 and float(np.max(np.abs(long))) <= 0.2 + 1e-6
    assert np.array_equal(long, tts.synthesize("x" * 100, VoiceRef("v1"), "sad", 1.0))


@pytest.mark.parametrize(
    ("emotion", "intensity", "expected"),
    [("neutral", 1.0, 0.8), ("angry", 0.0, 0.8), ("angry", 0.5, 0.875), ("shout", 1.0, 0.95),
     ("sad", 7.0, 0.95)],
)  # fmt: skip
def test_temperature(emotion, intensity, expected):
    assert temperature_for(emotion, intensity) == pytest.approx(expected)


class _FakeVieneu:
    instances: list = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.backend = kwargs["backend"]
        self.sample_rate = 48_000
        self.calls: list = []
        _FakeVieneu.instances.append(self)

    def infer(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return np.ones(480, dtype=np.float64)


@pytest.fixture
def fake_vieneu(monkeypatch, tmp_path):
    _FakeVieneu.instances = []
    monkeypatch.setitem(sys.modules, "vieneu", types.SimpleNamespace(Vieneu=_FakeVieneu))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    return tmp_path


def test_provider_uses_its_own_hf_cache_and_onnx_on_cpu(fake_vieneu):
    provider = VieneuProvider(fake_vieneu, device="cpu")
    assert provider.device == "loading"
    audio = provider.synthesize("xin chào", VoiceRef("v", preset="Đức Trí"), "neutral", 0.0)
    assert os.environ["HF_HUB_CACHE"] == str(fake_vieneu / "hf")
    (instance,) = _FakeVieneu.instances
    assert instance.kwargs == {"device": "cpu", "backend": "onnx"}
    assert instance.calls == [("xin chào", {"temperature": 0.8, "voice": "Đức Trí"})]
    assert audio.dtype == np.float32 and provider.device == "cpu"


def test_provider_loads_once_and_clones_from_ref(fake_vieneu):
    provider = VieneuProvider(fake_vieneu, device="cuda")
    provider.load()
    provider.synthesize("a", VoiceRef("v", preset="P", ref_path="angry.wav"), "angry", 1.0)
    (instance,) = _FakeVieneu.instances
    assert instance.kwargs == {"device": "cuda", "backend": "pytorch"}
    assert instance.calls[0][1] == {"temperature": 0.95, "ref_audio": "angry.wav"}
    with pytest.raises(ValueError):
        provider.synthesize("a", VoiceRef("v"), "neutral", 0.0)


def test_provider_reports_missing_vieneu(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "vieneu", None)  # import fails
    with pytest.raises(TTSUnavailable):
        VieneuProvider(tmp_path).load()


def test_provider_rejects_unknown_device(tmp_path):
    with pytest.raises(ValueError):
        VieneuProvider(tmp_path, device="tpu")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_tts.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'audiotruyen_worker.tts'`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/tts/__init__.py` (empty) and `worker/src/audiotruyen_worker/tts/base.py`:

```python
"""TTS provider contract (spec 5.6)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np

SAMPLE_RATE = 48_000
NEUTRAL_TEMPERATURE = 0.8
MAX_TEMPERATURE = 0.95


@dataclass(frozen=True)
class VoiceRef:
    """A voice to speak with: a VieNeu preset (no clone) or a reference clip to clone from."""

    voice_id: str
    preset: str | None = None
    ref_path: str | None = None


class TTSProvider(Protocol):
    name: str
    sample_rate: int

    @property
    def device(self) -> str: ...

    def synthesize(self, text: str, voice: VoiceRef, emotion: str, intensity: float) -> np.ndarray:
        """float32 mono at `sample_rate`."""
        ...


def temperature_for(emotion: str, intensity: float) -> float:
    """0.8 for neutral speech, up to 0.95 scaled by intensity for expressive segments."""
    if emotion == "neutral":
        return NEUTRAL_TEMPERATURE
    level = min(max(intensity, 0.0), 1.0)
    return round(NEUTRAL_TEMPERATURE + (MAX_TEMPERATURE - NEUTRAL_TEMPERATURE) * level, 3)
```

Create `worker/src/audiotruyen_worker/tts/fake.py`:

```python
"""`--fake-tts` (spec 5.9): sine tones whose length follows the text, for tests and E2E runs."""

from __future__ import annotations

import zlib

import numpy as np

from audiotruyen_worker.tts.base import SAMPLE_RATE, VoiceRef

SECONDS_PER_CHAR = 0.055
MIN_SECONDS = 0.3


class FakeTTS:
    name = "fake"
    sample_rate = SAMPLE_RATE
    device = "fake"

    def synthesize(self, text: str, voice: VoiceRef, emotion: str, intensity: float) -> np.ndarray:
        seconds = max(MIN_SECONDS, SECONDS_PER_CHAR * len(text))
        n = int(seconds * SAMPLE_RATE)
        freq = 180 + zlib.crc32(voice.voice_id.encode()) % 220  # stable per voice
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        envelope = np.minimum(1.0, np.minimum(t, seconds - t) / 0.02)  # 20 ms fades, no clicks
        return (0.2 * np.sin(2 * np.pi * freq * t) * envelope).astype(np.float32)
```

Create `worker/src/audiotruyen_worker/tts/vieneu_provider.py`:

```python
"""VieNeu-TTS v3 Turbo provider (spec 2.2, 5.6). Needs the `cuda` (GPU) or `tts` (CPU, ONNX)
extra. Model files live in a dedicated Hugging Face cache under worker/models: huggingface_hub
<1.0 keeps each repo's blobs in its own folder, which onnxruntime's external-data check accepts
(the shared sharded cache of hub 2.x broke the ONNX CPU path in spike S3)."""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path

import numpy as np

from audiotruyen_worker.tts.base import SAMPLE_RATE, VoiceRef, temperature_for

log = logging.getLogger(__name__)


class TTSUnavailable(RuntimeError):
    pass


def _use_cache(cache_dir: Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = str(cache_dir)
    hub = sys.modules.get("huggingface_hub.constants")
    if hub is not None:  # imported earlier: its module-level default was read already
        hub.HF_HUB_CACHE = str(cache_dir)


def _cuda_available() -> bool:
    try:
        import torch
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


class VieneuProvider:
    name = "vieneu"
    sample_rate = SAMPLE_RATE

    def __init__(self, models_dir: Path, device: str = "auto") -> None:
        if device not in ("auto", "cuda", "cpu"):
            raise ValueError(f"bad TTS device {device!r}")
        self._models_dir = models_dir
        self._requested = device
        self._device: str | None = None
        self._tts = None
        self._lock = threading.Lock()

    @property
    def device(self) -> str:
        return self._device or "loading"

    def load(self) -> None:
        """Load the model once (thread-safe). Called in the background at worker start."""
        with self._lock:
            if self._tts is not None:
                return
            _use_cache(self._models_dir / "hf")
            try:
                from vieneu import Vieneu
            except ImportError as exc:
                raise TTSUnavailable("vieneu is not installed (uv sync --extra cuda)") from exc
            device = self._requested
            if device == "auto":
                device = "cuda" if _cuda_available() else "cpu"
            if device == "cuda":
                tts = Vieneu(device="cuda", backend="pytorch")
            else:
                tts = Vieneu(device="cpu", backend="onnx")
            if tts.sample_rate != SAMPLE_RATE:
                raise TTSUnavailable(f"unexpected sample rate {tts.sample_rate}")
            self._tts, self._device = tts, device
            log.info("VieNeu loaded (device=%s, backend=%s)", device, tts.backend)

    def synthesize(self, text: str, voice: VoiceRef, emotion: str, intensity: float) -> np.ndarray:
        self.load()
        assert self._tts is not None
        kwargs: dict = {"temperature": temperature_for(emotion, intensity)}
        if voice.ref_path:
            kwargs["ref_audio"] = voice.ref_path
        elif voice.preset:
            kwargs["voice"] = voice.preset
        else:
            raise ValueError(f"voice {voice.voice_id} has neither a preset nor a reference clip")
        audio = self._tts.infer(text, **kwargs)
        return np.asarray(audio, dtype=np.float32).reshape(-1)
```

Create `worker/scripts/bench_tts.py` (manual; needs `uv sync --extra cuda`; not run in tests):

```python
"""Re-measure VieNeu speed on this machine (spec 2.2, 5.6): load time, preset RTF, clone RTF.

Run from worker/ (GPU):  uv run --extra cuda python scripts/bench_tts.py
CPU / ONNX:              uv run --extra cuda python scripts/bench_tts.py --device cpu
RTF = synthesis seconds / audio seconds (< 1 is faster than real time).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from audiotruyen_worker.config import WORKER_ROOT, load_settings
from audiotruyen_worker.sources.truyenfull_parse import parse_chapter_page
from audiotruyen_worker.text.normalize import normalize_for_tts
from audiotruyen_worker.text.segment import segment_text
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.vieneu_provider import VieneuProvider

FIXTURE = WORKER_ROOT / "tests" / "fixtures" / "truyenfull" / "chapter_new_354.html"
REF = WORKER_ROOT.parent / "assets" / "voice-refs" / "m0" / "refs" / "narrator_angry.wav"


def bench(provider: VieneuProvider, texts: list[str], voice: VoiceRef, emotion: str) -> str:
    audio_s, first = 0.0, None
    start = time.perf_counter()
    for text in texts:
        t0 = time.perf_counter()
        audio_s += len(provider.synthesize(text, voice, emotion, 0.5)) / provider.sample_rate
        first = first if first is not None else time.perf_counter() - t0
    elapsed = time.perf_counter() - start
    rtf = elapsed / audio_s
    return f"{len(texts)} segments, {audio_s:.1f} s audio, RTF {rtf:.2f}, first {first:.2f} s"


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--segments", type=int, default=12)
    parser.add_argument("--ref", type=Path, default=REF)
    args = parser.parse_args()
    text = parse_chapter_page(FIXTURE.read_text(encoding="utf-8")).text
    texts = [t for t in (normalize_for_tts(s.text) for s in segment_text(text)) if t]
    texts = texts[: args.segments]
    provider = VieneuProvider(load_settings().models_dir, args.device)
    start = time.perf_counter()
    provider.load()
    print(f"device {provider.device}, load {time.perf_counter() - start:.1f} s")
    print("preset Đức Trí:", bench(provider, texts, VoiceRef("n", preset="Đức Trí"), "neutral"))
    clone = VoiceRef("n", preset="Đức Trí", ref_path=str(args.ref))
    print(f"clone {args.ref.name}:", bench(provider, texts, clone, "angry"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_tts.py -q`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/tts scripts/bench_tts.py tests/test_tts.py
git commit -m "feat(worker): TTS provider contract, fake TTS and VieNeu provider with its own model cache (spec 5.6, 5.9)"
```

---

### Task 5: Quality guard, post-processing and per-voice baselines

**Files:**
- Create: `worker/src/audiotruyen_worker/audio/quality.py`, `audio/post.py`, `audio/baselines.py`
- Test: `worker/tests/test_audio_quality_post.py`

**Interfaces:**
- `quality`: `GUARD_FACTOR = 2.5`, `hf_ratio(pcm) -> float | None` (M0 metric: 40 ms Hann, hop 20 ms, frames with RMS ≥ 0.03 and ZCR ≤ 0.06, median of power(4-12 kHz)/power(0-4 kHz)), `is_noisy(ratio, baseline) -> bool`.
- `post`: `PAUSE_MS` (neutral 250, sad/tender 450, angry/shout 150, others 250), `PARAGRAPH_EXTRA_MS = 200`, `pause_ms(emotion, paragraph_end)`, `trim(pcm)`, `normalize(pcm)` (RMS 0.1, peak ≤ 0.97), `finish_segment(pcm, emotion, paragraph_end) -> (pcm, speech_samples)`.
- `baselines`: `BASE_CLIPS_DIR` (`assets/voice-refs/m0/base`), `BASE_CLIPS` (Đức Trí/Thái Sơn/Mỹ Duyên → narrator/male/female.wav), `DEFAULT_BASELINE = 0.6e-3`, `Baselines(tts, clips_dir=BASE_CLIPS_DIR)` callable `(VoiceRef) -> float`, cached; other presets calibrated once; failures fall back to the default (never block synthesis).

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_audio_quality_post.py`:

```python
from pathlib import Path

import numpy as np
import pytest

from audiotruyen_worker.audio.baselines import BASE_CLIPS_DIR, DEFAULT_BASELINE, Baselines
from audiotruyen_worker.audio.post import (
    PEAK_LIMIT,
    TARGET_RMS,
    finish_segment,
    normalize,
    pause_ms,
    trim,
)
from audiotruyen_worker.audio.quality import hf_ratio, is_noisy
from audiotruyen_worker.tts.base import VoiceRef

SR = 48_000


def tone(seconds: float, freq: float = 220.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def test_hf_ratio_rises_with_hiss():
    rng = np.random.default_rng(1)
    clean = tone(1.0)
    hiss = clean + rng.normal(0, 0.01, clean.shape).astype(np.float32)
    assert hf_ratio(clean) < 1e-4
    assert hf_ratio(hiss) > 10 * hf_ratio(clean)


def test_hf_ratio_skips_silence_and_short_audio():
    assert hf_ratio(np.zeros(SR, dtype=np.float32)) is None
    assert hf_ratio(tone(0.01)) is None


@pytest.mark.parametrize(
    ("clip", "expected"),
    [("narrator.wav", 0.56e-3), ("male.wav", 0.64e-3), ("female.wav", 0.41e-3)],
)
def test_archived_base_clips_reproduce_the_m0_baselines(clip, expected):
    import soundfile as sf

    audio, rate = sf.read(BASE_CLIPS_DIR / clip, dtype="float32")
    assert rate == SR
    assert hf_ratio(audio) == pytest.approx(expected, abs=0.01e-3)


def test_is_noisy_threshold():
    assert is_noisy(1.5e-3, 0.56e-3) and not is_noisy(1.3e-3, 0.56e-3) and not is_noisy(None, 1e-3)


class _CountingTTS:
    name, sample_rate, device = "count", SR, "cpu"

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        return tone(1.0)


def test_baselines_use_archived_clips_then_calibrate_once_then_default(tmp_path):
    tts = _CountingTTS()
    baselines = Baselines(tts)
    assert baselines(VoiceRef("v1", preset="Đức Trí")) == pytest.approx(0.56e-3, abs=0.01e-3)
    other = VoiceRef("v2", preset="Hải Đăng")
    first = baselines(other)
    assert baselines(other) == first and tts.calls == 1  # calibrated once, cached
    assert Baselines(tts, clips_dir=Path(tmp_path))(VoiceRef("v3", ref_path="missing.wav")) == (
        DEFAULT_BASELINE
    )


def test_trim_keeps_speech_with_a_small_pad():
    audio = np.concatenate([np.zeros(SR), tone(0.5), np.zeros(SR)])
    out = trim(audio)
    assert int(0.5 * SR) <= len(out) <= int(0.5 * SR) + 2 * int(0.02 * SR) + 2
    assert len(trim(np.zeros(100, dtype=np.float32))) == 0


def test_normalize_reaches_target_and_respects_the_peak_limit():
    quiet = normalize(tone(0.5, amp=0.01))
    assert float(np.sqrt(np.mean(quiet**2))) == pytest.approx(TARGET_RMS, rel=0.01)
    spiky = np.zeros(SR, dtype=np.float32)
    spiky[100] = 0.5
    assert float(np.max(np.abs(normalize(spiky)))) == pytest.approx(PEAK_LIMIT)


@pytest.mark.parametrize(
    ("emotion", "paragraph_end", "expected"),
    [("neutral", False, 250), ("sad", False, 450), ("tender", True, 650), ("angry", False, 150),
     ("shout", True, 350), ("happy", False, 250)],
)  # fmt: skip
def test_pause_by_emotion(emotion, paragraph_end, expected):
    assert pause_ms(emotion, paragraph_end) == expected


def test_finish_segment_reports_speech_length():
    pcm, speech = finish_segment(tone(0.5), "neutral", False)
    assert len(pcm) == speech + 250 * SR // 1000
    assert pcm.dtype == np.float32
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_audio_quality_post.py -q`
Expected: FAIL with `ModuleNotFoundError` (`audio.quality`).

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/audio/quality.py`:

```python
"""Segment quality guard metric (spec 5.6, M0 "S1 female-noise debug"): median over vowel-like
frames of power(4-12 kHz) / power(0-4 kHz). Higher means more hiss."""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 48_000
FRAME = int(0.040 * SAMPLE_RATE)  # 40 ms Hann frames
HOP = int(0.020 * SAMPLE_RATE)  # 20 ms hop
MIN_RMS = 0.03
MAX_ZCR = 0.06
GUARD_FACTOR = 2.5  # re-synthesize when ratio > 2.5 x the voice baseline (tune on real chapters)

_WINDOW = np.hanning(FRAME).astype(np.float32)
_FREQS = np.fft.rfftfreq(FRAME, 1.0 / SAMPLE_RATE)
_LOW = _FREQS < 4000
_HIGH = (_FREQS >= 4000) & (_FREQS < 12000)


def hf_ratio(pcm: np.ndarray) -> float | None:
    """Median HF/LF power ratio over vowel-like frames, or None when no frame qualifies
    (very short or whispered segments skip the guard)."""
    x = np.asarray(pcm, dtype=np.float32)
    if x.ndim != 1:
        raise ValueError("mono audio expected")
    if len(x) < FRAME:
        return None
    count = 1 + (len(x) - FRAME) // HOP
    frames = np.lib.stride_tricks.sliding_window_view(x, FRAME)[::HOP][:count]
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    signs = np.signbit(frames)
    zcr = np.mean(signs[:, 1:] != signs[:, :-1], axis=1)
    keep = (rms >= MIN_RMS) & (zcr <= MAX_ZCR)
    if not keep.any():
        return None
    spectrum = np.abs(np.fft.rfft(frames[keep] * _WINDOW, axis=1)) ** 2
    low = spectrum[:, _LOW].sum(axis=1)
    high = spectrum[:, _HIGH].sum(axis=1)
    ratios = high / np.maximum(low, 1e-12)
    return float(np.median(ratios))


def is_noisy(ratio: float | None, baseline: float) -> bool:
    return ratio is not None and ratio > GUARD_FACTOR * baseline
```

Create `worker/src/audiotruyen_worker/audio/post.py`:

```python
"""Per-segment post-processing (spec 5.6): trim silence, normalize loudness, append the pause."""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 48_000
TARGET_RMS = 0.1  # about -20 dBFS
PEAK_LIMIT = 0.97
SILENCE = 0.01  # |x| below this at the edges is trimmed
EDGE_PAD = int(0.02 * SAMPLE_RATE)  # keep 20 ms around speech so onsets are not clipped

PAUSE_MS = {"neutral": 250, "sad": 450, "tender": 450, "angry": 150, "shout": 150}
DEFAULT_PAUSE_MS = 250
PARAGRAPH_EXTRA_MS = 200


def pause_ms(emotion: str, paragraph_end: bool) -> int:
    return PAUSE_MS.get(emotion, DEFAULT_PAUSE_MS) + (PARAGRAPH_EXTRA_MS if paragraph_end else 0)


def trim(pcm: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(pcm) >= SILENCE)
    if loud.size == 0:
        return pcm[:0]
    start = max(0, int(loud[0]) - EDGE_PAD)
    end = min(len(pcm), int(loud[-1]) + 1 + EDGE_PAD)
    return pcm[start:end]


def normalize(pcm: np.ndarray) -> np.ndarray:
    if pcm.size == 0:
        return pcm
    rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
    if rms < 1e-6:
        return pcm
    out = pcm * (TARGET_RMS / rms)
    peak = float(np.max(np.abs(out)))
    if peak > PEAK_LIMIT:
        out = out * (PEAK_LIMIT / peak)
    return out.astype(np.float32)


def finish_segment(pcm: np.ndarray, emotion: str, paragraph_end: bool) -> tuple[np.ndarray, int]:
    """Trimmed, normalized speech followed by the emotion/paragraph pause (float32 mono), and
    the number of speech samples before the pause (for segment timings)."""
    speech = normalize(trim(np.asarray(pcm, dtype=np.float32)))
    silence = np.zeros(pause_ms(emotion, paragraph_end) * SAMPLE_RATE // 1000, dtype=np.float32)
    return np.concatenate([speech, silence]), len(speech)
```

Create `worker/src/audiotruyen_worker/audio/baselines.py`:

```python
"""Quality-guard baselines per voice (spec 5.6): the HF ratio of the voice's neutral reference.
For the three default presets that is the archived M0 base clip; other presets are calibrated
once with a fixed sentence; clone voices use their reference clip. Cached per voice."""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from audiotruyen_worker.audio.quality import hf_ratio
from audiotruyen_worker.config import WORKER_ROOT
from audiotruyen_worker.tts.base import TTSProvider, VoiceRef

log = logging.getLogger(__name__)

BASE_CLIPS_DIR = WORKER_ROOT.parent / "assets" / "voice-refs" / "m0" / "base"
BASE_CLIPS = {"Đức Trí": "narrator.wav", "Thái Sơn": "male.wav", "Mỹ Duyên": "female.wav"}
CALIBRATION_TEXT = "Hôm nay trời trong xanh, gió nhẹ thổi qua những hàng cây ven đường."
DEFAULT_BASELINE = 0.6e-3  # median of the three M0 base clips, used when nothing can be measured


def _clip_ratio(path: Path) -> float | None:
    audio, rate = sf.read(path, dtype="float32", always_2d=False)
    if rate != 48_000:
        raise ValueError(f"{path.name}: {rate} Hz, expected 48000")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return hf_ratio(np.asarray(audio, dtype=np.float32))


class Baselines:
    def __init__(self, tts: TTSProvider, clips_dir: Path = BASE_CLIPS_DIR) -> None:
        self._tts = tts
        self._clips_dir = clips_dir
        self._cache: dict[str, float] = {}
        self._lock = threading.Lock()

    def __call__(self, voice: VoiceRef) -> float:
        key = f"preset:{voice.preset}" if voice.preset else f"ref:{voice.ref_path}"
        with self._lock:
            if key not in self._cache:
                self._cache[key] = self._measure(voice)
            return self._cache[key]

    def _measure(self, voice: VoiceRef) -> float:
        ratio: float | None = None
        try:
            if voice.preset and voice.preset in BASE_CLIPS:
                ratio = _clip_ratio(self._clips_dir / BASE_CLIPS[voice.preset])
            elif voice.preset:
                neutral = VoiceRef(voice.voice_id, preset=voice.preset)
                ratio = hf_ratio(self._tts.synthesize(CALIBRATION_TEXT, neutral, "neutral", 0.0))
            elif voice.ref_path:
                ratio = _clip_ratio(Path(voice.ref_path))
        except Exception:  # the guard must never block synthesis
            log.exception("baseline for %s failed; using the default", voice.voice_id)
        return ratio if ratio else DEFAULT_BASELINE
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_audio_quality_post.py -q`
Expected: PASS (16 tests; the archived base clips reproduce the M0 baselines 0.56 / 0.64 / 0.41 ×1e-3).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/audio/quality.py src/audiotruyen_worker/audio/post.py src/audiotruyen_worker/audio/baselines.py tests/test_audio_quality_post.py
git commit -m "feat(worker): segment quality guard, post-processing and voice baselines (spec 5.6)"
```

---

### Task 6: Pipelined chapter renderer

**Files:**
- Create: `worker/src/audiotruyen_worker/audio/render.py`
- Test: `worker/tests/test_render.py`

**Interfaces:**
- Consumes: Tasks 3-5.
- Produces: `CONTENT_TYPE`, `GUARD_RETRIES = 2`, `AttemptSuperseded`, `SegmentPlan(i, text, voice, emotion, intensity, paragraph_end)`, `RenderResult(init_key, chunks, full_key, duration_ms, timings, warnings)`, `ChapterRenderer(tts, upload, on_progress, key_prefix, baseline_for, fallback_voice, check=..., ffmpeg="ffmpeg")` with `render(plans) -> RenderResult`.
- Semantics: synthesis runs on the calling thread; an uploader thread uploads `init.webm` then `seg-{i:04d}.webm` as clusters appear and calls `on_progress(init_key, chunks)` after each cluster (False → `AttemptSuperseded`, nothing more is uploaded); `chunks` entries `{key, start_ms, end_ms}` with `end_ms` = next start (last = `duration_ms`, `None` while partial); `duration_ms = round(samples / 48)`; timings are per-segment speech spans; per segment: retry once, then the voice's neutral form, then the default narrator, then 500 ms silence + warning (never raises); quality guard on the **raw** take (baselines were measured raw), up to 2 re-syntheses keeping the lowest ratio; `full.webm` = `ffmpeg -i concat.webm -c copy full.webm` uploaded last. An encoder error after the uploader stopped never masks the uploader's error.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_render.py`:

```python
import json
import subprocess
import threading
import time

import numpy as np
import pytest

from audiotruyen_worker.audio.render import AttemptSuperseded, ChapterRenderer, SegmentPlan
from audiotruyen_worker.jobs.runner import JobCancelled
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.fake import FakeTTS

NARRATOR = VoiceRef("narrator-id", preset="Đức Trí")
PREFIX = "audio/n/c/h/1"


def plans(count: int, chars: int = 60, voice: VoiceRef = NARRATOR) -> list[SegmentPlan]:
    return [SegmentPlan(i, "x" * chars, voice, "neutral", 0.0, i % 3 == 2) for i in range(count)]


class Recorder:
    def __init__(self, own_until: int | None = None):
        self.uploads: list[tuple[str, bytes, float]] = []
        self.progress: list[list[dict]] = []
        self.own_until = own_until
        self.lock = threading.Lock()

    def upload(self, key, data, content_type):
        assert content_type == "audio/webm"
        with self.lock:
            self.uploads.append((key, data, time.perf_counter()))
        return len(data)

    def on_progress(self, init_key, chunks):
        assert init_key == PREFIX + "/init.webm"
        self.progress.append([dict(c) for c in chunks])
        return self.own_until is None or len(chunks) <= self.own_until


def renderer(rec: Recorder, tts=None, check=lambda: None) -> ChapterRenderer:
    return ChapterRenderer(
        tts or FakeTTS(), rec.upload, rec.on_progress, PREFIX, lambda v: 1.0, NARRATOR, check=check
    )


def test_render_uploads_init_clusters_and_seekable_full_file(tmp_path):
    rec = Recorder()
    result = renderer(rec).render(plans(12))  # 12 x 3.3 s speech + pauses ~ 43 s
    keys = [k for k, _, _ in rec.uploads]
    assert keys[0] == PREFIX + "/init.webm" and keys[-1] == PREFIX + "/full.webm"
    assert keys[1:-1] == [f"{PREFIX}/seg-{i:04d}.webm" for i in range(len(result.chunks))]
    assert len(result.chunks) == 5
    chunks = result.chunks
    assert chunks[0]["start_ms"] == 0 and chunks[-1]["end_ms"] == result.duration_ms
    assert all(a["end_ms"] == b["start_ms"] for a, b in zip(chunks, chunks[1:], strict=False))
    timings = [result.timings[i] for i in range(12)]
    assert all(s < e for s, e in timings)
    assert all(a[1] < b[0] for a, b in zip(timings, timings[1:], strict=False))  # pauses between
    assert rec.progress[-1][-1]["end_ms"] is None  # last chunk's end known only at completion
    full = rec.uploads[-1][1]
    (tmp_path / "full.webm").write_bytes(full)
    fmt = json.loads(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
             str(tmp_path / "full.webm")],
            capture_output=True, text=True, check=True,
        ).stdout
    )["format"]  # fmt: skip
    assert float(fmt["duration"]) == pytest.approx(result.duration_ms / 1000, abs=0.05)
    assert b"\x1c\x53\xbb\x6b" in full  # Cues: seekable


class SlowTTS(FakeTTS):
    def synthesize(self, text, voice, emotion, intensity):
        time.sleep(0.05)
        return super().synthesize(text, voice, emotion, intensity)


def test_pipelined_first_cluster_uploads_before_synthesis_ends():
    rec = Recorder()
    start = time.perf_counter()
    renderer(rec, tts=SlowTTS()).render(plans(20))
    first_cluster = next(t for k, _, t in rec.uploads if k.endswith("seg-0000.webm"))
    assert first_cluster - start < 0.5 * (rec.uploads[-1][2] - start)


class FlakyTTS(FakeTTS):
    def __init__(self, fail_times: int):
        self.fail_times = fail_times
        self.voices: list[str] = []

    def synthesize(self, text, voice, emotion, intensity):
        self.voices.append(voice.voice_id)
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("cuda oom")
        return super().synthesize(text, voice, emotion, intensity)


def test_failed_segment_retries_then_falls_back_to_the_narrator():
    other = VoiceRef("male-id", preset="Thái Sơn")
    rec = Recorder()
    tts = FlakyTTS(fail_times=2)
    result = renderer(rec, tts=tts).render(plans(1, voice=other))
    assert tts.voices[:3] == ["male-id", "male-id", "narrator-id"]
    assert result.warnings == [{"segment": 0, "code": "tts_fallback_narrator"}]


def test_segment_that_always_fails_becomes_silence_with_a_warning():
    rec = Recorder()
    result = renderer(rec, tts=FlakyTTS(fail_times=99)).render(plans(2))
    assert {"segment": 0, "code": "tts_failed"} in result.warnings
    assert result.duration_ms > 0


class NoisyThenCleanTTS(FakeTTS):
    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice, emotion, intensity):
        self.calls += 1
        audio = super().synthesize(text, voice, emotion, intensity)
        if self.calls == 1:
            rng = np.random.default_rng(0)
            audio = audio + rng.normal(0, 0.02, audio.shape).astype(np.float32)
        return audio


def test_quality_guard_resynthesizes_a_noisy_take():
    rec = Recorder()
    tts = NoisyThenCleanTTS()
    r = ChapterRenderer(tts, rec.upload, rec.on_progress, PREFIX, lambda v: 2e-5, NARRATOR)
    result = r.render(plans(1))
    assert tts.calls == 2 and result.warnings == []


def test_superseded_attempt_stops_uploading():
    rec = Recorder(own_until=1)
    with pytest.raises(AttemptSuperseded):
        renderer(rec).render(plans(30))
    keys = [k for k, _, _ in rec.uploads]
    assert PREFIX + "/full.webm" not in keys
    assert len([k for k in keys if "/seg-" in k]) <= 3  # stops right after the fence trips


def test_cancellation_stops_the_render():
    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if calls["n"] > 3:
            raise JobCancelled("job")

    with pytest.raises(JobCancelled):
        renderer(Recorder(), check=check).render(plans(10))
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_render.py -q`
Expected: FAIL with `ModuleNotFoundError` (`audio.render`).

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/audio/render.py`:

```python
"""Chapter renderer (spec 4.3, 5.6, 7.3.2): synthesizes segments in order on the calling thread,
feeds one long-lived encoder, and uploads init + clusters from a second thread as soon as they
appear (pipelined: the next segment synthesizes while the previous cluster uploads). On
completion it remuxes the seekable full.webm and uploads it."""

from __future__ import annotations

import logging
import subprocess
import tempfile
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from audiotruyen_worker.audio.encoder import SAMPLE_RATE, EncoderError, StreamEncoder
from audiotruyen_worker.audio.post import finish_segment
from audiotruyen_worker.audio.quality import hf_ratio, is_noisy
from audiotruyen_worker.audio.webm_split import ClusterSegment, InitSegment
from audiotruyen_worker.tts.base import TTSProvider, VoiceRef

log = logging.getLogger(__name__)

CONTENT_TYPE = "audio/webm"
GUARD_RETRIES = 2  # at most 2 re-syntheses per segment; the lowest-ratio take is kept
FAILED_SEGMENT_MS = 500  # silence for a segment that could not be synthesized at all


class AttemptSuperseded(Exception):
    """A newer attempt owns this chapter_audio row; this run must stop and upload nothing."""


@dataclass(frozen=True)
class SegmentPlan:
    i: int
    text: str  # normalized TTS input
    voice: VoiceRef
    emotion: str
    intensity: float
    paragraph_end: bool


@dataclass
class RenderResult:
    init_key: str
    chunks: list[dict]
    full_key: str
    duration_ms: int
    timings: dict[int, tuple[int, int]]  # segment i -> (start_ms, end_ms) of its speech
    warnings: list[dict] = field(default_factory=list)


Uploader = Callable[[str, bytes, str], int]
Progress = Callable[[str, list[dict]], bool]  # (init_key, chunks) -> still own the attempt?


class ChapterRenderer:
    def __init__(
        self,
        tts: TTSProvider,
        upload: Uploader,
        on_progress: Progress,
        key_prefix: str,
        baseline_for: Callable[[VoiceRef], float],
        fallback_voice: VoiceRef,
        check: Callable[[], None] = lambda: None,
        ffmpeg: str = "ffmpeg",
    ) -> None:
        self._tts = tts
        self._upload = upload
        self._on_progress = on_progress
        self._prefix = key_prefix.rstrip("/") + "/"
        self._baseline_for = baseline_for
        self._fallback = fallback_voice
        self._check = check
        self._ffmpeg = ffmpeg
        self._warnings: list[dict] = []

    # ---- synthesis -----------------------------------------------------------------------

    def _speak(self, plan: SegmentPlan) -> np.ndarray:
        """Retry once, then the voice's neutral form, then the default narrator; never raises."""
        attempts: list[tuple[str, VoiceRef]] = [("voice", plan.voice), ("retry", plan.voice)]
        if plan.voice.ref_path and plan.voice.preset:
            attempts.append(("neutral", VoiceRef(plan.voice.voice_id, preset=plan.voice.preset)))
        if plan.voice != self._fallback:
            attempts.append(("narrator", self._fallback))
        for step, voice in attempts:
            try:
                audio = self._tts.synthesize(plan.text, voice, plan.emotion, plan.intensity)
            except Exception as exc:  # a segment never blocks the chapter
                log.warning("segment %d: TTS failed (%s): %s", plan.i, step, type(exc).__name__)
                continue
            if step != "voice":
                self._warnings.append({"segment": plan.i, "code": f"tts_fallback_{step}"})
            if len(audio):
                return audio
        self._warnings.append({"segment": plan.i, "code": "tts_failed"})
        return np.zeros(FAILED_SEGMENT_MS * SAMPLE_RATE // 1000, dtype=np.float32)

    def _synthesize(self, plan: SegmentPlan) -> np.ndarray:
        """Quality guard: re-synthesize noisy takes up to GUARD_RETRIES times, keep the best."""
        baseline = self._baseline_for(plan.voice)
        best: tuple[float, np.ndarray] | None = None
        for take in range(1 + GUARD_RETRIES):
            audio = self._speak(plan)
            ratio = hf_ratio(audio)  # raw output, like the baselines
            score = ratio if ratio is not None else 0.0
            if best is None or score < best[0]:
                best = (score, audio)
            if not is_noisy(ratio, baseline):
                break
            log.info("segment %d: noisy take %d (ratio %.2e)", plan.i, take, score)
        else:
            self._warnings.append({"segment": plan.i, "code": "quality_guard_exhausted"})
        assert best is not None
        return best[1]

    # ---- render ----------------------------------------------------------------------------

    def render(self, plans: Sequence[SegmentPlan]) -> RenderResult:
        encoder = StreamEncoder(self._ffmpeg)
        encoder.start()
        uploaded: list[bytes] = []
        state: dict = {"init_key": None, "chunks": [], "error": None}
        stop = threading.Event()

        def upload_loop() -> None:
            try:
                for segment in encoder.segments():
                    if stop.is_set():
                        continue  # drain the encoder; upload nothing more
                    if isinstance(segment, InitSegment):
                        key = self._prefix + "init.webm"
                        self._upload(key, segment.data, CONTENT_TYPE)
                        state["init_key"] = key
                        uploaded.append(segment.data)
                        continue
                    assert isinstance(segment, ClusterSegment)
                    key = f"{self._prefix}seg-{segment.index:04d}.webm"
                    self._upload(key, segment.data, CONTENT_TYPE)
                    uploaded.append(segment.data)
                    chunks = state["chunks"]
                    if chunks:
                        chunks[-1]["end_ms"] = segment.timestamp_ms
                    chunks.append({"key": key, "start_ms": segment.timestamp_ms, "end_ms": None})
                    if not self._on_progress(state["init_key"], chunks):
                        raise AttemptSuperseded()
            except BaseException as exc:  # handed to the synthesis thread
                if state["error"] is None:  # keep the first cause, not the kill's aftermath
                    state["error"] = exc
                stop.set()
                encoder.kill()

        uploader = threading.Thread(target=upload_loop, name="audio-uploader", daemon=True)
        uploader.start()
        timings: dict[int, tuple[int, int]] = {}
        samples = 0
        try:
            for plan in plans:
                self._check()
                if stop.is_set():
                    break
                pcm, speech_len = finish_segment(
                    self._synthesize(plan), plan.emotion, plan.paragraph_end
                )
                start_ms = round(samples * 1000 / SAMPLE_RATE)
                timings[plan.i] = (start_ms, round((samples + speech_len) * 1000 / SAMPLE_RATE))
                try:
                    encoder.write(pcm)
                except EncoderError:
                    if stop.is_set():  # the uploader stopped the encoder; its error wins below
                        break
                    raise
                samples += len(pcm)
            if not stop.is_set():
                encoder.close()
        except BaseException:
            stop.set()
            encoder.kill()
            uploader.join(timeout=30)
            raise
        uploader.join()
        if state["error"] is not None:
            raise state["error"]
        if state["init_key"] is None or not state["chunks"]:
            raise RuntimeError("encoder produced no audio")
        duration_ms = round(samples * 1000 / SAMPLE_RATE)
        state["chunks"][-1]["end_ms"] = duration_ms
        full_key = self._prefix + "full.webm"
        self._upload(full_key, self._remux(b"".join(uploaded)), CONTENT_TYPE)
        return RenderResult(
            init_key=state["init_key"],
            chunks=state["chunks"],
            full_key=full_key,
            duration_ms=duration_ms,
            timings=timings,
            warnings=self._warnings,
        )

    def _remux(self, live_webm: bytes) -> bytes:
        """Live WebM has no Duration or Cues; remuxing to a file writes both (spec 4.3)."""
        with tempfile.TemporaryDirectory(prefix="audiotruyen-") as tmp:
            src, dst = Path(tmp) / "concat.webm", Path(tmp) / "full.webm"
            src.write_bytes(live_webm)
            subprocess.run(
                [self._ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                 "-i", str(src), "-c", "copy", str(dst)],
                check=True,
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )  # fmt: skip
            return dst.read_bytes()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_render.py -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/audio/render.py tests/test_render.py
git commit -m "feat(worker): pipelined chapter renderer with guarded segments and seekable full.webm (spec 4.3, 5.6, 7.3.2)"
```

---

### Task 7: Chapter preparation shared with synthesize, and the audio store

**Files:**
- Modify: `worker/src/audiotruyen_worker/store.py` (full replacement), `worker/src/audiotruyen_worker/jobs/handlers.py` (full replacement), `worker/src/audiotruyen_worker/admin.py` (append `DEFAULT_VOICES` and `init_voices`)
- Create: `worker/src/audiotruyen_worker/audio_store.py`
- Test: `worker/tests/test_handlers.py` (full replacement: the FakeStore gains `chapter_text`/`analysis`), `worker/tests/test_db_audio_store.py` (create)

**Interfaces:**
- `Store` gains `chapter_text(chapter_id) -> str | None` and `analysis(chapter_id, text_hash, strategy, version) -> list[dict] | None` (`has_analysis` now delegates to it).
- `jobs/handlers.py`: `payload_str(job, key, max_len=2000)`, `payload_uuid(job, key)`, `owned_chapter(store, job, chapter_id) -> ChapterRow`, `PreparedChapter(row, text, digest, analysis, strategy)`, `ChapterPreparer(adapter, store, strategies).prepare(job, row, ctx, *, refetch) -> PreparedChapter` (stored text unless `refetch` or missing; cached analysis looked up in chain order before running the chain). `fetch_chapter` = `prepare(refetch=True)`; its behaviour and messages are unchanged.
- `audio_store.py`: `AudioRow(id, attempt, status)`, `GcCandidate(key, chapter_audio_id, stale)`, `AudioStore(client)` with `begin`, `update(row, fields) -> bool` (fenced by attempt), `voice_hash(novel_id)`, `default_narrator(user_id) -> VoiceRef | None`, `lexicon(user_id, novel_id) -> list[LexiconRule]` (global by position, then novel), `upsert_preset_voice(...)`, `clear_default_flags(user_id)`, `live_keys`, `mark_deleted`, `usage`, `gc_candidates`, `delete_audio_rows`.
- `admin.DEFAULT_VOICES`, `admin.init_voices(audio_store, user_id) -> list[str]` (idempotent; Đức Trí narrator, Thái Sơn male, Mỹ Duyên female).

- [ ] **Step 1: Write the failing tests**

Replace `worker/tests/test_handlers.py` with:

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
    def __init__(self, events=None, chapter_row=None, cached=False):
        self.events = events if events is not None else []
        self.chapter_row = chapter_row
        self.cached = cached
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

    def chapter_text(self, chapter_id):
        return None

    def analysis(self, chapter_id, digest, strategy, version):
        return [{"i": n} for n in range(3)] if self.cached else None

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


class CountingStrategy(HeuristicStrategy):
    """Heuristic labels, but counts analyze() calls (a stand-in for a quota-billed LLM strategy)."""

    def __init__(self):
        self.calls = 0

    def analyze(self, segments, roster):
        self.calls += 1
        return super().analyze(segments, roster)


def test_fetch_chapter_skips_unchanged_text_and_existing_analysis():
    row = ChapterRow(CHAPTER, USER, "novel-uuid", 1, "u", text_hash(TEXT))
    store = FakeStore(chapter_row=row, cached=True)
    strategy = CountingStrategy()
    result = make_handlers(FakeAdapter(text=TEXT), store, [strategy])["fetch_chapter"](
        job("fetch_chapter", {"chapter_id": CHAPTER}), JobContext(job())
    )
    assert result == {"chars": len(TEXT), "segments": 3, "strategy": "heuristic"}
    assert store.saved_text is None and store.saved_analysis is None
    assert strategy.calls == 0  # a cached analysis must not re-run the chain


def test_fetch_chapter_analyzes_unchanged_text_without_cached_analysis():
    row = ChapterRow(CHAPTER, USER, "novel-uuid", 1, "u", text_hash(TEXT))
    store = FakeStore(chapter_row=row, cached=False)
    strategy = CountingStrategy()
    make_handlers(FakeAdapter(text=TEXT), store, [strategy])["fetch_chapter"](
        job("fetch_chapter", {"chapter_id": CHAPTER}), JobContext(job())
    )
    assert store.saved_text is None
    assert strategy.calls == 1
    assert store.saved_analysis[:2] == ("heuristic", 1)
    assert len(store.saved_analysis[2]) == 3


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

Create `worker/tests/test_db_audio_store.py`:

```python
import boto3
import pytest
from moto import mock_aws

from audiotruyen_worker.admin import init_voices
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.storage.guard import GuardedStorage, UploadBlocked
from audiotruyen_worker.storage.r2 import R2Storage
from audiotruyen_worker.store import Store
from audiotruyen_worker.text.normalize import LexiconRule

pytestmark = pytest.mark.db

TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần. " + "Gió thổi qua rừng già. " * 40


@pytest.fixture
def r2():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="audiotruyen")
        yield R2Storage(client, "audiotruyen")


def _novel_with_chapter(admin_client, owner_id, text=TEXT):
    store = Store(admin_client)
    info = NovelInfo(
        f"m2b-{owner_id[:8]}", "https://truyenfull.live/a/", "a", "A", None, None, None, None
    )
    novel_id = store.upsert_novel(owner_id, info)
    store.upsert_chapters(
        owner_id, novel_id, [ChapterRef(1, "Chương 1", "https://truyenfull.live/a/chuong-1/")]
    )
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    if text is not None:
        store.save_chapter_text(chapter_id, text, "t-" + chapter_id[:8])
    return store, novel_id, chapter_id


def test_guarded_upload_enforces_the_caps_through_postgres(admin_client, owner, r2):
    audio = AudioStore(admin_client)
    usage = audio.usage()
    prefix = f"audio/{owner['id']}/x/h/1/"
    guarded = GuardedStorage(
        r2, admin_client, enabled=True,
        max_bytes=usage["live_bytes"] + 10, max_puts=usage["month_puts"] + 3,
    )  # fmt: skip
    assert guarded.put(prefix + "a.webm", b"12345678", "audio/webm") == 8
    with pytest.raises(UploadBlocked, match="GiB"):
        guarded.put(prefix + "b.webm", b"12345", "audio/webm")
    assert not r2.exists(prefix + "b.webm")
    assert guarded.put(prefix + "a.webm", b"12345678", "audio/webm") == 8  # retry, same bytes
    assert audio.usage()["live_bytes"] == usage["live_bytes"] + 8
    assert guarded.put(prefix + "c.webm", b"1", "audio/webm") == 1
    with pytest.raises(UploadBlocked, match="lần ghi"):
        guarded.put(prefix + "d.webm", b"1", "audio/webm")
    assert audio.live_keys(prefix) == [prefix + "a.webm", prefix + "c.webm"]
    assert audio.mark_deleted([prefix + "a.webm", prefix + "c.webm"]) == 2
    assert audio.live_keys(prefix) == []


def test_audio_store_voices_lexicon_hash_and_fencing(admin_client, owner):
    store, novel_id, chapter_id = _novel_with_chapter(admin_client, owner["id"])
    audio = AudioStore(admin_client)
    assert audio.default_narrator(owner["id"]) is None
    ids = init_voices(audio, owner["id"])
    assert init_voices(audio, owner["id"]) == ids  # idempotent
    narrator = audio.default_narrator(owner["id"])
    assert (narrator.voice_id, narrator.preset) == (ids[0], "Đức Trí")
    first_hash = audio.voice_hash(novel_id)
    me = owner["id"]
    admin_client.table("lexicon").insert(
        [
            {"user_id": me, "pattern": "B", "replacement": "b", "position": 2},
            {"user_id": me, "pattern": "A", "replacement": "a", "position": 1},
            {
                "user_id": me,
                "novel_id": novel_id,
                "pattern": "N",
                "replacement": "n",
                "position": 0,
            },
        ]
    ).execute()
    assert audio.lexicon(owner["id"], novel_id) == [
        LexiconRule("A", "a"),
        LexiconRule("B", "b"),
        LexiconRule("N", "n"),
    ]
    assert audio.voice_hash(novel_id) != first_hash
    row = audio.begin(chapter_id, "vh")
    assert (row.attempt, row.status) == (1, "queued")
    assert audio.update(row, {"status": "partial"}) is True
    newer = audio.begin(chapter_id, "vh")
    assert newer.attempt == 2
    assert audio.update(row, {"status": "partial"}) is False  # fenced out
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_handlers.py -q` → FAIL (`chapter_text` / `analysis` not used yet: the cached-analysis tests fail).
Run (DB env loaded): `uv run pytest tests/test_db_audio_store.py -q` → FAIL (`audio_store` / `init_voices` missing).

- [ ] **Step 3: Write the implementation**

Replace `worker/src/audiotruyen_worker/store.py` with:

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

    def chapter_text(self, chapter_id: str) -> str | None:
        data = (
            self._db.table("chapters").select("text").eq("id", chapter_id).limit(1).execute().data
        )
        return data[0]["text"] if data else None

    def analysis(
        self, chapter_id: str, text_hash: str, strategy: str, version: int
    ) -> list[dict[str, Any]] | None:
        data = (
            self._db.table("chapter_analysis")
            .select("segments")
            .eq("chapter_id", chapter_id)
            .eq("text_hash", text_hash)
            .eq("strategy", strategy)
            .eq("strategy_version", version)
            .limit(1)
            .execute()
            .data
        )
        return data[0]["segments"] if data else None

    def has_analysis(self, chapter_id: str, text_hash: str, strategy: str, version: int) -> bool:
        return self.analysis(chapter_id, text_hash, strategy, version) is not None

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

Replace `worker/src/audiotruyen_worker/jobs/handlers.py` with:

```python
"""Job handlers for the text side: search, fetch_novel, fetch_chapter (spec 5.1-5.4), and the
chapter preparation that synthesize shares (text + cached analysis)."""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import Handler, JobContext, PermanentJobError
from audiotruyen_worker.sources.base import SourceAdapter
from audiotruyen_worker.speakers.base import SegmentLabel, SpeakerStrategy, run_chain
from audiotruyen_worker.store import ChapterRow, Store
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


def payload_str(job: Job, key: str, max_len: int = 2000) -> str:
    value = job.payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise PermanentJobError(f"Job thiếu hoặc sai trường '{key}'.")
    return value.strip()


def payload_uuid(job: Job, key: str) -> str:
    value = payload_str(job, key, 64)
    try:
        uuid.UUID(value)
    except ValueError as exc:
        raise PermanentJobError(f"Job có {key} không hợp lệ.") from exc
    return value


def owned_chapter(store: Store, job: Job, chapter_id: str) -> ChapterRow:
    row = store.chapter(chapter_id, job.user_id)
    if row is None:
        raise PermanentJobError("Không tìm thấy chương này trong thư viện.")
    return row


@dataclass(frozen=True)
class PreparedChapter:
    row: ChapterRow
    text: str
    digest: str
    analysis: list[dict[str, Any]]
    strategy: str


class ChapterPreparer:
    """Chapter text (fetched when asked or missing) plus its speaker/emotion analysis, reusing a
    cached analysis in chain order before running the chain (an LLM strategy bills quota)."""

    def __init__(
        self, adapter: SourceAdapter, store: Store, strategies: Sequence[SpeakerStrategy]
    ) -> None:
        self._adapter = adapter
        self._store = store
        self._strategies = strategies

    def prepare(
        self, job: Job, row: ChapterRow, ctx: JobContext, *, refetch: bool
    ) -> PreparedChapter:
        text = None if refetch else self._store.chapter_text(row.id)
        if text is None:
            text = self._adapter.chapter(row.url).text
            ctx.check()
        digest = text_hash(text)
        if digest != row.text_hash:
            self._store.save_chapter_text(row.id, text, digest)
        for strategy in self._strategies:
            cached = self._store.analysis(row.id, digest, strategy.name, strategy.version)
            if cached is not None:
                return PreparedChapter(row, text, digest, cached, strategy.name)
        segments = segment_text(text)
        result = run_chain(self._strategies, segments, self._store.roster(row.novel_id))
        document = analysis_document(segments, result.labels)
        self._store.save_analysis(
            job.user_id, row.id, digest, result.strategy, result.version, document
        )
        return PreparedChapter(row, text, digest, document, result.strategy)


def make_handlers(
    adapter: SourceAdapter, store: Store, strategies: Sequence[SpeakerStrategy]
) -> dict[str, Handler]:
    preparer = ChapterPreparer(adapter, store, strategies)

    def search(job: Job, ctx: JobContext) -> dict[str, Any]:
        query = payload_str(job, "query", MAX_QUERY_CHARS)
        items = adapter.search(query)[:MAX_SEARCH_RESULTS]
        return {"items": [asdict(item) for item in items]}

    def fetch_novel(job: Job, ctx: JobContext) -> dict[str, Any]:
        url = payload_str(job, "url")
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
        row = owned_chapter(store, job, payload_uuid(job, "chapter_id"))
        chapter = preparer.prepare(job, row, ctx, refetch=True)
        return {
            "chars": len(chapter.text),
            "segments": len(chapter.analysis),
            "strategy": chapter.strategy,
        }

    return {"search": search, "fetch_novel": fetch_novel, "fetch_chapter": fetch_chapter}
```

Create `worker/src/audiotruyen_worker/audio_store.py`:

```python
"""Database access for synthesize / cleanup_r2 / GC (service role; scoped by the caller)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from audiotruyen_worker.text.normalize import LexiconRule
from audiotruyen_worker.tts.base import VoiceRef


@dataclass(frozen=True)
class AudioRow:
    id: str
    attempt: int
    status: str


@dataclass(frozen=True)
class GcCandidate:
    key: str
    chapter_audio_id: str
    stale: bool


class AudioStore:
    def __init__(self, client) -> None:
        self._db = client

    def _rpc(self, name: str, params: dict[str, Any]) -> Any:
        return self._db.rpc(name, params).execute().data

    # ---- chapter_audio -----------------------------------------------------------------

    def begin(self, chapter_id: str, voice_hash: str) -> AudioRow:
        (row,) = self._rpc(
            "begin_chapter_audio", {"p_chapter_id": chapter_id, "p_voice_hash": voice_hash}
        )
        return AudioRow(row["id"], row["attempt"], row["status"])

    def update(self, row: AudioRow, fields: dict[str, Any]) -> bool:
        """Fenced by attempt (spec 5.1): False when a newer attempt owns the row."""
        data = (
            self._db.table("chapter_audio")
            .update(fields)
            .eq("id", row.id)
            .eq("attempt", row.attempt)
            .execute()
            .data
        )
        return bool(data)

    # ---- voices, lexicon, hash -----------------------------------------------------------

    def voice_hash(self, novel_id: str) -> str:
        return self._rpc("current_voice_hash", {"p_novel_id": novel_id})

    def default_narrator(self, user_id: str) -> VoiceRef | None:
        data = (
            self._db.table("voices")
            .select("id,kind,preset_name")
            .eq("user_id", user_id)
            .eq("is_default_narrator", True)
            .limit(1)
            .execute()
            .data
        )
        if not data or not data[0]["preset_name"]:
            return None
        return VoiceRef(data[0]["id"], preset=data[0]["preset_name"])

    def lexicon(self, user_id: str, novel_id: str) -> list[LexiconRule]:
        """Enabled rules: global ones by position, then the novel's (spec 5.3)."""
        rows = (
            self._db.table("lexicon")
            .select("novel_id,pattern,replacement,is_regex,position,id")
            .eq("user_id", user_id)
            .eq("enabled", True)
            .or_(f"novel_id.is.null,novel_id.eq.{novel_id}")
            .execute()
            .data
        )
        rows.sort(key=lambda r: (r["novel_id"] is not None, r["position"], r["id"]))
        return [LexiconRule(r["pattern"], r["replacement"], r["is_regex"]) for r in rows]

    def upsert_preset_voice(
        self, user_id: str, name: str, gender: str, *, narrator: bool, male: bool, female: bool
    ) -> str:
        row = {
            "user_id": user_id,
            "name": name,
            "kind": "preset",
            "preset_name": name,
            "gender": gender,
            "is_default_narrator": narrator,
            "is_default_male": male,
            "is_default_female": female,
        }
        data = self._db.table("voices").upsert(row, on_conflict="user_id,name").execute().data
        return data[0]["id"]

    def clear_default_flags(self, user_id: str) -> None:
        for flag in ("is_default_narrator", "is_default_male", "is_default_female"):
            self._db.table("voices").update({flag: False}).eq("user_id", user_id).eq(
                flag, True
            ).execute()

    # ---- R2 ledger ------------------------------------------------------------------------

    def live_keys(self, prefix: str, after: str = "", limit: int = 1000) -> list[str]:
        return list(
            self._rpc("r2_live_keys", {"p_prefix": prefix, "p_after": after, "p_limit": limit})
            or []
        )

    def mark_deleted(self, keys: list[str]) -> int:
        return int(self._rpc("r2_mark_deleted", {"p_keys": keys}) or 0)

    def usage(self) -> dict[str, int]:
        (row,) = self._rpc("r2_usage", {})
        return {k: int(v) for k, v in row.items()}

    def gc_candidates(self, limit: int = 1000) -> list[GcCandidate]:
        rows = self._rpc("r2_gc_candidates", {"p_limit": limit}) or []
        return [GcCandidate(r["key"], r["chapter_audio_id"], r["stale"]) for r in rows]

    def delete_audio_rows(self, ids: list[str]) -> None:
        if ids:
            self._db.table("chapter_audio").delete().in_("id", ids).execute()
```

Append to `worker/src/audiotruyen_worker/admin.py` (two blank lines before it):

```python
DEFAULT_VOICES = (  # spec 1 / 5.10: Southern presets chosen by the owner in spike S1
    ("Đức Trí", "male", "narrator"),
    ("Thái Sơn", "male", "male"),
    ("Mỹ Duyên", "female", "female"),
)


def init_voices(audio_store, user_id: str) -> list[str]:
    """Create (or reset) the three default preset voices and their default flags."""
    audio_store.clear_default_flags(user_id)
    return [
        audio_store.upsert_preset_voice(
            user_id,
            name,
            gender,
            narrator=role == "narrator",
            male=role == "male",
            female=role == "female",
        )  # fmt: skip
        for name, gender, role in DEFAULT_VOICES
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_handlers.py -q` → PASS (12 tests); `uv run pytest -m "not db" -q` → all pass.
Run (DB env loaded): `uv run pytest tests/test_db_audio_store.py tests/test_db_store.py -q` → PASS (2 + 3).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/store.py src/audiotruyen_worker/jobs/handlers.py src/audiotruyen_worker/audio_store.py src/audiotruyen_worker/admin.py tests/test_handlers.py tests/test_db_audio_store.py
git commit -m "feat(worker): shared chapter preparation, audio store, default voices (spec 4.2, 5.3)"
```

---

### Task 8: Runner extensions and the synthesize handler

**Files:**
- Modify: `worker/src/audiotruyen_worker/jobs/runner.py` (full replacement)
- Create: `worker/src/audiotruyen_worker/jobs/synthesize.py`
- Test: `worker/tests/test_runner.py` (append), `worker/tests/test_synthesize.py` (create)

**Interfaces:**
- `runner`: `JobSkipped(Exception)` → job finished `cancelled` with `result = {"reason": <Vietnamese message>}`; `Runner(device=str | Callable[[], str])` (read at each heartbeat); `describe_failure` adds `UploadBlocked` (its message, not retried), `TTSUnavailable` (not retried), `EncoderError` (fixed message, retried).
- `jobs/synthesize.py`: `NO_NARRATOR`, `STALE_SETTINGS`, `SUPERSEDED`, `audio_prefix(novel_id, chapter_id, voice_hash, attempt) -> str`, `make_synthesize_handler(*, preparer, store, audio_store, storage, tts, baselines, ffmpeg="ffmpeg")`.
- Synthesize order: owned chapter (payload `chapter_id` uuid + `voice_hash`) → voice_hash must equal `current_voice_hash(novel)` else `JobSkipped` → kill switch → default narrator else `PermanentJobError` → prepare chapter (fetch text if missing) → `begin_chapter_audio` (ready → `{already_ready: True}`) → plans (lexicon, normalize; empty TTS text skipped) → render → final fenced update `{status: ready, provider, init_key, chunks, full_key, duration_ms, segments, warnings}`; `segments` = analysis entries + `voice_id`, `start_ms`, `end_ms`. Lost fence → `JobSkipped(SUPERSEDED)`; lease lost (`JobCancelled`) → no write; other errors → row `failed`, re-raise. M2b speaks every segment with the default narrator (per-speaker voices: M4).

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_runner.py`:

```python
def test_skipped_job_ends_cancelled_with_the_reason():
    from audiotruyen_worker.jobs.runner import JobSkipped

    def skip(j, c):
        raise JobSkipped("Cài đặt đã đổi.")

    queue = FakeQueue([job()])
    Runner(queue, {"search": skip}, version="v", device="cpu").run_once()
    assert queue.finished == [("j1", "cancelled", {"reason": "Cài đặt đã đổi."})]
    assert queue.failed == []


def test_device_may_be_a_callable_read_at_each_beat():
    state = {"device": "loading"}
    queue = FakeQueue()
    seen = []
    queue.heartbeat = lambda version, device, job_id: seen.append(device) or True
    runner = Runner(queue, {}, version="v", device=lambda: state["device"])
    runner.beat()
    state["device"] = "cuda"
    runner.beat()
    assert seen == ["loading", "cuda"]


def test_audio_failures_map_to_owner_messages():
    from audiotruyen_worker.audio.encoder import EncoderError
    from audiotruyen_worker.storage.guard import UploadBlocked
    from audiotruyen_worker.tts.vieneu_provider import TTSUnavailable

    assert describe_failure(UploadBlocked("Kho R2 đầy.")) == ("Kho R2 đầy.", False)
    message, retryable = describe_failure(TTSUnavailable("no vieneu"))
    assert "uv sync --extra cuda" in message and retryable is False
    message, retryable = describe_failure(EncoderError("boom"))
    assert "ffmpeg" in message and "boom" not in message and retryable is True
```

Create `worker/tests/test_synthesize.py`:

```python
import pytest

from audiotruyen_worker.audio_store import AudioRow
from audiotruyen_worker.jobs.handlers import ChapterPreparer
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobContext, JobSkipped, PermanentJobError
from audiotruyen_worker.jobs.synthesize import (
    NO_NARRATOR,
    STALE_SETTINGS,
    SUPERSEDED,
    audio_prefix,
    make_synthesize_handler,
)
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.storage.guard import UploadBlocked
from audiotruyen_worker.store import ChapterRow
from audiotruyen_worker.text.normalize import LexiconRule
from audiotruyen_worker.tts.base import VoiceRef
from audiotruyen_worker.tts.fake import FakeTTS

USER = "11111111-1111-1111-1111-111111111111"
NOVEL = "aaaaaaaa-0000-0000-0000-000000000001"
CHAPTER = "cccccccc-0000-0000-0000-000000000001"
TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần. Gió thổi qua rừng.\n…"
NARRATOR = VoiceRef("dddddddd-0000-0000-0000-000000000001", preset="Đức Trí")


class FakeStore:
    def __init__(self, text=TEXT):
        self.text = text
        self.saved_analysis = None

    def chapter(self, chapter_id, user_id):
        if user_id != USER or chapter_id != CHAPTER:
            return None
        return ChapterRow(CHAPTER, USER, NOVEL, 1, "https://truyenfull.live/a/chuong-1/", None)

    def chapter_text(self, chapter_id):
        return self.text

    def save_chapter_text(self, *args):
        pass

    def analysis(self, *args):
        return None

    def roster(self, novel_id):
        return []

    def save_analysis(self, user_id, chapter_id, digest, strategy, version, segments):
        self.saved_analysis = segments


class FakeAudioStore:
    def __init__(self, status="queued", voice_hash="vh", narrator=NARRATOR, own=True):
        self.status = status
        self.hash = voice_hash
        self.narrator = narrator
        self.own = own
        self.updates: list[dict] = []

    def voice_hash(self, novel_id):
        return self.hash

    def default_narrator(self, user_id):
        return self.narrator

    def begin(self, chapter_id, voice_hash):
        return AudioRow("audio-1", 2, self.status)

    def lexicon(self, user_id, novel_id):
        return [LexiconRule("Lâm Phong", "Lâm Phông")]

    def update(self, row, fields):
        self.updates.append(fields)
        return self.own


class FakeGuarded:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.keys: list[str] = []

    def check_enabled(self):
        if not self.enabled:
            raise UploadBlocked("tắt")

    def put(self, key, data, content_type):
        self.check_enabled()
        self.keys.append(key)
        return len(data)


class RecordingTTS(FakeTTS):
    def __init__(self):
        self.texts: list[str] = []

    def synthesize(self, text, voice, emotion, intensity):
        self.texts.append(text)
        return super().synthesize(text, voice, emotion, intensity)


def job(payload=None):
    return Job("j1", USER, "synthesize", payload or {"chapter_id": CHAPTER, "voice_hash": "vh"})


def handler(store=None, audio=None, storage=None, tts=None):
    store = store or FakeStore()
    return make_synthesize_handler(
        preparer=ChapterPreparer(None, store, [HeuristicStrategy()]),
        store=store,
        audio_store=audio or FakeAudioStore(),
        storage=storage or FakeGuarded(),
        tts=tts or RecordingTTS(),
        baselines=lambda v: 1.0,
    )


def test_synthesizes_all_segments_and_writes_the_ready_row():
    audio, storage, tts = FakeAudioStore(), FakeGuarded(), RecordingTTS()
    result = handler(audio=audio, storage=storage, tts=tts)(job(), JobContext(job()))
    prefix = audio_prefix(NOVEL, CHAPTER, "vh", 2)
    assert storage.keys[0] == prefix + "init.webm" and storage.keys[-1] == prefix + "full.webm"
    assert "lâm phông quát." in tts.texts  # lexicon applied, then vietnormalizer lowercases
    assert all(t for t in tts.texts)  # the punctuation-only "…" paragraph is not spoken
    final = audio.updates[-1]
    assert final["status"] == "ready" and final["provider"] == "fake"
    assert final["full_key"] == prefix + "full.webm"
    assert [s["i"] for s in final["segments"]] == [0, 1, 2]
    assert all(s["voice_id"] == NARRATOR.voice_id for s in final["segments"])
    assert final["segments"][0]["emotion"] == "angry"
    assert all(u["status"] == "partial" for u in audio.updates[:-1])
    assert result == {
        "chapter_audio_id": "audio-1", "attempt": 2, "duration_ms": final["duration_ms"],
        "chunks": len(final["chunks"]), "warnings": 0,
    }  # fmt: skip


def test_outdated_voice_hash_is_skipped():
    with pytest.raises(JobSkipped, match=STALE_SETTINGS):
        handler(audio=FakeAudioStore(voice_hash="other"))(job(), JobContext(job()))


def test_kill_switch_fails_before_any_audio_row():
    audio = FakeAudioStore()
    with pytest.raises(UploadBlocked):
        handler(audio=audio, storage=FakeGuarded(enabled=False))(job(), JobContext(job()))
    assert audio.updates == []


def test_missing_narrator_is_permanent():
    with pytest.raises(PermanentJobError, match=NO_NARRATOR):
        handler(audio=FakeAudioStore(narrator=None))(job(), JobContext(job()))


def test_ready_row_is_not_synthesized_again():
    tts = RecordingTTS()
    result = handler(audio=FakeAudioStore(status="ready"), tts=tts)(job(), JobContext(job()))
    assert result["already_ready"] is True and tts.texts == []


def test_superseded_attempt_is_skipped():
    with pytest.raises(JobSkipped, match=SUPERSEDED):
        handler(audio=FakeAudioStore(own=False))(job(), JobContext(job()))


class FailingUpload(FakeGuarded):
    def put(self, key, data, content_type):
        if key.endswith("full.webm"):
            raise ConnectionError("r2 down")
        return super().put(key, data, content_type)


def test_failure_after_begin_marks_the_row_failed():
    audio = FakeAudioStore()
    with pytest.raises(ConnectionError):
        handler(audio=audio, storage=FailingUpload())(job(), JobContext(job()))
    assert audio.updates[-1] == {"status": "failed"}
    assert audio.updates[0]["status"] == "partial"


@pytest.mark.parametrize(
    "payload",
    [{"chapter_id": CHAPTER}, {"chapter_id": "x", "voice_hash": "vh"},
     {"chapter_id": "dddddddd-0000-0000-0000-000000000009", "voice_hash": "vh"}],
)  # fmt: skip
def test_bad_payloads_are_permanent(payload):
    with pytest.raises(PermanentJobError):
        handler()(job(payload), JobContext(job(payload)))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_runner.py tests/test_synthesize.py -q`
Expected: FAIL (`JobSkipped`, `jobs.synthesize` missing).

- [ ] **Step 3: Write the implementation**

Replace `worker/src/audiotruyen_worker/jobs/runner.py` with:

```python
"""Job loop (spec 5.1): one job at a time, Realtime wake with polling fallback, heartbeat thread
that extends the lease and cancels the running handler when the lease is lost."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from audiotruyen_worker.audio.encoder import EncoderError
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.sources.base import NovelNotFound, ParserBroken, SourceBlocked, SourceError
from audiotruyen_worker.storage.guard import UploadBlocked
from audiotruyen_worker.tts.vieneu_provider import TTSUnavailable

log = logging.getLogger(__name__)


SHUTDOWN_MESSAGE = "Worker đã dừng giữa chừng."


class JobCancelled(Exception):
    """Raised by JobContext.check() when the job must stop (lease lost or shutdown)."""


class PermanentJobError(Exception):
    """A failure that retrying cannot fix. The message is shown to the owner (Vietnamese)."""


class JobSkipped(Exception):
    """The job no longer needs doing (settings changed, a newer attempt took over). It ends as
    `cancelled` with the Vietnamese message as `result.reason`."""


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
    if isinstance(exc, PermanentJobError | UploadBlocked):
        return str(exc), False
    if isinstance(exc, TTSUnavailable):
        return "Worker chưa cài VieNeu-TTS. Chạy: uv sync --extra cuda (hoặc --extra tts).", False
    if isinstance(exc, EncoderError):
        return "Lỗi khi mã hóa audio bằng ffmpeg. Worker sẽ thử lại sau.", True
    if isinstance(exc, NovelNotFound):
        return "Không tìm thấy truyện trên truyenfull (truyện có thể đã bị gỡ).", False
    if isinstance(exc, ParserBroken):
        return (
            "Không đọc được trang truyenfull, có thể trang đã đổi cấu trúc. "
            "Xem worker/logs/worker.log.",
            False,
        )
    if isinstance(exc, SourceBlocked):
        return (
            "Truyenfull đang chặn truy cập tự động (Cloudflare) cho trang này. "
            "Worker sẽ thử lại sau.",
            True,
        )
    if isinstance(exc, SourceError):
        return "Không tải được trang truyenfull. Worker sẽ thử lại sau.", True
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
        device: str | Callable[[], str],
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
        except JobSkipped as exc:
            log.info("job %s skipped: %s", job.id, exc)
            self.queue.finish(job.id, "cancelled", {"reason": str(exc)})
            return
        except KeyboardInterrupt:
            # Ctrl+C: hand the job back now instead of waiting for its lease to expire.
            try:
                self.queue.fail(job.id, SHUTDOWN_MESSAGE, True)
            except Exception:  # the lease expiry requeues it; never swallow the Ctrl+C
                log.exception("could not hand job %s back", job.id)
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

    def cancel_current(self, job_id: str) -> None:
        """Cancel the running job only if it is still job_id (a stale heartbeat must not
        cancel the job claimed after it)."""
        with self._lock:
            if self._current is not None and self._current.job.id == job_id:
                self._current.cancelled.set()

    def beat(self, queue: Queue | None = None) -> None:
        """One heartbeat (from the heartbeat thread, with its own client). Cancels the running
        job when its lease was lost."""
        job_id = self.current_job_id
        device = self.device() if callable(self.device) else self.device
        owned = (queue or self.queue).heartbeat(self.version, device, job_id)
        if job_id and not owned:
            log.warning("lease lost for job %s; stopping it", job_id)
            self.cancel_current(job_id)

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                ran = self.run_once()
            except Exception:  # network blip talking to Supabase: back off, keep the loop alive
                log.exception("job loop error")
                ran = False
                _wait_any(5.0, stop)
            if not ran:
                _wait_any(self.poll_seconds, self.wake, stop)
                self.wake.clear()


def _wait_any(seconds: float, *events: threading.Event) -> None:
    """Wait until one of the events is set or the timeout passes, in slices of at most 1 s:
    on Windows a long Event.wait cannot be interrupted by Ctrl+C."""
    deadline = time.monotonic() + seconds
    while not any(event.is_set() for event in events):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        events[0].wait(min(remaining, 1.0))


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

Create `worker/src/audiotruyen_worker/jobs/synthesize.py`:

```python
"""synthesize job (spec 5.1, 5.3 step 4, 5.6): one chapter, one voice_hash, one new attempt.
M2b speaks every segment with the default narrator preset; per-speaker voices and emotion refs
come in M4."""

from __future__ import annotations

import logging
from typing import Any

from audiotruyen_worker.audio.render import AttemptSuperseded, ChapterRenderer, SegmentPlan
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.jobs.handlers import (
    ChapterPreparer,
    owned_chapter,
    payload_str,
    payload_uuid,
)
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobCancelled, JobContext, JobSkipped, PermanentJobError
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.store import Store
from audiotruyen_worker.text.normalize import normalize_for_tts
from audiotruyen_worker.tts.base import TTSProvider

log = logging.getLogger(__name__)

NO_NARRATOR = "Chưa có giọng đọc mặc định. Chạy: uv run worker init-voices"
STALE_SETTINGS = "Cài đặt giọng đọc hoặc từ điển phát âm đã đổi; job này không còn cần chạy."
SUPERSEDED = "Một lượt tạo audio mới hơn đã thay thế lượt này."


def audio_prefix(novel_id: str, chapter_id: str, voice_hash: str, attempt: int) -> str:
    return f"audio/{novel_id}/{chapter_id}/{voice_hash}/{attempt}/"


def make_synthesize_handler(
    *,
    preparer: ChapterPreparer,
    store: Store,
    audio_store: AudioStore,
    storage: GuardedStorage,
    tts: TTSProvider,
    baselines,
    ffmpeg: str = "ffmpeg",
):
    def synthesize(job: Job, ctx: JobContext) -> dict[str, Any]:
        row = owned_chapter(store, job, payload_uuid(job, "chapter_id"))
        voice_hash = payload_str(job, "voice_hash", 64)
        if audio_store.voice_hash(row.novel_id) != voice_hash:
            raise JobSkipped(STALE_SETTINGS)
        storage.check_enabled()  # kill switch: fail before any work, nothing uploaded
        narrator = audio_store.default_narrator(job.user_id)
        if narrator is None:
            raise PermanentJobError(NO_NARRATOR)
        chapter = preparer.prepare(job, row, ctx, refetch=False)
        audio = audio_store.begin(row.id, voice_hash)
        if audio.status == "ready":
            return {"chapter_audio_id": audio.id, "attempt": audio.attempt, "already_ready": True}

        rules = audio_store.lexicon(job.user_id, row.novel_id)
        plans = []
        for seg in chapter.analysis:
            start, end = seg["src"]
            text = normalize_for_tts(chapter.text[start:end], rules)
            if text:
                plans.append(
                    SegmentPlan(
                        seg["i"], text, narrator, seg["emotion"], seg["intensity"], seg["pe"]
                    )
                )

        def progress(init_key: str, chunks: list[dict]) -> bool:
            return audio_store.update(
                audio, {"init_key": init_key, "chunks": chunks, "status": "partial"}
            )

        renderer = ChapterRenderer(
            tts,
            storage.put,
            progress,
            audio_prefix(row.novel_id, row.id, voice_hash, audio.attempt),
            baselines,
            narrator,
            check=ctx.check,
            ffmpeg=ffmpeg,
        )
        try:
            result = renderer.render(plans)
        except AttemptSuperseded as exc:
            raise JobSkipped(SUPERSEDED) from exc
        except JobCancelled:
            raise  # lease lost: the next attempt takes over; write nothing
        except Exception:
            audio_store.update(audio, {"status": "failed"})
            raise

        segments = []
        for seg in chapter.analysis:
            if seg["i"] in result.timings:
                start_ms, end_ms = result.timings[seg["i"]]
                segments.append(
                    {**seg, "voice_id": narrator.voice_id, "start_ms": start_ms, "end_ms": end_ms}
                )
        final = {
            "status": "ready",
            "provider": tts.name,
            "init_key": result.init_key,
            "chunks": result.chunks,
            "full_key": result.full_key,
            "duration_ms": result.duration_ms,
            "segments": segments,
            "warnings": result.warnings,
        }
        if not audio_store.update(audio, final):
            raise JobSkipped(SUPERSEDED)
        log.info(
            "chapter %s attempt %d ready: %d ms, %d clusters, %d warnings",
            row.id, audio.attempt, result.duration_ms, len(result.chunks), len(result.warnings),
        )  # fmt: skip
        return {
            "chapter_audio_id": audio.id,
            "attempt": audio.attempt,
            "duration_ms": result.duration_ms,
            "chunks": len(result.chunks),
            "warnings": len(result.warnings),
        }

    return synthesize
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_runner.py tests/test_synthesize.py -q` → PASS (23 + 10); `uv run pytest -m "not db" -q` → all pass.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/jobs/runner.py src/audiotruyen_worker/jobs/synthesize.py tests/test_runner.py tests/test_synthesize.py
git commit -m "feat(worker): synthesize job with attempt fencing and skipped jobs (spec 5.1, 5.3, 5.6)"
```

---

### Task 9: cleanup_r2 handler and audio GC

**Files:**
- Create: `worker/src/audiotruyen_worker/jobs/cleanup.py`
- Test: `worker/tests/test_cleanup.py`

**Interfaces:**
- `CLEANUP_PREFIX` (exactly `audio/{uuid}/`, `audio/{uuid}/{uuid}/` or `voices/{uuid}/`), `MAX_GC_ROUNDS = 100`, `make_cleanup_handler(audio_store, storage)` → `cleanup_r2(job, ctx) -> {prefix, deleted}` (pages of live ledger keys: R2 `delete_many`, then `mark_deleted`, `ctx.check()` between pages), `run_gc(audio_store, storage) -> {deleted, stale_rows}` (deletes candidates, then drops stale `chapter_audio` rows).

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_cleanup.py`:

```python
import pytest

from audiotruyen_worker.audio_store import GcCandidate
from audiotruyen_worker.jobs.cleanup import make_cleanup_handler, run_gc
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobCancelled, JobContext, PermanentJobError

N = "aaaaaaaa-0000-0000-0000-000000000001"
C = "cccccccc-0000-0000-0000-000000000001"


class FakeStorage:
    def __init__(self):
        self.deleted: list[list[str]] = []

    def delete_many(self, keys):
        self.deleted.append(list(keys))


class FakeAudioStore:
    def __init__(self, keys=(), candidates=()):
        self.keys = sorted(keys)
        self.marked: set[str] = set()
        self.candidates = list(candidates)
        self.deleted_rows: list[str] = []

    def live_keys(self, prefix, after="", limit=1000):
        live = [k for k in self.keys if k.startswith(prefix) and k > after and k not in self.marked]
        return live[:2]  # small pages to exercise paging

    def mark_deleted(self, keys):
        new = [k for k in keys if k not in self.marked]
        self.marked.update(new)
        return len(new)

    def gc_candidates(self, limit=1000):
        live = [c for c in self.candidates if c.key not in self.marked]
        return live[:2]

    def delete_audio_rows(self, ids):
        self.deleted_rows.extend(ids)


def job(prefix):
    return Job("j", "u", "cleanup_r2", {"prefix": prefix})


def test_cleanup_deletes_every_live_key_under_the_prefix_in_pages():
    keys = [f"audio/{N}/{C}/h/1/seg-{i:04d}.webm" for i in range(5)] + [f"audio/{N}/other"]
    store, storage = FakeAudioStore(keys), FakeStorage()
    result = make_cleanup_handler(store, storage)(job(f"audio/{N}/{C}/"), JobContext(job("")))
    assert result == {"prefix": f"audio/{N}/{C}/", "deleted": 5}
    assert [len(batch) for batch in storage.deleted] == [2, 2, 1]
    assert f"audio/{N}/other" not in store.marked


@pytest.mark.parametrize(
    "prefix", ["audio/", f"audio/{N}", "audio/../x/", f"voices/{N}/../", "other/x/", ""]
)
def test_cleanup_rejects_any_other_prefix(prefix):
    with pytest.raises(PermanentJobError):
        make_cleanup_handler(FakeAudioStore(), FakeStorage())(job(prefix), JobContext(job("")))


def test_cleanup_stops_between_pages_when_cancelled():
    keys = [f"voices/{N}/{i}.wav" for i in range(6)]
    ctx = JobContext(job(""))
    ctx.cancelled.set()
    storage = FakeStorage()
    with pytest.raises(JobCancelled):
        make_cleanup_handler(FakeAudioStore(keys), storage)(job(f"voices/{N}/"), ctx)
    assert len(storage.deleted) == 1


def test_gc_deletes_candidates_and_drops_only_stale_rows():
    candidates = [
        GcCandidate("audio/n/c/h/1/init.webm", "row-a", False),
        GcCandidate("audio/n/c/h/1/seg-0000.webm", "row-a", False),
        GcCandidate("audio/n/d/old/1/init.webm", "row-b", True),
    ]
    store, storage = FakeAudioStore(candidates=candidates), FakeStorage()
    assert run_gc(store, storage) == {"deleted": 3, "stale_rows": 1}
    assert store.deleted_rows == ["row-b"]
    assert run_gc(store, storage) == {"deleted": 0, "stale_rows": 0}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_cleanup.py -q` → FAIL (`jobs.cleanup` missing).

- [ ] **Step 3: Write the implementation**

Create `worker/src/audiotruyen_worker/jobs/cleanup.py`:

```python
"""cleanup_r2 jobs and audio GC (spec 4.2, 7.3.1): delete ledger keys from R2, then mark them."""

from __future__ import annotations

import logging
import re
from typing import Any

from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.jobs.handlers import payload_str
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobContext, PermanentJobError

log = logging.getLogger(__name__)

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CLEANUP_PREFIX = re.compile(rf"^(audio/{_UUID}/({_UUID}/)?|voices/{_UUID}/)$")
MAX_GC_ROUNDS = 100


def make_cleanup_handler(audio_store: AudioStore, storage):
    def cleanup_r2(job: Job, ctx: JobContext) -> dict[str, Any]:
        prefix = payload_str(job, "prefix", 200)
        if not CLEANUP_PREFIX.match(prefix):
            raise PermanentJobError("Job dọn R2 có prefix không hợp lệ.")
        deleted, after = 0, ""
        while keys := audio_store.live_keys(prefix, after):
            storage.delete_many(keys)
            deleted += audio_store.mark_deleted(keys)
            after = keys[-1]
            ctx.check()
        return {"prefix": prefix, "deleted": deleted}

    return cleanup_r2


def run_gc(audio_store: AudioStore, storage) -> dict[str, int]:
    """Delete abandoned attempts and stale voice_hash audio, then drop the stale rows."""
    deleted, stale_rows = 0, set()
    for _ in range(MAX_GC_ROUNDS):
        candidates = audio_store.gc_candidates()
        if not candidates:
            break
        keys = [c.key for c in candidates]
        storage.delete_many(keys)
        deleted += audio_store.mark_deleted(keys)
        stale_rows.update(c.chapter_audio_id for c in candidates if c.stale)
    audio_store.delete_audio_rows(sorted(stale_rows))
    if deleted or stale_rows:
        log.info("audio GC: %d objects deleted, %d stale rows dropped", deleted, len(stale_rows))
    return {"deleted": deleted, "stale_rows": len(stale_rows)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_cleanup.py -q` → PASS (9 tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/jobs/cleanup.py tests/test_cleanup.py
git commit -m "feat(worker): cleanup_r2 jobs and audio GC from the ledger (spec 4.2, 7.3.1)"
```

---

### Task 10: Wiring — `worker run` with TTS preload, CLI commands, doctor

**Files:**
- Modify: `worker/src/audiotruyen_worker/app.py` (full replacement), `worker/src/audiotruyen_worker/cli.py` (full replacement), `worker/src/audiotruyen_worker/doctor.py` (full replacement), `worker/src/audiotruyen_worker/admin.py` (append `enqueue_synthesize`)
- Test: `worker/tests/test_cli_logging.py` (full replacement), `worker/tests/test_doctor.py` (append), `worker/tests/test_db_synthesize.py` (create)

**Interfaces:**
- `app`: `make_tts(settings, *, fake) -> TTSProvider`, `preload(tts)` (background load thread), `build_runner(settings, tts) -> (Runner, AudioStore, R2Storage)` (handlers: search, fetch_novel, fetch_chapter, synthesize, cleanup_r2; device = `tts.device`), `run_worker(settings, *, once=False, fake_tts=False)` (runs GC once at start; preloads VieNeu unless `--once`).
- `cli`: `worker run [--once] [--fake-tts]`, `worker enqueue {search,fetch-novel,fetch-chapter,synthesize} VALUE`, `worker init-voices [--email]`, `worker gc`; doctor adds `libopus`.
- `admin.enqueue_synthesize(client, user_id, chapter_id, priority=0) -> str` (payload carries `current_voice_hash(novel)`; `LookupError` for a chapter the owner does not have).
- `doctor.check_libopus(ffmpeg="ffmpeg") -> str`.

- [ ] **Step 1: Write the failing tests**

Replace `worker/tests/test_cli_logging.py` with:

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
    monkeypatch.setattr(cli, "_run", lambda once, fake: calls.append(("run", once, fake)) or 0)
    monkeypatch.setattr(cli, "_enqueue", lambda *a: calls.append(("enqueue", *a)) or 0)
    monkeypatch.setattr(cli, "_init_voices", lambda email: calls.append(("voices", email)) or 0)
    monkeypatch.setattr(cli, "_gc", lambda: calls.append(("gc",)) or 0)
    assert cli.main(["run", "--once"]) == 0
    assert cli.main(["run", "--fake-tts"]) == 0
    assert cli.main(["enqueue", "fetch-novel", "https://truyenfull.live/a/"]) == 0
    assert cli.main(["enqueue", "synthesize", "c-1", "--priority", "10"]) == 0
    assert cli.main(["init-voices", "--email", "a@x"]) == 0
    assert cli.main(["gc"]) == 0
    assert calls == [
        ("run", True, False),
        ("run", False, True),
        ("enqueue", "fetch-novel", "https://truyenfull.live/a/", None, 0),
        ("enqueue", "synthesize", "c-1", None, 10),
        ("voices", "a@x"),
        ("gc",),
    ]


def test_log_dir_is_worker_logs():
    assert (cli.LOG_DIR.parent.name, cli.LOG_DIR.name) == ("worker", "logs")


def _patch_enqueue(monkeypatch, *, resolve=None, enqueue=None):
    from audiotruyen_worker import admin, db

    calls = []
    monkeypatch.setattr(cli, "load_settings", lambda: calls.append("settings") or object())
    monkeypatch.setattr(db, "make_client", lambda settings: calls.append("client") or object())
    monkeypatch.setattr(admin, "resolve_owner_id", resolve or (lambda client, email: "u1"))
    monkeypatch.setattr(
        admin, "enqueue_job", enqueue or (lambda client, user_id, kind, value, priority: "job-1")
    )
    return calls


def _raiser(exc):
    def raise_(*args):
        raise exc

    return raise_


def test_enqueue_reports_success(monkeypatch, capsys):
    _patch_enqueue(monkeypatch)
    assert cli.main(["enqueue", "search", "đấu phá"]) == 0
    assert "job-1" in capsys.readouterr().out


def test_enqueue_without_a_single_account_asks_for_email(monkeypatch, capsys):
    _patch_enqueue(monkeypatch, resolve=_raiser(LookupError("expected exactly one account")))
    assert cli.main(["enqueue", "search", "đấu phá"]) == 1
    err = capsys.readouterr().err
    assert "Không tìm thấy tài khoản. Dùng --email để chọn tài khoản." in err
    assert "expected exactly one" not in err


@pytest.mark.parametrize(
    "exc",
    [
        ValueError("cannot enqueue job type 'zzleak'"),
        __import__("postgrest.exceptions", fromlist=["APIError"]).APIError(
            {"message": "jobs: queue limit zzleak", "code": "54000"}
        ),
    ],
)
def test_enqueue_rejected_job_prints_vietnamese_without_raw_text(monkeypatch, capsys, exc):
    _patch_enqueue(monkeypatch, enqueue=_raiser(exc))
    assert cli.main(["enqueue", "fetch-chapter", "c1"]) == 1
    err = capsys.readouterr().err
    assert "Không thêm được job: dữ liệu không hợp lệ." in err
    assert "zzleak" not in err


@pytest.mark.parametrize("value", ["", "   "])
def test_enqueue_rejects_a_blank_value_before_any_network_call(monkeypatch, capsys, value):
    calls = _patch_enqueue(monkeypatch)
    assert cli.main(["enqueue", "search", value]) == 1
    assert "Giá trị không được để trống." in capsys.readouterr().err
    assert calls == []


class _AudioClient(_Client):
    def __init__(self, chapters):
        super().__init__([])
        self.chapters = chapters

    def table(self, name):
        if name != "chapters":
            return super().table(name)
        client = self

        class _Q:
            def select(self, cols):
                return self

            def eq(self, col, value):
                client.filters = getattr(client, "filters", []) + [(col, value)]
                return self

            def execute(self):
                return type("R", (), {"data": client.chapters})()

        return _Q()

    def rpc(self, name, params):
        assert name == "current_voice_hash" and params == {"p_novel_id": "n-1"}
        return type("X", (), {"execute": lambda self: type("R", (), {"data": "vh16"})()})()


def test_enqueue_synthesize_uses_the_current_voice_hash():
    from audiotruyen_worker.admin import enqueue_synthesize

    client = _AudioClient([{"novel_id": "n-1"}])
    assert enqueue_synthesize(client, "u1", "c-1", 10) == "job-1"
    assert client.filters == [("id", "c-1"), ("user_id", "u1")]
    assert client.inserted == [
        (
            "jobs",
            {
                "user_id": "u1",
                "type": "synthesize",
                "payload": {"chapter_id": "c-1", "voice_hash": "vh16"},
                "priority": 10,
            },
        )
    ]
    with pytest.raises(LookupError):
        enqueue_synthesize(_AudioClient([]), "u1", "c-1")


def test_init_voices_sets_one_default_per_role():
    from audiotruyen_worker.admin import init_voices

    class _Store:
        def __init__(self):
            self.calls = []

        def clear_default_flags(self, user_id):
            self.calls.append(("clear", user_id))

        def upsert_preset_voice(self, user_id, name, gender, *, narrator, male, female):
            self.calls.append((name, gender, narrator, male, female))
            return f"id-{name}"

    store = _Store()
    assert init_voices(store, "u1") == ["id-Đức Trí", "id-Thái Sơn", "id-Mỹ Duyên"]
    assert store.calls == [
        ("clear", "u1"),
        ("Đức Trí", "male", True, False, False),
        ("Thái Sơn", "male", False, True, False),
        ("Mỹ Duyên", "female", False, False, True),
    ]
```

Append to `worker/tests/test_doctor.py`:

```python
def test_check_libopus_with_the_real_ffmpeg():
    from audiotruyen_worker.doctor import check_libopus

    assert check_libopus() == "libopus encoder available"
```

Create `worker/tests/test_db_synthesize.py`:

```python
import boto3
import pytest
from moto import mock_aws

from audiotruyen_worker.admin import enqueue_synthesize, init_voices
from audiotruyen_worker.audio.baselines import Baselines
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.jobs.cleanup import make_cleanup_handler
from audiotruyen_worker.jobs.handlers import ChapterPreparer
from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.runner import Runner
from audiotruyen_worker.jobs.synthesize import make_synthesize_handler
from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.storage.r2 import R2Storage
from audiotruyen_worker.store import Store
from audiotruyen_worker.tts.fake import FakeTTS

pytestmark = pytest.mark.db

TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần. " + "Gió thổi qua rừng già. " * 40


@pytest.fixture
def r2():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="audiotruyen")
        yield R2Storage(client, "audiotruyen")


def _novel_with_chapter(admin_client, owner_id, text=TEXT):
    store = Store(admin_client)
    info = NovelInfo(
        f"m2b-{owner_id[:8]}", "https://truyenfull.live/a/", "a", "A", None, None, None, None
    )
    novel_id = store.upsert_novel(owner_id, info)
    store.upsert_chapters(
        owner_id, novel_id, [ChapterRef(1, "Chương 1", "https://truyenfull.live/a/chuong-1/")]
    )
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    if text is not None:
        store.save_chapter_text(chapter_id, text, "t-" + chapter_id[:8])
    return store, novel_id, chapter_id


def test_synthesize_job_end_to_end_then_cleanup_on_delete(admin_client, owner, r2):
    store, novel_id, chapter_id = _novel_with_chapter(admin_client, owner["id"])
    audio = AudioStore(admin_client)
    init_voices(audio, owner["id"])
    tts = FakeTTS()
    guarded = GuardedStorage(r2, admin_client, enabled=True, max_bytes=8 * 1024**3, max_puts=10**9)
    handlers = {
        "synthesize": make_synthesize_handler(
            preparer=ChapterPreparer(None, store, [HeuristicStrategy()]),
            store=store, audio_store=audio, storage=guarded, tts=tts, baselines=Baselines(tts),
        ),
        "cleanup_r2": make_cleanup_handler(audio, r2),
    }  # fmt: skip
    runner = Runner(JobQueue(admin_client, "w-m2b"), handlers, version="t", device="fake")
    enqueue_synthesize(admin_client, owner["id"], chapter_id)
    assert runner.run_once() is True
    row = (
        admin_client.table("chapter_audio")
        .select("*")
        .eq("chapter_id", chapter_id)
        .execute()
        .data[0]
    )
    assert (row["status"], row["provider"], row["attempt"]) == ("ready", "fake", 1)
    keys = [row["init_key"], *[c["key"] for c in row["chunks"]], row["full_key"]]
    assert all(r2.exists(k) for k in keys)
    prefix = f"audio/{novel_id}/{chapter_id}/"
    assert sorted(audio.live_keys(prefix)) == sorted(keys)
    assert row["segments"] and row["segments"][-1]["end_ms"] <= row["duration_ms"]
    job = (
        admin_client.table("jobs")
        .select("status")
        .eq("type", "synthesize")
        .eq("user_id", owner["id"])
        .execute()
        .data
    )
    assert [j["status"] for j in job] == ["done"]

    admin_client.table("chapters").delete().eq("id", chapter_id).execute()
    assert runner.run_once() is True  # the cleanup_r2 job the delete trigger enqueued
    assert audio.live_keys(prefix) == []
    assert not any(r2.exists(k) for k in keys)
    admin_client.table("worker_status").delete().eq("worker_id", "w-m2b").execute()


def test_outdated_voice_hash_job_is_cancelled(admin_client, owner, r2):
    store, novel_id, chapter_id = _novel_with_chapter(admin_client, owner["id"])
    audio = AudioStore(admin_client)
    init_voices(audio, owner["id"])
    tts = FakeTTS()
    handlers = {
        "synthesize": make_synthesize_handler(
            preparer=ChapterPreparer(None, store, [HeuristicStrategy()]), store=store,
            audio_store=audio, storage=GuardedStorage(r2, admin_client, enabled=True,
            max_bytes=8 * 1024**3, max_puts=10**9), tts=tts, baselines=Baselines(tts),
        )
    }  # fmt: skip
    admin_client.table("jobs").insert({
        "user_id": owner["id"], "type": "synthesize",
        "payload": {"chapter_id": chapter_id, "voice_hash": "0000000000000000"},
    }).execute()  # fmt: skip
    Runner(JobQueue(admin_client, "w-m2b-2"), handlers, version="t", device="fake").run_once()
    (row,) = (
        admin_client.table("jobs")
        .select("status,result")
        .eq("type", "synthesize")
        .eq("user_id", owner["id"])
        .execute()
        .data
    )
    assert row["status"] == "cancelled" and "đã đổi" in row["result"]["reason"]
    assert (
        admin_client.table("chapter_audio").select("id").eq("chapter_id", chapter_id).execute().data
        == []
    )
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_cli_logging.py tests/test_doctor.py -q` → FAIL (`_init_voices`, `_gc`, `enqueue_synthesize`, `check_libopus` missing).

- [ ] **Step 3: Write the implementation**

Append to `worker/src/audiotruyen_worker/admin.py` (two blank lines before it):

```python
def enqueue_synthesize(client, user_id: str, chapter_id: str, priority: int = 0) -> str:
    """Insert a synthesize job for an owned chapter with the novel's current voice_hash."""
    rows = (
        client.table("chapters")
        .select("novel_id")
        .eq("id", chapter_id)
        .eq("user_id", user_id)
        .execute()
        .data
    )
    if not rows:
        raise LookupError(f"no chapter {chapter_id} for this owner")
    voice_hash = (
        client.rpc("current_voice_hash", {"p_novel_id": rows[0]["novel_id"]}).execute().data
    )
    row = {
        "user_id": user_id,
        "type": "synthesize",
        "payload": {"chapter_id": chapter_id, "voice_hash": voice_hash},
        "priority": priority,
    }
    return client.table("jobs").insert(row).execute().data[0]["id"]
```

Replace `worker/src/audiotruyen_worker/doctor.py` with:

```python
"""Connectivity checks for `worker doctor`."""

from __future__ import annotations

import shutil
import subprocess
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
    # Broad on purpose: doctor reports every failure as a result instead of crashing.
    except Exception as exc:
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


def check_libopus(ffmpeg: str = "ffmpeg") -> str:
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True
    ).stdout
    if " libopus " not in out:
        raise RuntimeError("ffmpeg has no libopus encoder (install a full ffmpeg build)")
    return "libopus encoder available"
```

Replace `worker/src/audiotruyen_worker/app.py` with:

```python
"""`worker run`: wires the job loop, heartbeat, Realtime wake, TTS and R2 for all job types."""

from __future__ import annotations

import logging
import threading
from importlib.metadata import version

from audiotruyen_worker.audio.baselines import Baselines
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.config import Settings
from audiotruyen_worker.db import make_client
from audiotruyen_worker.jobs.cleanup import make_cleanup_handler, run_gc
from audiotruyen_worker.jobs.handlers import ChapterPreparer, make_handlers
from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.runner import Heartbeat, Runner
from audiotruyen_worker.jobs.synthesize import make_synthesize_handler
from audiotruyen_worker.jobs.wake import RealtimeWake
from audiotruyen_worker.sources.truyenfull import TruyenfullAdapter
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.storage.r2 import R2Storage
from audiotruyen_worker.store import Store
from audiotruyen_worker.tts.base import TTSProvider
from audiotruyen_worker.tts.fake import FakeTTS
from audiotruyen_worker.tts.vieneu_provider import VieneuProvider

log = logging.getLogger(__name__)

WORKER_VERSION = version("audiotruyen-worker")


def make_tts(settings: Settings, *, fake: bool) -> TTSProvider:
    return FakeTTS() if fake else VieneuProvider(settings.models_dir, settings.tts_device)


def preload(tts: TTSProvider) -> None:
    """Load VieNeu in the background at start (about 30 s), so the first synthesize job meets
    the first-cluster budget (spec 7.3.2) instead of paying the load."""
    load = getattr(tts, "load", None)
    if load is None:
        return

    def run() -> None:
        try:
            load()
        except Exception:  # the synthesize job reports it to the owner
            log.exception("VieNeu preload failed")

    threading.Thread(target=run, name="tts-preload", daemon=True).start()


def build_runner(settings: Settings, tts: TTSProvider) -> tuple[Runner, AudioStore, R2Storage]:
    client = make_client(settings)
    store = Store(client)
    audio_store = AudioStore(client)
    r2 = R2Storage.from_settings(settings)
    adapter = TruyenfullAdapter()
    strategies = [HeuristicStrategy()]
    guarded = GuardedStorage(
        r2,
        client,
        enabled=settings.r2_uploads_enabled,
        max_bytes=settings.r2_max_bytes,
        max_puts=settings.r2_max_puts_per_month,
    )
    handlers = make_handlers(adapter, store, strategies)
    handlers["synthesize"] = make_synthesize_handler(
        preparer=ChapterPreparer(adapter, store, strategies),
        store=store,
        audio_store=audio_store,
        storage=guarded,
        tts=tts,
        baselines=Baselines(tts),
    )
    handlers["cleanup_r2"] = make_cleanup_handler(audio_store, r2)
    runner = Runner(
        JobQueue(client, settings.worker_id),
        handlers,
        version=WORKER_VERSION,
        device=lambda: tts.device,
    )
    return runner, audio_store, r2


def run_worker(settings: Settings, *, once: bool = False, fake_tts: bool = False) -> None:
    """Run until Ctrl+C. With once=True, drain the queue and return (no Realtime, no heartbeat)."""
    tts = make_tts(settings, fake=fake_tts)
    runner, audio_store, r2 = build_runner(settings, tts)
    try:
        run_gc(audio_store, r2)
    except Exception:  # GC is housekeeping; never block the worker on it
        log.exception("audio GC failed")
    if once:
        runner.beat()
        while runner.run_once():
            pass
        return
    preload(tts)
    stop = threading.Event()
    key = settings.supabase_service_role_key.get_secret_value()
    Heartbeat(runner, JobQueue(make_client(settings), settings.worker_id), stop).start()
    RealtimeWake(settings.supabase_url, key, runner.wake, stop).start()
    log.info("worker %s %s started (tts=%s)", settings.worker_id, WORKER_VERSION, tts.name)
    try:
        runner.run_forever(stop)
    finally:
        stop.set()
        log.info("worker stopped")
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
from audiotruyen_worker.doctor import (
    check_ffmpeg,
    check_libopus,
    check_r2,
    check_supabase,
    run_check,
)


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
        run_check("libopus", check_libopus),
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


def _run(once: bool, fake_tts: bool) -> int:
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
        run_worker(settings, once=once, fake_tts=fake_tts)
    except KeyboardInterrupt:
        print("Đã dừng worker.")
    return 0


def _enqueue(kind: str, value: str, email: str | None, priority: int) -> int:
    from postgrest.exceptions import APIError

    from audiotruyen_worker.admin import enqueue_job, enqueue_synthesize, resolve_owner_id
    from audiotruyen_worker.db import make_client

    if not value.strip():
        print("Giá trị không được để trống.", file=sys.stderr)
        return 1
    # Outside the try: a settings error (pydantic's ValidationError is a ValueError) is not
    # bad job data.
    client = make_client(load_settings())
    # Messages only: raw exception text can carry database details, never print it here.
    try:
        owner = resolve_owner_id(client, email)
        if kind == "synthesize":
            job_id = enqueue_synthesize(client, owner, value.strip(), priority)
        else:
            job_id = enqueue_job(client, owner, kind.replace("-", "_"), value, priority)
    except LookupError:
        print("Không tìm thấy tài khoản. Dùng --email để chọn tài khoản.", file=sys.stderr)
        return 1
    except (ValueError, APIError):
        print("Không thêm được job: dữ liệu không hợp lệ.", file=sys.stderr)
        return 1
    print(f"Đã thêm job {kind} ({job_id}).")
    return 0


def _init_voices(email: str | None) -> int:
    from audiotruyen_worker.admin import init_voices, resolve_owner_id
    from audiotruyen_worker.audio_store import AudioStore
    from audiotruyen_worker.db import make_client

    client = make_client(load_settings())
    try:
        owner = resolve_owner_id(client, email)
    except LookupError:
        print("Không tìm thấy tài khoản. Dùng --email để chọn tài khoản.", file=sys.stderr)
        return 1
    init_voices(AudioStore(client), owner)
    print("Đã tạo giọng mặc định: Đức Trí (dẫn truyện), Thái Sơn (nam), Mỹ Duyên (nữ).")
    return 0


def _gc() -> int:
    from audiotruyen_worker.audio_store import AudioStore
    from audiotruyen_worker.db import make_client
    from audiotruyen_worker.jobs.cleanup import run_gc
    from audiotruyen_worker.storage.r2 import R2Storage

    settings = load_settings()
    result = run_gc(AudioStore(make_client(settings)), R2Storage.from_settings(settings))
    print(f"Đã dọn {result['deleted']} file audio, {result['stale_rows']} bản audio cũ.")
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
    run.add_argument(
        "--fake-tts", action="store_true", help="sine tones instead of VieNeu (tests, E2E)"
    )
    enqueue = sub.add_parser(
        "enqueue", help="add a job for the owner (testing without the web app)"
    )
    enqueue.add_argument("kind", choices=["search", "fetch-novel", "fetch-chapter", "synthesize"])
    enqueue.add_argument("value", help="search query, novel URL or chapter id")
    enqueue.add_argument("--email", help="owner email (default: the only account)")
    enqueue.add_argument("--priority", type=int, choices=[0, 10, 20], default=0)
    voices = sub.add_parser("init-voices", help="create the three default preset voices")
    voices.add_argument("--email", help="owner email (default: the only account)")
    sub.add_parser("gc", help="delete abandoned and stale audio from R2 now")
    create = sub.add_parser("create-user", help="create the owner account (password prompted)")
    create.add_argument("--email", required=True)
    reset = sub.add_parser("set-password", help="set a new password for an existing account")
    reset.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    if args.command == "run":
        return _run(args.once, args.fake_tts)
    if args.command == "init-voices":
        return _init_voices(args.email)
    if args.command == "gc":
        return _gc()
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

- [ ] **Step 4: Run all tests**

Run: `uv run pytest -m "not db" -q` → PASS (232 tests).
Run (DB env loaded): `uv run pytest -m db -q -rs` → PASS (17 tests, 0 skipped; `test_db_synthesize` runs a full synthesize job with the fake TTS and moto R2, then the delete-triggered `cleanup_r2` job).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix . && uv run ruff format .
git add src/audiotruyen_worker/app.py src/audiotruyen_worker/cli.py src/audiotruyen_worker/doctor.py src/audiotruyen_worker/admin.py tests/test_cli_logging.py tests/test_doctor.py tests/test_db_synthesize.py
git commit -m "feat(worker): worker run with TTS preload and GC; enqueue synthesize, init-voices, gc; libopus doctor check (spec 5.9, 7.3.2)"
```

---

### Task 11: Spec and CLAUDE.md, full verification, GPU smoke test

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md`, `CLAUDE.md`

- [ ] **Step 1: Update the spec**

1. Section 2.2, VieNeu row, "Fit for 4 GB" cell: after "ONNX CPU (published ~2x realtime) not verified." replace that sentence with "M2b (2026-10-22): clone RTF 0.37-0.39 (`ref_audio`), ONNX CPU fp32 RTF 0.67-0.75 (preset) / 0.97 (clone) once the model loads from a dedicated cache (5.6), torch peak 773 MiB."
2. Section 4, after the M2a migrations paragraph, add:

```markdown
M2b (migration `20261022000100`) adds the `r2_objects` ledger and `r2_monthly_puts` (7.3.1) with `r2_reserve_upload` (atomic cap check + record before every PUT), `r2_mark_deleted`, `r2_usage`, `r2_live_keys`, `r2_gc_candidates`; AFTER DELETE triggers on `novels`, `chapters` and `voices` that enqueue one `cleanup_r2` job per prefix when the ledger has live objects there (skipped during cascades); `chapter_audio.text_hash` (the chapter text the audio was made from: `begin_chapter_audio` starts a new attempt when a ready row's text changed); and `current_voice_hash(novel_id)` (4.2), the only implementation of the hash, callable by the web app (security invoker, RLS) and the worker.
```

3. Section 4.2: replace "`sha256(narrator_voice_id, default_male_id, default_female_id, sorted(character→voice overrides for this novel), lexicon_version, pipeline_version)[:16]`." with "`current_voice_hash(novel_id)` (SQL, M2b): first 16 hex chars of sha256 over `pipeline=m2b-1`, the default narrator/male/female voice ids, the novel's character→voice overrides sorted by name, and the enabled lexicon rules (global then the novel's, by position). Bump the pipeline string when encoding or normalization changes."
4. Section 5.1, first bullet: replace "load VieNeu lazily on first `synthesize`." with "load VieNeu in a background thread (`worker run`; about 30 s on the GTX 1650) so the first `synthesize` job meets the first-cluster budget; `--once` loads lazily."
5. Section 5.6: in the `vieneu` provider bullet replace "M2 must load the ONNX model from a real `local_dir` (or pin `huggingface_hub<1.0`) and re-benchmark CPU RTF before relying on it." with "Fixed in M2b: the worker uses its own Hugging Face cache (`worker/models/hf`, `HF_HUB_CACHE`) with huggingface_hub 0.36, whose per-repo blob folders pass onnxruntime's external-data check; CPU RTF 0.67-0.75."; in the encoder command replace `-cluster_time_limit 30000` with `-cluster_time_limit 10000`, and after the command add: "10 s clusters (M2b): with 30 s clusters the first upload came 10.75 s after job start on the GTX 1650 (over 7.3.2), with 10 s clusters 5.05 s; about 53 PUTs per 8.5-minute chapter. ffmpeg 9 writes each finished Cluster with its size; the splitter accepts sized and unknown-size Clusters." Replace "Synthesis order is sequential so the first cluster is ready within seconds of job start." with "Synthesis runs on the job thread and an uploader thread uploads each cluster as it appears (pipelined); measured: 509.6 s of audio in 156 s after load (RTF 0.31 with guard retries), 724 KB per audio minute for cluster segments + `full.webm`." In the quality-guard bullet add: "M2b measured the narrator preset over 60 raw takes: median 0.73e-3, p95 1.48e-3; 2.5x baseline re-synthesizes 7 % of takes; the guard measures the raw take."
6. Section 7.3.1: append to "Storage cap (M2)": " Implemented in M2b by `r2_reserve_upload`, which records the object before the PUT (a failed PUT stays counted, erring on the safe side)."
7. Section 8, M2 row: append "M2b (`docs/superpowers/plans/2026-10-22-m2b-worker-audio.md`): synthesis, live encode, R2 ledger/caps/cleanup, GC."
8. Section 9, "R2 free 10 GB exhausted" row: replace "~2 MB/chapter at 48 kbps ≈ 5,000 chapters" with "~6.3 MB per 8.5-minute chapter (cluster segments + `full.webm`, 48 kbps; owner decision 2026-10-22) ≈ 1,300 chapters within the 8 GiB cap".

- [ ] **Step 2: Update CLAUDE.md**

In "Commands", replace the worker block's `uv sync` line with:

```
    uv sync                       # no TTS (CI, fake TTS)
    uv sync --extra cuda          # + VieNeu on the GPU (torch cu128, about 3 GB); --extra tts = CPU/ONNX only
```

and add after `uv run worker enqueue ...`:

```
    uv run worker run --fake-tts  # sine tones instead of VieNeu (tests, E2E)
    uv run worker init-voices     # create the default voices Đức Trí / Thái Sơn / Mỹ Duyên
    uv run worker enqueue synthesize <chapter-id>
    uv run worker gc              # delete abandoned and stale audio from R2
```

In "Rules", add: "- Every R2 upload goes through `storage/guard.py` `GuardedStorage.put` (kill switch, byte and PUT caps, ledger); never call `R2Storage.put_bytes` for audio directly."

- [ ] **Step 3: Full verification and GPU smoke test**

```bash
npx --yes supabase@2.121.0 db reset && npx --yes supabase@2.121.0 test db
cd worker && uv run ruff check . && uv run ruff format --check . && uv run pytest -m "not db" -q
cd .. && set -a; source <(bash scripts/supabase-test-env.sh); set +a; cd worker && uv run pytest -m db -q -rs
```

Expected: pgTAP 9 files / 175 tests pass; ruff clean; unit 232 pass; DB 17 pass, 0 skipped.

GPU smoke against **local** Supabase, with local Supabase Storage's S3 endpoint standing in for R2 (Git Bash, from the repo root; first `uv sync --extra cuda` in `worker/`):

```bash
eval "$(npx --yes supabase@2.121.0 status -o env 2>/dev/null | grep -E '^(API_URL|SERVICE_ROLE_KEY|S3_PROTOCOL_ACCESS_KEY_ID|S3_PROTOCOL_ACCESS_KEY_SECRET|STORAGE_S3_URL)=')"
cd worker
export SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY WORKER_ID=local-gpu
export R2_ACCOUNT_ID=local R2_ACCESS_KEY_ID=$S3_PROTOCOL_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY=$S3_PROTOCOL_ACCESS_KEY_SECRET R2_BUCKET=audiotruyen R2_ENDPOINT_URL=$STORAGE_S3_URL
echo "$SUPABASE_URL $R2_ENDPOINT_URL"   # must both be http://127.0.0.1:54321...
uv run python -c "import os, boto3; boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT_URL'], aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto').create_bucket(Bucket='audiotruyen')"
uv run python -c "import os,secrets; from supabase import create_client; from audiotruyen_worker.admin import create_owner; c=create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY']); print(create_owner(c, 'gpu@audiotruyen.test', secrets.token_urlsafe(18)))"
uv run --extra cuda worker init-voices
uv run --extra cuda worker enqueue fetch-novel https://truyenfull.live/bao-long-than-tham/
uv run --extra cuda worker run --once --fake-tts
```

Then take the id of chapter index 1 (Supabase Studio http://127.0.0.1:54323 → `chapters`) and:

```bash
uv run --extra cuda worker enqueue synthesize <chapter-id>
uv run --extra cuda worker run --once
```

Expected: the log shows `VieNeu loaded (device=cuda, ...)` and `chapter ... attempt 1 ready: ~509000 ms, ~51 clusters`; `chapter_audio` is `ready` with `provider = vieneu`; `select * from r2_usage()` shows `live_bytes` equal to the sum of the uploaded objects. Record the numbers (duration, clusters, warnings, total seconds) in the commit message body, then `npx --yes supabase@2.121.0 db reset` from the repo root.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-audiotruyen-v2-design.md CLAUDE.md
git commit -m "docs: M2b spec updates (10 s clusters, preload, ONNX fix, measured speed and storage) and worker commands"
```

---

### Task 12 (controller only, not a subagent): cloud apply, merge, push, owner checks

- [ ] **Step 1:** Ask the owner for approval to apply `20261022000100_m2b_audio.sql` to production (CLAUDE.md step 0).
- [ ] **Step 2:** Pre-check (read-only): `select version from supabase_migrations.schema_migrations` must end at `20261019000300`; `select count(*) from chapter_audio` (expected 0; the new column is nullable either way).
- [ ] **Step 3:** Apply per CLAUDE.md steps 1-4 (local `test db` green; one request with the file + `insert into supabase_migrations.schema_migrations (version, name) values ('20261022000100', 'm2b_audio') on conflict do nothing;`); verify: version listed, RLS on every public table (incl. `r2_objects`, `r2_monthly_puts`), function ACLs = the `06_privileges` allow-lists, `notify pgrst, 'reload schema';`. Token in memory or a header file deleted right after.
- [ ] **Step 4:** Update CLAUDE.md "Database rules" applied list with `20261022000100`; commit on the branch.
- [ ] **Step 5:** Final branch review, merge `rework/m2b` into `main`, secret scan of the diff, push, confirm CI green (the new ffmpeg step).
- [ ] **Step 6 (owner, with approval):** on the laptop: `uv sync --extra cuda` in `worker/`, `uv run worker doctor` (libopus OK), `uv run worker init-voices` (production), then synthesize one chapter on production (writes about 6 MB to R2) and listen to it.
- [ ] **Step 7 (owner, Cloudflare dashboard):** spec 7.3.1 lifecycle rule: R2 → bucket `audiotruyen` → Settings → Object lifecycle rules → add "delete objects with prefix `_doctor/` after 1 day". The worker token is bucket-scoped Object Read & Write and cannot change bucket settings; `worker doctor` already deletes its probe immediately, so this is a safety net only.
