-- Synapse 1.3. Run ONCE after 003_study_refinements.sql. Existing sets are preserved.
begin;

create function private.valid_annotations(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare stroke jsonb; point jsonb;
begin
  if jsonb_typeof(value) is distinct from 'array' or octet_length(value::text)>256000 or jsonb_array_length(value)>150 then return false; end if;
  for stroke in select jsonb_array_elements(value) loop
    if jsonb_typeof(stroke) is distinct from 'object' or coalesce(stroke->>'id','') !~ '^[a-zA-Z0-9_-]{1,80}$'
      or coalesce(stroke->>'anchor','') !~ '^[a-zA-Z0-9_-]{1,80}$' or coalesce(stroke->>'color','') !~ '^#[0-9a-fA-F]{6}$'
      or jsonb_typeof(stroke->'width') is distinct from 'number' or jsonb_typeof(stroke->'points') is distinct from 'array' then return false; end if;
    if (stroke->>'width')::numeric not between 1 and 12 or jsonb_array_length(stroke->'points') not between 2 and 500 then return false; end if;
    for point in select jsonb_array_elements(stroke->'points') loop
      if jsonb_typeof(point) is distinct from 'array' or jsonb_array_length(point)<>2 then return false; end if;
      if jsonb_typeof(point->0) is distinct from 'number' or jsonb_typeof(point->1) is distinct from 'number' then return false; end if;
      if (point->>0)::numeric not between 0 and 1 or (point->>1)::numeric not between 0 and 1 then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;
alter table public.study_assets add column annotations jsonb not null default '[]'::jsonb check(private.valid_annotations(annotations));
grant insert(annotations),update(annotations) on public.study_assets to authenticated;
grant execute on function private.valid_annotations(jsonb) to authenticated,service_role;
revoke all on function private.valid_annotations(jsonb) from public,anon;

create table private.account_deletions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  delete_after timestamptz not null default now()+interval '48 hours',
  status text not null default 'pending' check(status in ('pending','processing')),
  claimed_at timestamptz,
  claim_token uuid,
  last_error text,
  check(delete_after>=requested_at+interval '48 hours')
);
alter table private.account_deletions enable row level security;
grant all on private.account_deletions to service_role;
create index account_deletions_due on private.account_deletions(delete_after);

create function public.account_deletion_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('delete_after',delete_after,'status',status) from private.account_deletions where user_id=auth.uid();
$$;
create function public.request_account_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare entry private.account_deletions;
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid()) then raise exception 'Sign in before requesting account deletion'; end if;
  insert into private.account_deletions(user_id) values(auth.uid()) on conflict do nothing;
  select * into entry from private.account_deletions where user_id=auth.uid() for update;
  if entry.status<>'pending' or entry.delete_after<=now() then raise exception 'The deletion period has ended'; end if;
  return jsonb_build_object('delete_after',entry.delete_after,'status',entry.status);
end;
$$;
create function public.cancel_account_deletion()
returns boolean language plpgsql security definer set search_path = '' as $$
declare entry private.account_deletions;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into entry from private.account_deletions where user_id=auth.uid() for update;
  if entry.user_id is null then return false; end if;
  if entry.status<>'pending' or entry.delete_after<=now() then raise exception 'The deletion period has ended'; end if;
  delete from private.account_deletions where user_id=auth.uid(); return true;
end;
$$;
-- A new Auth session cancels deletion even if the app closes immediately afterward.
-- Refreshing an old session does not insert another session or cancel the request.
create function private.cancel_deletion_on_sign_in()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.account_deletions where user_id=new.user_id and status='pending' and delete_after>now();
  return new;
end;
$$;
create trigger synapse_cancel_account_deletion after insert on auth.sessions for each row execute function private.cancel_deletion_on_sign_in();

