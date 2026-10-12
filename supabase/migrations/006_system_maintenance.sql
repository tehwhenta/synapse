-- Synapse 1.4. Run ONCE after 004 (005 configures the existing cron job).
-- No account is automatically selected for deletion by this migration.
begin;

alter table public.profiles add column last_active_at timestamptz not null default now();
update public.profiles p set last_active_at=greatest(p.created_at,coalesce(u.last_sign_in_at,p.created_at)) from auth.users u where u.id=p.id;
create index profiles_last_active on public.profiles(last_active_at,id);
create index invitations_expiry on public.folder_invitations(expires_at);
create index ai_usage_date on private.ai_usage(usage_date);
create index assets_author_folder on public.study_assets(created_by,folder_id);
create index documents_uploader_folder on public.document_files(uploaded_by,folder_id);

create table private.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);
alter table private.app_admins enable row level security;
grant all on private.app_admins to service_role;
-- Bind the existing, confirmed account's UUID once. Email/user metadata is never
-- used to authorize an admin request, and changing an email cannot grant a role.
insert into private.app_admins(user_id)
  select u.id from auth.users u join public.profiles p on p.id=u.id
  where lower(u.email)='rcgsynapse@gmail.com' and u.email_confirmed_at is not null;

create function public.is_app_admin()
returns boolean language sql stable security definer set search_path='' as $$
  select private.account_available(auth.uid()) and exists(select 1 from private.app_admins where user_id=auth.uid());
$$;
create function public.is_app_admin_user(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.account_available(p_user_id) and exists(select 1 from private.app_admins where user_id=p_user_id);
$$;
create function private.require_app_admin()
returns void language plpgsql stable security definer set search_path='' as $$
begin if not public.is_app_admin() then raise exception 'Admin access required' using errcode='42501'; end if; end;
$$;
-- An inactive owner/author must not take an actively used shared space with them.
-- Self-requested deletion still follows the user's explicit full-deletion scope.
create function private.has_active_shared_content(uid uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.folders f where
    (f.owner_id=uid or exists(select 1 from public.study_assets a where a.folder_id=f.id and a.created_by=uid)
      or exists(select 1 from public.document_files d where d.folder_id=f.id and d.uploaded_by=uid))
    and (exists(select 1 from public.profiles p join auth.users u on u.id=p.id where p.id=f.owner_id and p.id<>uid
        and greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at))>now()-interval '30 days')
      or exists(select 1 from public.folder_members m join public.profiles p on p.id=m.user_id join auth.users u on u.id=p.id
        where m.folder_id=f.id and m.user_id<>uid and greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at))>now()-interval '30 days')));
$$;

alter table private.account_deletions add column reason text not null default 'self' check(reason in ('self','inactive'));
alter table private.account_deletions add column inactive_days integer check(inactive_days in (90,180,365));
alter table private.account_deletions add constraint inactive_recovery_window check(reason<>'inactive' or (inactive_days is not null and delete_after>=requested_at+interval '7 days'));
create table private.maintenance_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check(action in ('schedule_inactive','cancel_inactive','cleanup')),
  account_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table private.maintenance_events enable row level security;
grant all on private.maintenance_events to service_role;
create index maintenance_events_time on private.maintenance_events(created_at);
create table private.maintenance_state (
  id boolean primary key default true check(id),
  run_token uuid,
  running_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  result jsonb
);
alter table private.maintenance_state enable row level security;
grant all on private.maintenance_state to service_role;
insert into private.maintenance_state(id) values(true);

-- This tracks actual app use, not online status. Server time is authoritative;
-- multiple tabs share the five-minute write throttle in the database.
create function public.mark_app_activity()
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid=auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  perform 1 from public.profiles where id=uid for update;
  delete from private.account_deletions where user_id=uid and reason='inactive' and status='pending' and delete_after>now();
  if not private.account_available(uid) then return; end if;
  update public.profiles set last_active_at=now() where id=uid and last_active_at<now()-interval '5 minutes';
end;
$$;
create or replace function private.cancel_deletion_on_sign_in()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Same lock order as scheduling/activity: profile first, deletion request next.
  update public.profiles set last_active_at=now() where id=new.user_id;
  delete from private.account_deletions where user_id=new.user_id and status='pending' and delete_after>now();
  return new;
