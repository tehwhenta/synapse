-- Use only in Supabase SQL Editor, after 006 and confirming this account's email.
-- Binding is to the current UUID. Recreating/changing an email never grants a role.
do $$
declare uid uuid;
begin
  select u.id into uid from auth.users u join public.profiles p on p.id=u.id
    where lower(u.email)='rcgsynapse@gmail.com' and u.email_confirmed_at is not null;
  if uid is null then raise exception 'Create and confirm rcgsynapse@gmail.com in Synapse first'; end if;
  insert into private.app_admins(user_id) values(uid) on conflict do nothing;
end;
$$;
