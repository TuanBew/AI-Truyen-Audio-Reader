begin;
select plan(6);

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@audiotruyen.test', '{}', '{}', now(), now());
insert into public.novels (id, user_id, source, source_novel_id, url, title)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'truyenfull', '1', 'u', 'Truyện A');
insert into public.chapters (id, user_id, novel_id, index, title, url, text, text_hash, fetched_at)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'Chương 1', 'u1', 'nội dung', 'h1', now());

-- A TOC re-read that only renames the chapter keeps the fetched text.
update public.chapters set title = 'Chương 1 (sửa)' where id = 'cccccccc-0000-0000-0000-000000000001';
select is((select text from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'), 'nội dung', 'title change keeps text');
select is((select text_hash from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'), 'h1', 'title change keeps text_hash');

-- Same url written again (upsert of an unchanged TOC entry) keeps the text.
update public.chapters set url = 'u1' where id = 'cccccccc-0000-0000-0000-000000000001';
select is((select text from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'), 'nội dung', 'unchanged url keeps text');

-- A different url means the index now points at another chapter: the stored text is dropped.
update public.chapters set url = 'u2' where id = 'cccccccc-0000-0000-0000-000000000001';
select is((select text from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'), null, 'url change clears text');
select is((select text_hash from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'), null, 'url change clears text_hash');
select is((select fetched_at from public.chapters where id = 'cccccccc-0000-0000-0000-000000000001'), null, 'url change clears fetched_at');

select * from finish();
rollback;
