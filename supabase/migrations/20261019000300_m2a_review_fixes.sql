-- M2a review fixes: Vietnamese requeue error with backoff, cleanup_r2 update guard, lease clamp,
-- and a url-reset trigger that keeps text written in the same update.

-- 1. Expired leases: requeue with fail_job's backoff (2^attempts minutes); the last attempt fails
--    with an error the owner can act on.
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
                      then 'Worker ngừng phản hồi khi đang chạy job này (đã thử ' || j.attempts
                           || ' lần). Kiểm tra worker rồi bấm Thử lại.'
                      else j.error end,
         run_after = case when j.attempts >= j.max_attempts
                          then j.run_after
                          else now() + make_interval(mins => power(2, j.attempts)::integer) end,
         worker_id = null,
         lease_until = null
   where j.status = 'running' and j.lease_until < now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.requeue_expired_jobs() from public, anon, authenticated;
grant execute on function public.requeue_expired_jobs() to service_role;

-- 2. Write guard: cleanup_r2 jobs are database-owned, so the web app can neither cancel nor retry them.
create or replace function public.jobs_guard_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  reset_cols constant text[] := array['status', 'updated_at', 'attempts', 'error', 'result', 'run_after', 'worker_id', 'lease_until'];
  queued integer;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.type = 'cleanup_r2' then
      raise exception 'jobs: cleanup_r2 jobs are created by the database only' using errcode = '42501';
    end if;
    if new.status <> 'queued' or new.attempts <> 0 or new.max_attempts not between 1 and 3
       or new.priority not in (0, 10, 20)
       or new.worker_id is not null or new.lease_until is not null
       or new.result is not null or new.error is not null then
      raise exception 'jobs: a new job must be queued, unclaimed, with attempts 0, max_attempts <= 3 and priority 0, 10 or 20'
        using errcode = '42501';
    end if;
    if octet_length(new.payload::text) > 8192 then
      raise exception 'jobs: payload larger than 8 KB' using errcode = '54000';
    end if;
    new.id := gen_random_uuid();
    new.created_at := now();
    new.updated_at := now();
    new.run_after := now();
  elsif old.type = 'cleanup_r2' then
    raise exception 'jobs: cleanup_r2 jobs are managed by the database only' using errcode = '42501';
  elsif old.status = 'queued' and new.status = 'cancelled' then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'jobs: cancelling may only change status' using errcode = '42501';
    end if;
    return new;
  elsif old.status = 'failed' and new.status = 'queued' then
    if (to_jsonb(new) - reset_cols) is distinct from (to_jsonb(old) - reset_cols) then
      raise exception 'jobs: retrying may only change status' using errcode = '42501';
    end if;
    new.attempts := 0;
    new.error := null;
    new.result := null;
    new.run_after := now();
    new.worker_id := null;
    new.lease_until := null;
  else
    raise exception 'jobs: only queued -> cancelled and failed -> queued are allowed' using errcode = '42501';
  end if;

  -- Queue cap (insert and retry). The advisory lock serializes concurrent enqueues per owner.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  select count(*) into queued from public.jobs j where j.user_id = new.user_id and j.status = 'queued';
  if queued >= 500 then
    raise exception 'jobs: queue limit reached (500 queued jobs)' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke execute on function public.jobs_guard_write() from public, anon, authenticated;

-- 3. Lease clamp: a null lease means the 300 s default, and no lease is shorter than 30 s.
create or replace function public.claim_job(p_worker_id text, p_lease_seconds integer default 300, p_types text[] default null)
returns setof public.jobs
language sql
security definer
set search_path = ''
as $$
  update public.jobs j
     set status = 'running',
         worker_id = p_worker_id,
         lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30)),
         attempts = j.attempts + 1
   where j.id = (
     select q.id
       from public.jobs q
      where q.status = 'queued' and q.run_after <= now()
        and (p_types is null or q.type = any (p_types))
      order by q.priority, q.created_at
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

create or replace function public.worker_heartbeat(
  p_worker_id text, p_version text, p_device text, p_job_id uuid default null, p_lease_seconds integer default 300
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  owned boolean := true;
begin
  perform public.requeue_expired_jobs();
  if p_job_id is not null then
    update public.jobs
       set lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30))
     where id = p_job_id and worker_id = p_worker_id and status = 'running';
    owned := found;
  end if;
  insert into public.worker_status as w (worker_id, last_seen, version, device, queue_depth, current_job)
  values (
    p_worker_id, now(), p_version, p_device,
    (select count(*) from public.jobs q where q.status = 'queued' and q.run_after <= now()),
    case when owned then p_job_id end
  )
  on conflict (worker_id) do update
     set last_seen = excluded.last_seen,
         version = excluded.version,
         device = excluded.device,
         queue_depth = excluded.queue_depth,
         current_job = excluded.current_job;
  return owned;
end;
$$;

revoke execute on function public.claim_job(text, integer, text[]) from public, anon, authenticated;
revoke execute on function public.worker_heartbeat(text, text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_job(text, integer, text[]) to service_role;
grant execute on function public.worker_heartbeat(text, text, text, uuid, integer) to service_role;

-- 4. Url reset: clear the stored text only when the url changes and the same update does not
--    also write new text (a fetch that records the new url together with its text keeps it).
create or replace function public.chapters_reset_text_on_url_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.url is distinct from old.url and new.text is not distinct from old.text then
    new.text := null;
    new.text_hash := null;
    new.fetched_at := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.chapters_reset_text_on_url_change() from public, anon, authenticated;
