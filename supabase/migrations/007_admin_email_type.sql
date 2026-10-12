-- Repair the admin inactive-account query after migration 006.
-- Supabase Auth stores email as varchar(255); this RPC returns text.
-- No users or study data are changed. Existing function grants are retained.
begin;

create or replace function public.admin_inactive_accounts(p_days integer default 90,p_offset integer default 0,p_limit integer default 26)
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

notify pgrst,'reload schema';
commit;
