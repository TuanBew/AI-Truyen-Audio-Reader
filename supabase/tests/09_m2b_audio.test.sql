begin;
select plan(40);

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
select throws_ok($$select public.r2_reserve_upload('audio/n/c/h/1/seg-0000.webm', 601, 1000000000000, 1000000000)$$, '22023', null, 'a live key cannot be re-reserved with different bytes');
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
