-- Allow-lists for table RLS and function privileges (spec 7.3.1). Extension-owned objects
-- (pgTAP itself) are excluded.
begin;
select plan(7);

select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity$$,
  'every public table has row level security enabled'
);

select is_empty(
  $$select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute'))$$,
  'no public function is executable by anon or authenticated'
);

select set_eq(
  $$select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('service_role', p.oid, 'execute')
       and p.prorettype <> 'trigger'::regtype$$,
  array[
    'claim_job(text,integer,text[])',
    'requeue_expired_jobs()',
    'begin_chapter_audio(uuid,text)',
    'worker_heartbeat(text,text,text,uuid,integer)',
    'finish_job(uuid,text,text,jsonb,text)',
    'fail_job(uuid,text,text,boolean)'
  ],
  'service_role executes exactly the worker allow-list'
);

select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))$$,
  'anon has no table privileges'
);

select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and (has_table_privilege('authenticated', c.oid, 'truncate')
            or has_table_privilege('authenticated', c.oid, 'trigger')
            or has_table_privilege('authenticated', c.oid, 'references'))$$,
  'authenticated has no truncate, trigger or references'
);

select ok(not has_table_privilege('authenticated', 'public.jobs', 'delete'), 'authenticated cannot delete jobs');

select ok(
  not exists (
    select 1 from pg_default_acl a
     where a.defaclrole = 'postgres'::regrole and a.defaclobjtype = 'f'
       and a.defaclnamespace in (0, 'public'::regnamespace)
       and exists (select 1 from aclexplode(a.defaclacl) x
                    where x.privilege_type = 'EXECUTE' and x.grantee in (0, 'anon'::regrole, 'authenticated'::regrole))
  ),
  'future functions by postgres are not executable by PUBLIC, anon or authenticated'
);

select * from finish();
rollback;
