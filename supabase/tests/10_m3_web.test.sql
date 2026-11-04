-- M3: read-path indexes, per-user API rate limiter, web vitals.
begin;
select plan(55);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@audiotruyen.test', '{}', '{}', now(), now());

-- Indexes
select has_index('public', 'jobs', 'jobs_fetch_chapter_dedupe', 'one live fetch_chapter job per owner and chapter');
select has_index('public', 'jobs', 'jobs_fetch_novel_dedupe', 'one live fetch_novel job per owner and url');
select has_index('public', 'progress', 'progress_owner_recent', 'progress (user_id, updated_at desc)');
select has_index('public', 'novels', 'novels_owner_recent', 'novels (user_id, created_at desc)');
select has_index('public', 'jobs', 'jobs_chapter_latest', 'jobs latest per chapter');
select has_index('public', 'progress', 'progress_novel_id_idx', 'FK index progress.novel_id');
select has_index('public', 'progress', 'progress_chapter_id_idx', 'FK index progress.chapter_id');
select has_index('public', 'listened_chapters', 'listened_chapters_chapter_id_idx', 'FK index listened_chapters.chapter_id');
select has_index('public', 'bookmarks', 'bookmarks_chapter_id_idx', 'FK index bookmarks.chapter_id');
select has_index('public', 'listen_sessions', 'listen_sessions_chapter_id_idx', 'FK index listen_sessions.chapter_id');
select has_index('public', 'characters', 'characters_voice_id_idx', 'FK index characters.voice_id');
select has_index('public', 'worker_status', 'worker_status_current_job_idx', 'FK index worker_status.current_job');
select has_index('public', 'web_vitals', 'web_vitals_owner_time', 'web_vitals (user_id, created_at desc)');

