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
