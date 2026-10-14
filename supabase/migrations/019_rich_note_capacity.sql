-- Synapse 1.9.1. Existing content, permissions and AI output limits are preserved.
-- HTML adds formatting/table markup; allow space for it without truncating notes.
begin;
alter table public.study_assets drop constraint if exists study_assets_content_check;
alter table public.study_assets add constraint study_assets_content_check
check (char_length(content) <= case when kind='note' and content_format='html' then 240000 else 60000 end);
commit;