end;
$$;
create or replace function public.account_deletion_status()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('delete_after',delete_after,'status',status,'reason',reason) from private.account_deletions where user_id=auth.uid();
$$;
create or replace function private.account_available(uid uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select uid is not null and exists(select 1 from public.profiles where id=uid) and not exists(
    select 1 from private.account_deletions where user_id=uid and (reason='self' or status='processing' or delete_after<=now()));
$$;

create function public.admin_system_summary()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_app_admin();
  select jsonb_build_object(
    'users',(select count(*) from public.profiles),
    'active_week',(select count(*) from public.profiles where last_active_at>now()-interval '7 days'),
    'inactive_90',(select count(*) from public.profiles p join auth.users u on u.id=p.id where greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at))<now()-interval '90 days' and not exists(select 1 from private.app_admins where user_id=p.id) and not private.has_active_shared_content(p.id)),
    'spaces',(select count(*) from public.folders),
    'materials',(select count(*) from public.study_assets),
    'database_bytes',pg_database_size(current_database()),
    'storage_bytes',(select coalesce(sum(case when coalesce(metadata->>'size','') ~ '^[0-9]{1,18}$' then (metadata->>'size')::bigint else 0 end),0) from storage.objects),
    'expired_files',(select count(*) from public.document_files where expires_at<=now() and purged_at is null),
    'queued_files',(select count(*) from private.storage_deletion_queue),
    'pending_accounts',(select count(*) from private.account_deletions),
    'cleanup',(select jsonb_build_object('last_started_at',s.last_started_at,'last_finished_at',s.last_finished_at,'running_until',s.running_until,'result',s.result) from private.maintenance_state s),
    'checked_at',now()
  ) into result;
  return result;
end;
$$;
create function public.admin_inactive_accounts(p_days integer default 90,p_offset integer default 0,p_limit integer default 26)
returns table(user_id uuid,display_name text,email text,last_active_at timestamptz,owned_spaces bigint,materials bigint,delete_after timestamptz,deletion_reason text)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_app_admin();
  if p_days not in (90,180,365) or p_days is null then raise exception 'Choose 90, 180, or 365 days'; end if;
  return query select p.id,p.display_name,u.email::text,greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at)),
    (select count(*) from public.folders f where f.owner_id=p.id),
    (select count(*) from public.study_assets a where a.created_by=p.id),d.delete_after,d.reason
  from public.profiles p join auth.users u on u.id=p.id left join private.account_deletions d on d.user_id=p.id
  where greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at))<now()-make_interval(days=>p_days)
    and not exists(select 1 from private.app_admins a where a.user_id=p.id)
    and not private.has_active_shared_content(p.id)
  order by greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at)),p.id
  limit least(greatest(p_limit,1),26) offset least(greatest(p_offset,0),1000000);
end;
$$;
create function public.admin_schedule_inactive_accounts(p_user_ids uuid[],p_days integer default 90)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid; scheduled integer=0; affected integer;
begin
  perform private.require_app_admin();
  if p_days is null or p_days not in (90,180,365) or coalesce(cardinality(p_user_ids),0) not between 1 and 25 then raise exception 'Select 1 to 25 inactive accounts and a supported inactivity period'; end if;
  -- Recheck under locks; a stale browser list cannot schedule a recently active user.
  for uid in select distinct unnest(p_user_ids) order by 1 loop
    perform 1 from public.profiles where id=uid for update;
    insert into private.account_deletions(user_id,delete_after,reason,inactive_days)
      select p.id,now()+interval '7 days','inactive',p_days from public.profiles p join auth.users u on u.id=p.id
      where p.id=uid and p.id<>auth.uid() and greatest(p.last_active_at,coalesce(u.last_sign_in_at,p.created_at))<now()-make_interval(days=>p_days)
        and not exists(select 1 from private.app_admins where user_id=uid)
        and not private.has_active_shared_content(uid)
      on conflict do nothing;
    get diagnostics affected=row_count; scheduled=scheduled+affected;
  end loop;
  insert into private.maintenance_events(actor_id,action,account_count) values(auth.uid(),'schedule_inactive',scheduled);
  return jsonb_build_object('scheduled',scheduled,'skipped',cardinality(p_user_ids)-scheduled,'delete_after',now()+interval '7 days');
