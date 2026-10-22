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
