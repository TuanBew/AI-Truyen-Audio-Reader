-- Job queue and chapter-audio attempt functions (spec 4 and 5.1). Service role only.

create or replace function public.claim_job(p_worker_id text, p_lease_seconds integer default 300)
returns setof public.jobs
language sql
security definer
set search_path = ''
as $$
  update public.jobs j
     set status = 'running',
         worker_id = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1
   where j.id = (
     select q.id
       from public.jobs q
      where q.status = 'queued' and q.run_after <= now()
      order by q.priority, q.created_at
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

create or replace function public.requeue_expired_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.jobs j
     set status = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         error = case when j.attempts >= j.max_attempts
                      then 'lease expired after ' || j.attempts || ' attempts'
                      else j.error end,
         worker_id = null,
         lease_until = null
   where j.status = 'running' and j.lease_until < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.begin_chapter_audio(p_chapter_id uuid, p_voice_hash text)
returns table (id uuid, attempt integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r public.chapter_audio;
begin
  insert into public.chapter_audio (user_id, chapter_id, voice_hash, status, attempt)
  select c.user_id, c.id, p_voice_hash, 'queued', 1
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

  if not found then
    raise exception 'chapter % not found', p_chapter_id using errcode = 'no_data_found';
  end if;

  if r.status <> 'ready' then
    update public.chapter_audio a
       set attempt = a.attempt + 1,
           status = 'queued',
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

revoke execute on function public.claim_job(text, integer) from public, anon, authenticated;
revoke execute on function public.requeue_expired_jobs() from public, anon, authenticated;
revoke execute on function public.begin_chapter_audio(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_job(text, integer) to service_role;
grant execute on function public.requeue_expired_jobs() to service_role;
grant execute on function public.begin_chapter_audio(uuid, text) to service_role;