-- Pending accounts are signed out. Old tokens cannot continue editing study spaces.
create function private.account_available(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select uid is not null and exists(select 1 from public.profiles where id=uid) and not exists(select 1 from private.account_deletions where user_id=uid);
$$;
create function public.account_is_active(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$ select private.account_available(p_user_id); $$;
drop policy synapse_avatar_insert on storage.objects;
create policy synapse_avatar_insert on storage.objects for insert to authenticated with check(bucket_id='profile-photos'
  and private.account_available((select auth.uid())) and split_part(name,'/',1)=(select auth.uid())::text and name ~ '\.(jpg|jpeg|png|webp)$');
create or replace function private.can_access_folder(fid uuid, editing boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.account_available(auth.uid()) and exists(select 1 from public.folders f where f.id=fid and private.account_available(f.owner_id)
    and (f.owner_id=auth.uid() or exists(select 1 from public.folder_members m where m.folder_id=fid and m.user_id=auth.uid() and (not editing or m.role='editor'))));
$$;
create or replace function private.owns_folder(fid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.account_available(auth.uid()) and exists(select 1 from public.folders where id=fid and owner_id=auth.uid());
$$;

create function public.claim_due_account_deletions()
returns table(user_id uuid,claim_token uuid) language plpgsql security definer set search_path = '' as $$
begin
  return query with due as (
    select d.user_id from private.account_deletions d where d.delete_after<=now()
      and (d.status='pending' or d.claimed_at is null or d.claimed_at<now()-interval '15 minutes')
    order by d.delete_after limit 5 for update skip locked
  ) update private.account_deletions d set status='processing',claimed_at=now(),claim_token=gen_random_uuid()
    from due where d.user_id=due.user_id returning d.user_id,d.claim_token;
end;
$$;
create function private.require_deletion_claim(uid uuid,token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from private.account_deletions where user_id=uid and status='processing' and claim_token=token and claimed_at>now()-interval '15 minutes' and delete_after<=now()) then raise exception 'Account deletion claim is missing or expired'; end if;
end;
$$;
create function public.account_storage_deletions(p_user_id uuid,p_claim_token uuid)
returns table(bucket_id text,name text) language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_deletion_claim(p_user_id,p_claim_token);
  return query select o.bucket_id,o.name from storage.objects o where
    coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=p_user_id::text
    or (o.bucket_id='profile-photos' and split_part(o.name,'/',1)=p_user_id::text)
    or (o.bucket_id='study-files' and (split_part(o.name,'/',2)=p_user_id::text
      or exists(select 1 from public.document_files d where d.storage_path=o.name and (d.uploaded_by=p_user_id or exists(select 1 from public.folders f where f.id=d.folder_id and f.owner_id=p_user_id)))))
    order by o.bucket_id,o.name limit 200;
end;
$$;
-- Remove non-cascading author/source references before the Auth API removes the user.
create function private.erase_user_rows(uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.storage_deletion_queue(storage_path) select d.storage_path from public.document_files d where d.purged_at is null
    and (d.uploaded_by=uid or exists(select 1 from public.folders f where f.id=d.folder_id and f.owner_id=uid)) on conflict do nothing;
  delete from public.folder_invitations where lower(email)=(select lower(email) from auth.users where id=uid);
  delete from public.study_assets a where a.created_by=uid or exists(select 1 from public.folders f where f.id=a.folder_id and f.owner_id=uid)
    or exists(select 1 from public.document_files d where d.id=a.document_id and d.uploaded_by=uid);
  delete from public.document_files d where d.uploaded_by=uid or exists(select 1 from public.folders f where f.id=d.folder_id and f.owner_id=uid);
  delete from public.folders where owner_id=uid;
end;
$$;
create function public.prepare_account_deletion(p_user_id uuid,p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare paths text[];
begin
  perform private.require_deletion_claim(p_user_id,p_claim_token);
  if exists(select 1 from storage.objects o where coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=p_user_id::text
    or (o.bucket_id='profile-photos' and split_part(o.name,'/',1)=p_user_id::text)
    or (o.bucket_id='study-files' and (split_part(o.name,'/',2)=p_user_id::text or exists(select 1 from public.document_files d join public.folders f on f.id=d.folder_id where d.storage_path=o.name and (d.uploaded_by=p_user_id or f.owner_id=p_user_id))))) then raise exception 'Remove account storage objects first'; end if;
  select array_agg(storage_path) into paths from public.document_files d where d.uploaded_by=p_user_id or exists(select 1 from public.folders f where f.id=d.folder_id and f.owner_id=p_user_id);
  perform private.erase_user_rows(p_user_id);
  delete from private.storage_deletion_queue where storage_path=any(coalesce(paths,'{}'::text[])) or split_part(storage_path,'/',2)=p_user_id::text;
end;
$$;
create function private.erase_profile_dependencies()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform private.erase_user_rows(old.id); return old; end;
$$;
create trigger synapse_erase_profile_dependencies before delete on public.profiles for each row execute function private.erase_profile_dependencies();
create function public.retry_account_deletion(p_user_id uuid,p_claim_token uuid,p_error text)
returns void language sql security definer set search_path = '' as $$
  update private.account_deletions set claimed_at=null,last_error=left(p_error,500) where user_id=p_user_id and claim_token=p_claim_token and status='processing';
$$;

revoke all on function public.account_deletion_status(),public.request_account_deletion(),public.cancel_account_deletion() from public,anon;
grant execute on function public.account_deletion_status(),public.request_account_deletion(),public.cancel_account_deletion() to authenticated;
revoke all on function public.account_is_active(uuid),public.claim_due_account_deletions(),public.account_storage_deletions(uuid,uuid),public.prepare_account_deletion(uuid,uuid),public.retry_account_deletion(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.account_is_active(uuid),public.claim_due_account_deletions(),public.account_storage_deletions(uuid,uuid),public.prepare_account_deletion(uuid,uuid),public.retry_account_deletion(uuid,uuid,text) to service_role;
revoke all on function private.account_available(uuid),private.require_deletion_claim(uuid,uuid),private.erase_user_rows(uuid),private.cancel_deletion_on_sign_in(),private.erase_profile_dependencies() from public,anon,authenticated;
grant execute on function private.account_available(uuid) to authenticated,service_role;
notify pgrst,'reload schema';
commit;
