-- AudioTruyen v2 schema. The v2 project reuses the v1 Supabase project, so drop the v1 objects first.
drop table if exists public.reading_progress cascade;
drop table if exists public.novels cascade;
drop function if exists public.update_updated_at() cascade;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.voices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('preset', 'clone')),
  preset_name text,
  refs jsonb not null default '{}'::jsonb,
  gender text not null default 'unknown' check (gender in ('male', 'female', 'unknown')),
  is_default_narrator boolean not null default false,
  is_default_male boolean not null default false,
  is_default_female boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voices_preset_has_name check (kind <> 'preset' or preset_name is not null),
  unique (user_id, name)
);
create unique index voices_one_default_narrator on public.voices (user_id) where is_default_narrator;
create unique index voices_one_default_male on public.voices (user_id) where is_default_male;
create unique index voices_one_default_female on public.voices (user_id) where is_default_female;

create table public.novels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  source_novel_id text not null,
  url text not null,
  slug text,
  title text not null,
  author text,
  cover_url text,
  description text,
  status text check (status in ('ongoing', 'completed')),
  chapter_count integer not null default 0,
  followed boolean not null default false,
  auto_synthesize_new boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, source_novel_id)
);

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid not null references public.novels (id) on delete cascade,
  index integer not null check (index >= 1),
  title text not null,
  url text not null,
  text text,
  text_hash text,
  fetched_at timestamptz,
  is_new boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (novel_id, index)
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid not null references public.novels (id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  gender text not null default 'unknown' check (gender in ('male', 'female', 'unknown')),
  voice_id uuid references public.voices (id) on delete set null,
  color text,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (novel_id, name)
);

create table public.lexicon (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid references public.novels (id) on delete cascade,
  pattern text not null,
  replacement text not null,
  is_regex boolean not null default false,
  enabled boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lexicon_scope_order on public.lexicon (user_id, novel_id, position);

create table public.chapter_analysis (
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  text_hash text not null,
  strategy text not null,
  strategy_version integer not null,
  segments jsonb not null,
  created_at timestamptz not null default now(),
  primary key (chapter_id, text_hash, strategy, strategy_version)
);

create table public.chapter_audio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  voice_hash text not null,
  status text not null default 'queued' check (status in ('queued', 'partial', 'ready', 'failed')),
  provider text not null default 'vieneu',
  attempt integer not null default 1 check (attempt >= 1),
  init_key text,
  chunks jsonb not null default '[]'::jsonb,
  full_key text,
  duration_ms integer,
  segments jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chapter_id, voice_hash)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('search', 'fetch_novel', 'fetch_chapter', 'synthesize', 'check_updates')),
  payload jsonb not null default '{}'::jsonb,
  priority integer not null default 10,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  worker_id text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_queue on public.jobs (priority, created_at) where status = 'queued';
create index jobs_running_lease on public.jobs (lease_until) where status = 'running';
create index jobs_owner_recent on public.jobs (user_id, created_at desc);

create table public.worker_status (
  worker_id text primary key,
  last_seen timestamptz not null default now(),
  version text,
  device text,
  queue_depth integer not null default 0,
  current_job uuid references public.jobs (id) on delete set null
);

create table public.llm_usage (
  model text not null,
  day_pt date not null,
  requests integer not null default 0,
  tokens integer not null default 0,
  locked_until timestamptz,
  primary key (model, day_pt)
);

create table public.progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  novel_id uuid not null references public.novels (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  segment_index integer not null default 0,
  position_ms integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, novel_id)
);

create table public.listened_chapters (
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  finished_at timestamptz not null default now(),
  primary key (user_id, chapter_id)
);

create table public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  segment_index integer not null,
  quote text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookmarks_owner on public.bookmarks (user_id, created_at desc);

create table public.listen_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  started_at timestamptz not null default now(),
  seconds integer not null default 0 check (seconds >= 0)
);
create index listen_sessions_owner_time on public.listen_sessions (user_id, started_at);

create table public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array[
    'voices', 'novels', 'chapters', 'characters', 'lexicon', 'chapter_audio',
    'jobs', 'progress', 'bookmarks', 'settings'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end;
$$;
