-- Row-level security for AudioTruyen v2 (spec section 4).

-- Owner full access.
do $$
declare t text;
begin
  foreach t in array array[
    'voices', 'novels', 'chapters', 'characters', 'lexicon', 'jobs', 'progress',
    'listened_chapters', 'bookmarks', 'listen_sessions', 'settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)',
      t || '_owner', t
    );
  end loop;
end;
$$;

-- Owner read-only (written only by the worker with the service role).
do $$
declare t text;
begin
  foreach t in array array['chapter_analysis', 'chapter_audio'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_owner_read', t
    );
  end loop;
end;
$$;

-- Shared read-only status tables (single-user app, no user_id).
do $$
declare t text;
begin
  foreach t in array array['worker_status', 'llm_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end;
$$;

-- Defense in depth on top of RLS.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
revoke insert, update, delete, truncate on public.chapter_analysis, public.chapter_audio, public.worker_status, public.llm_usage from authenticated;

-- Realtime for the web app (spec 7.5).
alter publication supabase_realtime add table public.jobs, public.chapter_audio, public.worker_status;
