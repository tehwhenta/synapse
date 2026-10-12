-- Synapse 1.1 upgrade. Run ONCE after 001_synapse.sql. Existing materials are kept.
begin;
alter table private.ai_usage enable row level security;
alter table public.profiles add column avatar_path text
  check (avatar_path is null or (avatar_path like id::text || '/%' and avatar_path ~ '\.(jpg|jpeg|png|webp)$'));
grant update(avatar_path) on public.profiles to authenticated;

alter table public.study_assets add column series_id uuid not null default gen_random_uuid();
alter table public.study_assets add column set_number integer not null default 1 check (set_number > 0);
alter table public.study_assets add column content_format text not null default 'markdown' check (content_format in ('markdown','html'));
alter table public.study_assets drop constraint study_assets_document_id_kind_key;
alter table public.study_assets add constraint study_assets_series_set_key unique(series_id,set_number);
create index assets_series on public.study_assets(series_id,set_number);
grant insert(content_format),update(content_format) on public.study_assets to authenticated;

create table private.asset_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.study_assets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  series_id uuid not null,
  set_number integer not null,
  status text not null default 'processing' check (status in ('processing','completed','failed')),
  created_at timestamptz not null default now()
);
alter table private.asset_refresh_jobs enable row level security;
create index refresh_jobs_series on private.asset_refresh_jobs(series_id,created_at desc);

-- Objects must be removed through the Storage API, even after their space is deleted.
create table private.storage_deletion_queue (
  storage_path text primary key,
  created_at timestamptz not null default now()
);
alter table private.storage_deletion_queue enable row level security;
grant all on private.asset_refresh_jobs,private.storage_deletion_queue to service_role;

create function public.list_asset_sets(p_series_id uuid)
returns setof public.study_assets language sql stable security invoker set search_path = '' as $$
  select * from public.study_assets where series_id=p_series_id order by set_number;
$$;
-- Server pagination returns one latest card per series rather than crowding the library with old sets.
create function public.list_latest_assets(p_folder_id uuid,p_offset integer default 0,p_limit integer default 31)
returns setof public.study_assets language sql stable security invoker set search_path = '' as $$
  select latest.* from (
    select distinct on (series_id) * from public.study_assets where folder_id=p_folder_id order by series_id,set_number desc
  ) latest order by created_at desc,id limit least(greatest(p_limit,1),101) offset greatest(p_offset,0);
$$;

