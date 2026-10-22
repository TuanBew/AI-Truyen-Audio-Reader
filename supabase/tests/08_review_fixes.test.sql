begin;
select plan(15);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now());

-- Seed as postgres (trusted, guard skipped).
insert into public.jobs (id, user_id, type, status, attempts, max_attempts, worker_id, lease_until, error, run_after) values
  ('80000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 'running', 1, 3, 'w0', now() - interval '1 minute', 'cũ', now() - interval '1 hour'),
  ('80000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 'running', 2, 3, 'w0', now() - interval '1 minute', null, now() - interval '1 hour'),
  ('80000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'fetch_novel', 'running', 3, 3, 'w0', now() - interval '1 minute', null, now() - interval '1 hour');
insert into public.jobs (id, user_id, type, status, payload) values
  ('80000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'fetch_chapter', 'queued', '{}'),
  ('80000000-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', 'search', 'queued', '{}'),
  ('80000000-0000-0000-0000-000000000021', '11111111-1111-1111-1111-111111111111', 'cleanup_r2', 'queued', '{"prefix": "audio/"}'),
  ('80000000-0000-0000-0000-000000000022', '11111111-1111-1111-1111-111111111111', 'cleanup_r2', 'failed', '{"prefix": "audio/"}'),
  ('80000000-0000-0000-0000-000000000023', '11111111-1111-1111-1111-111111111111', 'check_updates', 'queued', '{}');
insert into public.novels (id, user_id, source, source_novel_id, url, title)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'truyenfull', '1', 'u', 'Truyện A');
insert into public.chapters (id, user_id, novel_id, index, title, url, text, text_hash, fetched_at)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'Chương 1', 'u1', 'nội dung', 'h1', now());

-- 1. requeue_expired_jobs: requeue with fail_job's backoff; the last attempt fails with a Vietnamese error.
select is(public.requeue_expired_jobs(), 3, 'three expired leases handled');
select is(
  (select row(status, worker_id, lease_until, error, run_after = now() + interval '2 minutes')::text
     from public.jobs where id = '80000000-0000-0000-0000-000000000001'),
  '(queued,,,cũ,t)', 'requeue after attempt 1: backoff 2 minutes, worker released, error kept'
);
select is(
  (select run_after = now() + interval '4 minutes' from public.jobs where id = '80000000-0000-0000-0000-000000000002'),
  true, 'requeue after attempt 2: backoff 4 minutes'
);
select is(
  (select row(status, error)::text from public.jobs where id = '80000000-0000-0000-0000-000000000003'),
  row('failed', 'Worker ngừng phản hồi khi đang chạy job này (đã thử 3 lần). Kiểm tra worker rồi bấm Thử lại.')::text,
  'no attempts left: failed with a Vietnamese error'
);

-- 3. Lease clamp: null means the default 300 s, anything below 30 s becomes 30 s.
set local role service_role;
select is(
  (select lease_until = now() + interval '300 seconds' from public.claim_job('w1', null, array['fetch_chapter'])),
  true, 'claim_job with a null lease uses 300 s'
);
select is(
  (select lease_until = now() + interval '30 seconds' from public.claim_job('w1', 0, array['search'])),
  true, 'claim_job with lease 0 is clamped to 30 s'
);
select is(public.worker_heartbeat('w1', 'v', 'cpu', '80000000-0000-0000-0000-000000000011', 0), true, 'heartbeat with lease 0');
select is(
  (select lease_until = now() + interval '30 seconds' from public.jobs where id = '80000000-0000-0000-0000-000000000011'),
  true, 'worker_heartbeat with lease 0 is clamped to 30 s'
);
select is(public.worker_heartbeat('w1', 'v', 'cpu', '80000000-0000-0000-0000-000000000012', null), true, 'heartbeat with a null lease');
select is(
  (select lease_until = now() + interval '300 seconds' from public.jobs where id = '80000000-0000-0000-0000-000000000012'),
  true, 'worker_heartbeat with a null lease uses 300 s'
);
reset role;

-- 4. chapters_reset_text_on_url_change: a new url written together with new text keeps the new text.
update public.chapters set url = 'u2', text = 'nội dung mới', text_hash = 'h2'
 where id = 'cccccccc-0000-0000-0000-000000000001';
select is(
  (select row(text, text_hash)::text from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'),
  row('nội dung mới', 'h2')::text, 'url and text changed together: new text kept'
);
update public.chapters set url = 'u3' where id = 'cccccccc-0000-0000-0000-000000000001';
select is(
  (select row(text, text_hash, fetched_at)::text from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'),
  '(,,)', 'url only: text cleared'
);

-- 2. jobs_guard_write: the web app cannot cancel or retry cleanup_r2 jobs.
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select throws_ok(
  $$update public.jobs set status = 'cancelled' where id = '80000000-0000-0000-0000-000000000021'$$,
  '42501', null, 'owner cannot cancel a cleanup_r2 job'
);
select throws_ok(
  $$update public.jobs set status = 'queued' where id = '80000000-0000-0000-0000-000000000022'$$,
  '42501', null, 'owner cannot retry a failed cleanup_r2 job'
);
select lives_ok(
  $$update public.jobs set status = 'cancelled' where id = '80000000-0000-0000-0000-000000000023'$$,
  'owner still cancels other queued jobs'
);

select * from finish();
rollback;
