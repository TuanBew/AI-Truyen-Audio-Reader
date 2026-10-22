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