create function public.delete_folder(p_folder_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.folders where id=p_folder_id for update;
  if not private.owns_folder(p_folder_id) then raise exception 'Only the space owner can delete this space'; end if;
  insert into private.storage_deletion_queue(storage_path)
    select storage_path from public.document_files where folder_id=p_folder_id and purged_at is null on conflict do nothing;
  delete from public.folders where id=p_folder_id;
end;
$$;

create function public.claim_asset_refresh(p_asset_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.study_assets; doc public.document_files; source text; source_format text := 'markdown'; next_set integer; job uuid; used integer; previous jsonb;
begin
  select * into a from public.study_assets where id=p_asset_id;
  if a.id is null or not (exists(select 1 from public.folders where id=a.folder_id and owner_id=p_user_id)
    or exists(select 1 from public.folder_members where folder_id=a.folder_id and user_id=p_user_id and role='editor')) then raise exception 'Editor access required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.series_id::text,0));
  if exists(select 1 from private.asset_refresh_jobs where series_id=a.series_id and status='processing' and created_at>now()-interval '15 minutes') then raise exception 'This set is already refreshing'; end if;
  select * into doc from public.document_files where id=a.document_id;
  source:=doc.extracted_text;
  if nullif(trim(source),'') is null then
    if a.kind='note' then source:=a.content; source_format:=a.content_format;
    else select content,content_format into source,source_format from public.study_assets where document_id=a.document_id and kind='note' order by set_number limit 1; end if;
  end if;
  if nullif(trim(source),'') is null then raise exception 'Source text unavailable. Upload the material again'; end if;
  insert into private.ai_usage(user_id,usage_date,requests) values(p_user_id,(now() at time zone 'UTC')::date,1)
    on conflict(user_id,usage_date) do update set requests=private.ai_usage.requests+1 returning requests into used;
  if used>20 then raise exception 'Daily limit reached (20 AI generations per user)'; end if;
  select coalesce(max(set_number),0)+1 into next_set from public.study_assets where series_id=a.series_id;
  insert into private.asset_refresh_jobs(asset_id,user_id,series_id,set_number) values(a.id,p_user_id,a.series_id,next_set) returning id into job;
  select coalesce(jsonb_agg(left(coalesce(item->>'front',item->>'question'),1500)),'[]'::jsonb) into previous
    from (select data from public.study_assets where series_id=a.series_id order by set_number desc limit 5) sets
    cross join lateral jsonb_array_elements(sets.data) item;
  return jsonb_build_object('job_id',job,'title',a.title,'kind',a.kind,'set_number',next_set,'source_text',left(source,100000),'source_format',source_format,'previous',previous,
    'source_document',case when doc.id is null then null else jsonb_build_object('storage_path',doc.storage_path,'mime_type',doc.mime_type,'size_bytes',doc.size_bytes,'purged_at',doc.purged_at,'expires_at',doc.expires_at) end);
end;
$$;

create function public.complete_asset_refresh(p_job_id uuid,p_user_id uuid,p_output jsonb)
returns public.study_assets language plpgsql security definer set search_path = '' as $$
declare job private.asset_refresh_jobs; a public.study_assets; result public.study_assets;
begin
  select * into job from private.asset_refresh_jobs where id=p_job_id and user_id=p_user_id and status='processing' and created_at>now()-interval '15 minutes' for update;
  if job.id is null then raise exception 'Refresh claim is missing or expired'; end if;
  select * into a from public.study_assets where id=job.asset_id;
  if not (exists(select 1 from public.folders where id=a.folder_id and owner_id=p_user_id)
    or exists(select 1 from public.folder_members where folder_id=a.folder_id and user_id=p_user_id and role='editor')) then raise exception 'Editor access required'; end if;
  if (a.kind='note' and nullif(trim(p_output->>'notes'),'') is null)
    or (a.kind='deck' and (jsonb_typeof(p_output->'flashcards') is distinct from 'array' or jsonb_array_length(p_output->'flashcards')<3))
    or (a.kind='quiz' and (jsonb_typeof(p_output->'quiz') is distinct from 'array' or jsonb_array_length(p_output->'quiz')<3)) then raise exception 'Generated set is incomplete'; end if;
  insert into public.study_assets(folder_id,document_id,kind,title,content,data,created_by,series_id,set_number)
    values(a.folder_id,a.document_id,a.kind,a.title,case when a.kind='note' then p_output->>'notes' else '' end,
      case when a.kind='deck' then p_output->'flashcards' when a.kind='quiz' then p_output->'quiz' else '[]'::jsonb end,p_user_id,a.series_id,job.set_number) returning * into result;
  update private.asset_refresh_jobs set status='completed' where id=job.id;
  insert into public.activity_events(folder_id,user_id,message) values(a.folder_id,p_user_id,'created set ' || job.set_number || ' of ' || a.title);
  return result;
end;
$$;
create function public.fail_asset_refresh(p_job_id uuid,p_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  update private.asset_refresh_jobs set status='failed' where id=p_job_id and user_id=p_user_id and status='processing';
$$;

-- Cleanup-only access to a private schema; never expose these queues to the browser.
create function public.pending_storage_deletions()
returns table(storage_path text) language sql security definer set search_path = '' as $$
  select storage_path from private.storage_deletion_queue order by created_at limit 200;
$$;
create function public.finish_storage_deletions(p_paths text[])
returns void language sql security definer set search_path = '' as $$
  delete from private.storage_deletion_queue where storage_path=any(p_paths);
$$;
revoke all on function public.list_asset_sets(uuid),public.list_latest_assets(uuid,integer,integer),public.delete_folder(uuid) from public,anon;
grant execute on function public.list_asset_sets(uuid),public.list_latest_assets(uuid,integer,integer),public.delete_folder(uuid) to authenticated;
revoke all on function public.claim_asset_refresh(uuid,uuid),public.complete_asset_refresh(uuid,uuid,jsonb),public.fail_asset_refresh(uuid,uuid),public.pending_storage_deletions(),public.finish_storage_deletions(text[]) from public,anon,authenticated;
grant execute on function public.claim_asset_refresh(uuid,uuid),public.complete_asset_refresh(uuid,uuid,jsonb),public.fail_asset_refresh(uuid,uuid),public.pending_storage_deletions(),public.finish_storage_deletions(text[]) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-photos','profile-photos',false,2097152,array['image/jpeg','image/png','image/webp']);
create policy synapse_avatar_read on storage.objects for select to authenticated using(bucket_id='profile-photos'
  and exists(select 1 from public.profiles p where p.avatar_path=storage.objects.name and private.shares_folder(p.id)));
create policy synapse_avatar_insert on storage.objects for insert to authenticated with check(bucket_id='profile-photos'
  and split_part(name,'/',1)=(select auth.uid())::text and name ~ '\.(jpg|jpeg|png|webp)$');
create policy synapse_avatar_delete on storage.objects for delete to authenticated using(bucket_id='profile-photos' and split_part(name,'/',1)=(select auth.uid())::text);
notify pgrst,'reload schema';
commit;