end;
$$;
create function public.admin_cancel_inactive_account(p_user_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  perform private.require_app_admin();
  delete from private.account_deletions where user_id=p_user_id and reason='inactive' and status='pending' and delete_after>now();
  get diagnostics affected=row_count;
  if affected>0 then insert into private.maintenance_events(actor_id,action,account_count) values(auth.uid(),'cancel_inactive',affected); end if;
  return affected>0;
end;
$$;

-- One bounded cleanup worker at a time, whether invoked by cron or the admin.
create function public.begin_maintenance_run(p_actor_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare token uuid;
begin
  if p_actor_id is not null and not public.is_app_admin_user(p_actor_id) then raise exception 'Admin access required'; end if;
  update private.maintenance_state set run_token=gen_random_uuid(),running_until=now()+interval '5 minutes',last_started_at=now()
    where id and (running_until is null or running_until<=now()) and (last_started_at is null or last_started_at<now()-interval '1 minute') returning run_token into token;
  if token is not null and p_actor_id is not null then insert into private.maintenance_events(actor_id,action) values(p_actor_id,'cleanup'); end if;
  return token;
end;
$$;
create function public.finish_maintenance_run(p_run_token uuid,p_result jsonb)
returns void language sql security definer set search_path='' as $$
  update private.maintenance_state set running_until=null,last_finished_at=now(),result=p_result where id and run_token=p_run_token;
$$;
create function public.prune_maintenance_records()
returns jsonb language plpgsql security definer set search_path='' as $$
declare invitations integer; usage integer; events integer; jobs integer; audits integer;
begin
  -- Preserve all study content, messages, practice history, and source metadata.
  delete from public.folder_invitations where id in (select id from public.folder_invitations where expires_at<now()-interval '30 days' order by expires_at limit 1000); get diagnostics invitations=row_count;
  delete from private.ai_usage where (user_id,usage_date) in (select user_id,usage_date from private.ai_usage where usage_date<current_date-60 order by usage_date limit 1000); get diagnostics usage=row_count;
  delete from public.activity_events where id in (select id from public.activity_events where created_at<now()-interval '90 days' order by created_at limit 1000); get diagnostics events=row_count;
  delete from private.asset_refresh_jobs where id in (select id from private.asset_refresh_jobs where status<>'processing' and created_at<now()-interval '30 days' order by created_at limit 1000); get diagnostics jobs=row_count;
  delete from private.maintenance_events where id in (select id from private.maintenance_events where created_at<now()-interval '180 days' order by created_at limit 1000); get diagnostics audits=row_count;
  return jsonb_build_object('expired_invitations',invitations,'old_usage',usage,'old_activity',events,'old_jobs',jobs,'old_audits',audits);
end;
$$;
-- Due accounts remain frozen. Admins are excluded even if a request was created
-- before their role was granted. Activity during a grace period cancels cleanup.
create or replace function public.claim_due_account_deletions()
returns table(user_id uuid,claim_token uuid) language plpgsql security definer set search_path='' as $$
begin
  -- A collaborator may resume studying after scheduling. Cancel inactive cleanup
  -- before any Storage bytes can be removed, preserving that shared workspace.
  delete from private.account_deletions d where d.reason='inactive' and d.status='pending' and private.has_active_shared_content(d.user_id);
  return query with due as (
    select d.user_id from private.account_deletions d where d.delete_after<=now()
      and not exists(select 1 from private.app_admins a where a.user_id=d.user_id)
      and (d.status='pending' or d.claimed_at is null or d.claimed_at<now()-interval '15 minutes')
    order by d.delete_after limit 5 for update skip locked
  ) update private.account_deletions d set status='processing',claimed_at=now(),claim_token=gen_random_uuid()
    from due where d.user_id=due.user_id returning d.user_id,d.claim_token;
end;
$$;
create or replace function public.request_account_deletion()
returns jsonb language plpgsql security definer set search_path='' as $$
declare entry private.account_deletions;
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid()) then raise exception 'Sign in before requesting account deletion'; end if;
  if exists(select 1 from private.app_admins where user_id=auth.uid()) then raise exception 'Admin accounts are protected. Transfer and remove the admin role in Supabase before deleting this account.'; end if;
  insert into private.account_deletions(user_id) values(auth.uid()) on conflict do nothing;
  select * into entry from private.account_deletions where user_id=auth.uid() for update;
  if entry.status<>'pending' or entry.delete_after<=now() then raise exception 'The deletion period has ended'; end if;
  return jsonb_build_object('delete_after',entry.delete_after,'status',entry.status,'reason',entry.reason);
end;
$$;

revoke all on function public.is_app_admin(),public.mark_app_activity(),public.admin_system_summary(),public.admin_inactive_accounts(integer,integer,integer),public.admin_schedule_inactive_accounts(uuid[],integer),public.admin_cancel_inactive_account(uuid) from public,anon;
grant execute on function public.is_app_admin(),public.mark_app_activity(),public.admin_system_summary(),public.admin_inactive_accounts(integer,integer,integer),public.admin_schedule_inactive_accounts(uuid[],integer),public.admin_cancel_inactive_account(uuid) to authenticated;
revoke all on function private.require_app_admin() from public,anon,authenticated;
revoke all on function private.has_active_shared_content(uuid) from public,anon,authenticated;
revoke all on function public.is_app_admin_user(uuid),public.begin_maintenance_run(uuid),public.finish_maintenance_run(uuid,jsonb),public.prune_maintenance_records() from public,anon,authenticated;
grant execute on function public.is_app_admin_user(uuid),public.begin_maintenance_run(uuid),public.finish_maintenance_run(uuid,jsonb),public.prune_maintenance_records() to service_role;
notify pgrst,'reload schema';
commit;
