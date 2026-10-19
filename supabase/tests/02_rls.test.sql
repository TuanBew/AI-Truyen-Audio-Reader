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