-- Tables, RLS and grants
select has_table('public', 'web_vitals', 'web_vitals exists');
select has_table('public', 'api_rate_limits', 'api_rate_limits exists');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.web_vitals'::regclass, 'public.api_rate_limits'::regclass)),
  'both new tables have row level security'
);
select is(
  (select array_agg(policyname || ':' || cmd order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'web_vitals'),
  array['web_vitals_owner_read:SELECT'], 'web_vitals has only the owner select policy'
);
select is_empty(
  $$select policyname from pg_policies where schemaname = 'public' and tablename = 'api_rate_limits'$$,
  'api_rate_limits has no policies'
);
select is_empty(
  $$select priv from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
     where has_table_privilege('authenticated', 'public.api_rate_limits', priv)
        or has_table_privilege('anon', 'public.api_rate_limits', priv)$$,
  'api_rate_limits is closed to authenticated and anon'
);
select is_empty(
  $$select priv from unnest(array['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
     where has_table_privilege('authenticated', 'public.web_vitals', priv)
        or has_table_privilege('anon', 'public.web_vitals', priv)$$,
  'web_vitals is read-only for authenticated and closed to anon'
);
select ok(has_table_privilege('authenticated', 'public.web_vitals', 'select'), 'authenticated can select web_vitals');
select ok(not has_function_privilege('anon', 'public.api_rate_limit_hit(text)', 'execute'), 'anon cannot execute api_rate_limit_hit');
select ok(not has_function_privilege('anon', 'public.record_web_vitals(jsonb)', 'execute'), 'anon cannot execute record_web_vitals');
select ok(not has_function_privilege('service_role', 'public.api_rate_limit_hit(text)', 'execute'), 'service_role does not execute api_rate_limit_hit');
select ok(not has_function_privilege('service_role', 'public.record_web_vitals(jsonb)', 'execute'), 'service_role does not execute record_web_vitals');

-- Rate limiter, user A
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select is(
  (select count(*) filter (where public.api_rate_limit_hit('audio_urls'))::int from generate_series(1, 60)),
  60, 'the first 60 audio_urls hits are within the limit'
);
select is(public.api_rate_limit_hit('audio_urls'), false, 'the 61st audio_urls hit is refused');
select throws_ok($$select public.api_rate_limit_hit('nope')$$, '22023', null, 'an unknown bucket is refused');
-- Stale windows are removed on the next call.
reset role;
insert into public.api_rate_limits (user_id, bucket, window_start, hits)
values ('11111111-1111-1111-1111-111111111111', 'audio_urls', now() - interval '2 hours', 5);
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select public.api_rate_limit_hit('audio_urls');
reset role;
select is(
  (select count(*)::int from public.api_rate_limits
    where user_id = '11111111-1111-1111-1111-111111111111' and window_start < now() - interval '1 hour'),
  0, 'rows of past windows are deleted by the next call'
);
select is(
  (select hits from public.api_rate_limits
    where user_id = '11111111-1111-1111-1111-111111111111' and bucket = 'audio_urls'),
  62, 'the current window kept counting'
);

-- Counters are per user
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}';
select is(public.api_rate_limit_hit('audio_urls'), true, 'user B has their own counter');

-- No session
set local request.jwt.claims to '{"role": "authenticated"}';
select throws_ok($$select public.api_rate_limit_hit('audio_urls')$$, '42501', null, 'api_rate_limit_hit needs auth.uid()');
select throws_ok($$select public.record_web_vitals('[]'::jsonb)$$, '42501', null, 'record_web_vitals needs auth.uid()');
select throws_ok(
  $$insert into public.web_vitals (user_id, name, value, route) values ('11111111-1111-1111-1111-111111111111', 'LCP', 1, '/')$$,
  '42501', null, 'direct inserts into web_vitals are refused'
);
select throws_ok($$select count(*) from public.api_rate_limits$$, '42501', null, 'the limiter table cannot be read');

-- Web vitals, user A
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select is(
  public.record_web_vitals('[{"name":"LCP","value":812.5,"rating":"good","route":"/"},{"name":"XX","value":1,"route":"/"}]'::jsonb),
  1, 'valid samples are stored, invalid ones are ignored'
);
select is((select count(*)::int from public.web_vitals), 1, 'user A sees their sample');
select is(
  (select row(name, value, rating, route, user_id)::text from public.web_vitals),
  '(LCP,812.5,good,/,11111111-1111-1111-1111-111111111111)', 'the sample belongs to the caller'
);
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}';
select is((select count(*)::int from public.web_vitals), 0, 'user B sees none');

-- Filtering rules, user B (vitals calls so far: 0)
select is(public.record_web_vitals('{"name":"LCP"}'::jsonb), 0, 'non-array input stores nothing');
select is(
  public.record_web_vitals($j$[
    {"name":"TTFB","value":0,"route":"/read/x/1"},
    {"name":"CLS","value":-1,"route":"/"},
    {"name":"CLS","value":1e7,"route":"/"},
    {"name":"CLS","value":"0.1","route":"/"},
    {"name":"CLS","value":0.1,"rating":"fine","route":"/"},
    {"name":"CLS","value":0.1,"route":""},
    {"name":"CLS","value":0.1,"route":5},
    {"name":"CLS","value":1e400,"route":"/"},
    7,
    null
  ]$j$::jsonb),
  1, 'malformed samples are filtered out without failing the batch'
);
select is(
  public.record_web_vitals($j$[{"name":"CLS","value":-1e-400,"route":"/"},{"name":"CLS","value":1e-400,"route":"/"},{"name":"CLS","value":-0,"route":"/"},{"name":"CLS","value":0,"route":"/"}]$j$::jsonb),
  3, 'numeric underflow edges do not raise: tiny positives and zeros are stored, tiny negatives skipped'
);
select is(
  (select count(*)::int from public.web_vitals where name = 'CLS' and value = 0),
  3, 'tiny positives and negative zero are stored as 0'
);
select is(
  (select count(*)::int from public.web_vitals where rating is null and name = 'TTFB'),
  1, 'rating may be absent'
);
select is(
  public.record_web_vitals((select jsonb_agg(jsonb_build_object('name', 'FCP', 'value', n, 'route', '/')) from generate_series(1, 25) n)),
  10, 'at most 10 samples are stored per call'
);

-- The vitals bucket is exhausted after 30 calls per window (B has made 4).
select is(
  (select sum(public.record_web_vitals('[{"name":"INP","value":50,"route":"/"}]'::jsonb))::int from generate_series(1, 26)),
  26, 'calls up to the limit store their samples'
);
select is(public.record_web_vitals('[{"name":"INP","value":50,"route":"/"}]'::jsonb), 0, 'the 31st call in a window stores nothing');
select is(public.api_rate_limit_hit('audio_urls'), true, 'the vitals bucket is independent of audio_urls');
reset role;

-- Dedupe of live fetch jobs (user A, then B). A finished job no longer blocks a new one.
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select lives_ok($$insert into public.jobs (user_id, type, payload, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_chapter', '{"chapter_id": "ch1"}', 0)$$, 'first fetch_chapter job');
select throws_ok($$insert into public.jobs (user_id, type, payload, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_chapter', '{"chapter_id": "ch1"}', 0)$$, '23505', null, 'duplicate live fetch_chapter job is rejected');
select lives_ok($$insert into public.jobs (user_id, type, payload, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_chapter', '{"chapter_id": "ch2"}', 0)$$, 'another chapter is not a duplicate');
select lives_ok($$insert into public.jobs (user_id, type, payload, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', '{"url": "https://truyenfull.live/x/"}', 0)$$, 'first fetch_novel job for a url');
select throws_ok($$insert into public.jobs (user_id, type, payload, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_novel', '{"url": "https://truyenfull.live/x/"}', 0)$$, '23505', null, 'duplicate live fetch_novel job is rejected');
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}';
select lives_ok($$insert into public.jobs (user_id, type, payload, priority) values ('22222222-2222-2222-2222-222222222222', 'fetch_chapter', '{"chapter_id": "ch1"}', 0)$$, 'the same chapter id for another owner is not a duplicate');
reset role;
update public.jobs set status = 'done'
 where user_id = '11111111-1111-1111-1111-111111111111' and type = 'fetch_chapter' and payload ->> 'chapter_id' = 'ch1';
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select lives_ok($$insert into public.jobs (user_id, type, payload, priority) values ('11111111-1111-1111-1111-111111111111', 'fetch_chapter', '{"chapter_id": "ch1"}', 0)$$, 'a new fetch_chapter job is allowed once the first is done');
reset role;

select * from finish();
rollback;
