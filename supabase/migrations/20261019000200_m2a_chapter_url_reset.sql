-- M2a: chapter indexes are positional, so a chapter inserted mid-list on the source remaps rows on
-- the next TOC re-read. When a row's url changes it points at a different chapter: drop the stored
-- text so the old chapter's text is never served under the new one.

create function public.chapters_reset_text_on_url_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.url is distinct from old.url then
    new.text := null;
    new.text_hash := null;
    new.fetched_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.chapters_reset_text_on_url_change() from public, anon, authenticated;

create trigger chapters_reset_text_on_url_change before update of url on public.chapters
  for each row execute function public.chapters_reset_text_on_url_change();
