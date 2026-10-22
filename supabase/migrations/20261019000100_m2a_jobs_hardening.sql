-- M2a: job write constraints, queue cap, dedupe, worker job RPCs, default privileges.
-- Spec 5.1 (job loop) and 7.3.1 (cost and abuse protection).

-- 1. Default privileges: functions created later are not executable by PUBLIC, anon or
--    authenticated unless a migration grants it; authenticated never gets truncate/trigger/references.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
revoke truncate, trigger, references on all tables in schema public from authenticated;
alter default privileges for role postgres in schema public revoke truncate, trigger, references on tables from authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- 2. Job shape constraints (all roles).
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (
  type in ('search', 'fetch_novel', 'fetch_chapter', 'synthesize', 'check_updates', 'cleanup_r2')
);
alter table public.jobs add constraint jobs_priority_check check (priority in (0, 10, 20));
alter table public.jobs add constraint jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 10);
alter table public.jobs add constraint jobs_synthesize_payload check (
  type <> 'synthesize'
  or (coalesce(payload ->> 'chapter_id', '') <> '' and coalesce(payload ->> 'voice_hash', '') <> '')
);

-- 3. One live synthesize job per (owner, chapter, voice_hash); fast queue-cap count.
create unique index jobs_synthesize_dedupe on public.jobs (user_id, (payload ->> 'chapter_id'), (payload ->> 'voice_hash'))
  where type = 'synthesize' and status in ('queued', 'running');
create index jobs_owner_queued on public.jobs (user_id) where status = 'queued';

-- 4. Write guard for the web app (role authenticated). The worker (service_role) and database-owned
--    functions (current_user postgres) are trusted and skip it, so the cap never wedges a requeue.
create function public.jobs_guard_write()
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

create trigger jobs_guard_write before insert or update on public.jobs
  for each row execute function public.jobs_guard_write();

-- 5. Owner policies split by command; no DELETE for the web app.
drop policy jobs_owner on public.jobs;
create policy jobs_owner_select on public.jobs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy jobs_owner_insert on public.jobs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy jobs_owner_update on public.jobs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke delete on public.jobs from authenticated;

-- 6. claim_job gains a type filter, so a worker only claims job types it can run.
drop function public.claim_job(text, integer);
create function public.claim_job(p_worker_id text, p_lease_seconds integer default 300, p_types text[] default null)
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
        and (p_types is null or q.type = any (p_types))
      order by q.priority, q.created_at
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

-- 7. Worker RPCs. Every job write is fenced by (id, worker_id, status = 'running').

-- Heartbeat: requeue expired leases, extend the current job's lease, upsert worker_status.
-- Returns false when the worker no longer owns p_job_id (lease expired and requeued).
create function public.worker_heartbeat(
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
       set lease_until = now() + make_interval(secs => p_lease_seconds)
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

-- Finish a running job as done or cancelled.
create function public.finish_job(
  p_job_id uuid, p_worker_id text, p_status text, p_result jsonb default null, p_error text default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_status not in ('done', 'cancelled') then
    raise exception 'finish_job: status must be done or cancelled' using errcode = '22023';
  end if;
  update public.jobs
     set status = p_status, result = p_result, error = left(p_error, 2000), lease_until = null
   where id = p_job_id and worker_id = p_worker_id and status = 'running';
  return found;
end;
$$;

-- Fail a running job: retryable failures with attempts left go back to the queue with
-- run_after = now() + 2^attempts minutes; otherwise failed. Returns the new status, or null
-- when this worker no longer owns the job.
create function public.fail_job(p_job_id uuid, p_worker_id text, p_error text, p_retryable boolean default true)
returns text
language plpgsql
set search_path = ''
as $$
declare
  new_status text;
begin
  update public.jobs j
     set status = case when p_retryable and j.attempts < j.max_attempts then 'queued' else 'failed' end,
         run_after = case when p_retryable and j.attempts < j.max_attempts
                          then now() + make_interval(mins => power(2, j.attempts)::integer)
                          else j.run_after end,
         error = left(p_error, 2000),
         worker_id = null,
         lease_until = null
   where j.id = p_job_id and j.worker_id = p_worker_id and j.status = 'running'
  returning j.status into new_status;
  return new_status;
end;
$$;

revoke execute on function public.claim_job(text, integer, text[]) from public, anon, authenticated;
revoke execute on function public.worker_heartbeat(text, text, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.finish_job(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.fail_job(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_job(text, integer, text[]) to service_role;
grant execute on function public.worker_heartbeat(text, text, text, uuid, integer) to service_role;
grant execute on function public.finish_job(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.fail_job(uuid, text, text, boolean) to service_role;
