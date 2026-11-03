-- M3 web core: read-path indexes, per-user API rate limiter, web vitals samples.

-- 1. Indexes for the library, resume and job-status queries.
create index progress_owner_recent on public.progress (user_id, updated_at desc);
create index novels_owner_recent on public.novels (user_id, created_at desc);
create index jobs_chapter_latest on public.jobs (user_id, type, (payload ->> 'chapter_id'), created_at desc)
  where type in ('fetch_chapter', 'synthesize');

-- Foreign keys that had no covering index (cascade deletes and joins scan these).
create index progress_novel_id_idx on public.progress (novel_id);
create index progress_chapter_id_idx on public.progress (chapter_id);
create index listened_chapters_chapter_id_idx on public.listened_chapters (chapter_id);
create index bookmarks_chapter_id_idx on public.bookmarks (chapter_id);
create index listen_sessions_chapter_id_idx on public.listen_sessions (chapter_id);
create index characters_voice_id_idx on public.characters (voice_id);
create index worker_status_current_job_idx on public.worker_status (current_job);

-- 2. Per-user fixed-window rate limiter, counted in Postgres. Rows are written only by
-- api_rate_limit_hit (security definer); the table is closed to the API roles.
create table public.api_rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (user_id, bucket, window_start)
);
alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from anon, authenticated;

-- Buckets and windows are fixed here so a client calling the RPC directly cannot choose a window
-- that resets a route's counter. Returns true while the caller is within the limit.
create function public.api_rate_limit_hit(p_bucket text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  lim integer;
  win integer;
  ws timestamptz;
  n integer;
begin
  if uid is null then
    raise exception 'api_rate_limit_hit requires an authenticated user' using errcode = '42501';
  end if;
  case p_bucket
    when 'audio_urls' then lim := 60; win := 60;
    when 'vitals' then lim := 30; win := 60;
    else raise exception 'unknown rate-limit bucket %', p_bucket using errcode = '22023';
  end case;
  ws := to_timestamp(floor(extract(epoch from now()) / win) * win);
  delete from public.api_rate_limits r where r.user_id = uid and r.bucket = p_bucket and r.window_start < ws;
  insert into public.api_rate_limits as r (user_id, bucket, window_start, hits)
  values (uid, p_bucket, ws, 1)
  on conflict (user_id, bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into n;
  return n <= lim;
end;
$$;
revoke execute on function public.api_rate_limit_hit(text) from public, anon, authenticated, service_role;
grant execute on function public.api_rate_limit_hit(text) to authenticated;

-- 3. Web vitals samples (spec 7.3.2). Rows arrive only through record_web_vitals.
create table public.web_vitals (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (name in ('CLS', 'FCP', 'INP', 'LCP', 'TTFB')),
  value double precision not null check (value >= 0 and value < 1e7),
  rating text check (rating in ('good', 'needs-improvement', 'poor')),
  route text not null check (char_length(route) between 1 and 200),
  created_at timestamptz not null default now()
);
create index web_vitals_owner_time on public.web_vitals (user_id, created_at desc);
alter table public.web_vitals enable row level security;
create policy web_vitals_owner_read on public.web_vitals for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.web_vitals from anon, authenticated;
grant select on public.web_vitals to authenticated;

-- Stores up to 10 samples (the first 10 array elements) for the caller and returns how many were
-- stored. One rate-limit hit per call; returns 0 when the 'vitals' bucket is exhausted. Elements
-- that would fail the column checks are skipped instead of raising, so one bad sample does not
-- drop the batch. Non-array input stores nothing.
create function public.record_web_vitals(p_samples jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  stored integer;
begin
  if uid is null then
    raise exception 'record_web_vitals requires an authenticated user' using errcode = '42501';
  end if;
  if not public.api_rate_limit_hit('vitals') then
    return 0;
  end if;
  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    return 0;
  end if;
  with picked as (
    select t.e, t.n
      from jsonb_array_elements(p_samples) with ordinality as t(e, n)
     where t.n <= 10
  ), parsed as (
    select p.n,
           case when jsonb_typeof(p.e) = 'object' and jsonb_typeof(p.e -> 'name') = 'string'
                then p.e ->> 'name' end as name,
           -- Nested CASEs guarantee evaluation order: only JSON numbers are cast to numeric, and
           -- only numerics inside the column range reach double precision.
           case when jsonb_typeof(p.e) = 'object' then
             case when jsonb_typeof(p.e -> 'value') = 'number' then
               case when (p.e ->> 'value')::numeric >= 0 and (p.e ->> 'value')::numeric < 1e7
                    then (p.e ->> 'value')::numeric::double precision end
             end
           end as value,
           case when jsonb_typeof(p.e) = 'object' and jsonb_typeof(p.e -> 'rating') = 'string'
                then p.e ->> 'rating' end as rating,
           (jsonb_typeof(p.e) = 'object'
             and (p.e -> 'rating' is null or jsonb_typeof(p.e -> 'rating') = 'null')) as rating_absent,
           case when jsonb_typeof(p.e) = 'object' and jsonb_typeof(p.e -> 'route') = 'string'
                then p.e ->> 'route' end as route
      from picked p
  ), ins as (
    insert into public.web_vitals (user_id, name, value, rating, route)
    select uid, s.name, s.value, s.rating, s.route
      from parsed s
     where s.name in ('CLS', 'FCP', 'INP', 'LCP', 'TTFB')
       and s.value is not null
       and (s.rating_absent or s.rating in ('good', 'needs-improvement', 'poor'))
       and char_length(s.route) between 1 and 200
     order by s.n
    returning 1
  )
  select count(*)::integer into stored from ins;
  return stored;
end;
$$;
revoke execute on function public.record_web_vitals(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_web_vitals(jsonb) to authenticated;
