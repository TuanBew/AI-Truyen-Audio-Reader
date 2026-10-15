begin;
select plan(26);

select hasnt_table('public', 'reading_progress', 'v1 reading_progress is gone');

select has_table('public', t, 'table ' || t || ' exists')
from unnest(array[
  'voices', 'novels', 'chapters', 'characters', 'lexicon', 'chapter_analysis',
  'chapter_audio', 'jobs', 'worker_status', 'llm_usage', 'progress',
  'listened_chapters', 'bookmarks', 'listen_sessions', 'settings'
]) as t;

select has_column('public', t, 'user_id', t || ' has user_id')
from unnest(array['novels', 'chapters', 'chapter_audio', 'jobs', 'settings']) as t;

select col_default_is('public', 'chapter_audio', 'attempt', 1, 'attempt defaults to 1');
select col_is_unique('public', 'chapter_audio', array['chapter_id', 'voice_hash'], 'one row per chapter and voice_hash');
select col_is_unique('public', 'chapters', array['novel_id', 'index'], 'one row per chapter number');
select col_is_pk('public', 'chapter_analysis', array['chapter_id', 'text_hash', 'strategy', 'strategy_version'], 'analysis pk includes strategy');
select col_default_is('public', 'jobs', 'status', 'queued'::text, 'jobs start queued');

select * from finish();
rollback;
