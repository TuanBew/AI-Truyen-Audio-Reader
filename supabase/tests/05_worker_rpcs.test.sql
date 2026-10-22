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
