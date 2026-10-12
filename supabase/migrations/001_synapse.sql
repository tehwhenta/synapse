-- Synapse v1: run ONCE in a new Supabase project. This script is transactional.
begin;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);
create table public.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '' check (char_length(description) <= 300),
  color text not null default '#8c8d65' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now()
);
create table public.folder_members (
  folder_id uuid not null references public.folders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('viewer','editor')),
  joined_at timestamptz not null default now(),
  primary key(folder_id,user_id)
);
create table public.folder_invitations (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  token_hash text not null unique,
  email text,
  role text not null check (role in ('viewer','editor')),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.document_files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  name text not null check (char_length(name) between 1 and 200),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-powerpoint')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  status text not null default 'uploaded' check (status in ('uploaded','processing','ready','failed')),
  extracted_text text check (char_length(extracted_text) <= 100000),
  error_message text,
  processing_started_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  unique(id,folder_id),
  check (storage_path like folder_id::text || '/' || uploaded_by::text || '/' || id::text || '.%')
);
create table public.study_assets (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  document_id uuid,
  kind text not null check (kind in ('note','deck','quiz')),
  title text not null check (char_length(title) between 1 and 150),
  content text not null default '' check (char_length(content) <= 60000),
  data jsonb not null default '[]'::jsonb check (jsonb_typeof(data) = 'array' and octet_length(data::text) <= 120000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(document_id,folder_id) references public.document_files(id,folder_id),
  unique(document_id,kind)
);
create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.study_assets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  correct integer not null check (correct >= 0),
  total integer not null check (total > 0 and correct <= total),
  answers jsonb not null,
  created_at timestamptz not null default now()
);
create table public.flashcard_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  asset_id uuid not null references public.study_assets(id) on delete cascade,
  card_index integer not null check (card_index >= 0),
  repetitions integer not null default 0,
  interval_days integer not null default 0,
  ease numeric(5,2) not null default 2.5,
  due_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id,asset_id,card_index)
);
create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  duration_seconds integer not null check (duration_seconds between 30 and 14400),
  created_at timestamptz not null default now()
);
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null check (char_length(message) <= 300),
  created_at timestamptz not null default now()
);
create table public.study_messages (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create table private.ai_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null default current_date,
  requests integer not null default 0,
  primary key(user_id,usage_date)
);
create index folders_owner on public.folders(owner_id);
create index folder_members_user on public.folder_members(user_id);
create index assets_folder_time on public.study_assets(folder_id,created_at desc);
create index documents_folder_time on public.document_files(folder_id,created_at desc);
create index documents_expiry on public.document_files(expires_at) where purged_at is null;
create index attempts_user_time on public.quiz_attempts(user_id,created_at desc);
create index progress_due on public.flashcard_progress(user_id,due_at);
create index sessions_user_time on public.study_sessions(user_id,created_at desc);
create index activity_folder_time on public.activity_events(folder_id,created_at desc);
create index messages_folder_time on public.study_messages(folder_id,created_at desc);

-- Non-recursive helpers. Caller identity always comes from auth.uid(), never a client argument.
create function private.can_access_folder(fid uuid, editing boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.folders f where f.id = fid and f.owner_id = auth.uid())
    or exists(select 1 from public.folder_members m where m.folder_id = fid and m.user_id = auth.uid() and (not editing or m.role = 'editor'));
$$;
create function private.owns_folder(fid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.folders where id = fid and owner_id = auth.uid());
$$;
create function private.shares_folder(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select uid = auth.uid() or exists(
    select 1 from public.folders f where private.can_access_folder(f.id)
      and (f.owner_id = uid or exists(select 1 from public.folder_members m where m.folder_id = f.id and m.user_id = uid))
  );
$$;
create function private.realtime_access(topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if topic !~ '^folder:[0-9a-fA-F-]{36}$' then return false; end if;
  return private.can_access_folder(substring(topic from 8)::uuid);
exception when invalid_text_representation then return false;
end;
$$;
create function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,display_name) values(new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),split_part(new.email,'@',1),'Student'),80));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();
-- Also supports an account created just before this migration.
insert into public.profiles(id,display_name)
select id,left(coalesce(nullif(trim(raw_user_meta_data->>'display_name'),''),split_part(email,'@',1),'Student'),80) from auth.users on conflict do nothing;

-- Privileges are restricted separately from RLS, preventing column-level role/owner tampering.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles,public.folders,public.folder_members,public.document_files,public.study_assets,public.quiz_attempts,public.flashcard_progress,public.study_sessions,public.activity_events,public.study_messages to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant update(title,description,color) on public.folders to authenticated;
grant insert(id,folder_id,uploaded_by,name,storage_path,mime_type,size_bytes) on public.document_files to authenticated;
grant insert(folder_id,kind,title,content,data,created_by) on public.study_assets to authenticated;
grant update(title,content,data) on public.study_assets to authenticated;
grant delete on public.study_assets to authenticated;
grant insert(folder_id,user_id,body) on public.study_messages to authenticated;
grant delete on public.study_messages to authenticated;

alter table public.profiles enable row level security;
alter table public.folders enable row level security;
alter table public.folder_members enable row level security;
alter table public.folder_invitations enable row level security;
alter table public.document_files enable row level security;
alter table public.study_assets enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.flashcard_progress enable row level security;
alter table public.study_sessions enable row level security;
alter table public.activity_events enable row level security;
alter table public.study_messages enable row level security;
create policy profiles_read on public.profiles for select to authenticated using(private.shares_folder(id));
create policy profiles_update on public.profiles for update to authenticated using(id = (select auth.uid())) with check(id = (select auth.uid()));
create policy folders_read on public.folders for select to authenticated using(private.can_access_folder(id));
create policy folders_update on public.folders for update to authenticated using(private.owns_folder(id)) with check(private.owns_folder(id));
create policy members_read on public.folder_members for select to authenticated using(private.can_access_folder(folder_id));
create policy documents_read on public.document_files for select to authenticated using(private.can_access_folder(folder_id));
create policy documents_insert on public.document_files for insert to authenticated with check(uploaded_by = (select auth.uid()) and private.can_access_folder(folder_id,true));
create policy assets_read on public.study_assets for select to authenticated using(private.can_access_folder(folder_id));
create policy assets_insert on public.study_assets for insert to authenticated with check(created_by = (select auth.uid()) and private.can_access_folder(folder_id,true));
create policy assets_update on public.study_assets for update to authenticated using(private.can_access_folder(folder_id,true)) with check(private.can_access_folder(folder_id,true));
create policy assets_delete on public.study_assets for delete to authenticated using(private.can_access_folder(folder_id,true));
create policy attempts_read on public.quiz_attempts for select to authenticated using(user_id = (select auth.uid()));
create policy progress_read on public.flashcard_progress for select to authenticated using(user_id = (select auth.uid()));
create policy sessions_read on public.study_sessions for select to authenticated using(user_id = (select auth.uid()));
create policy activity_read on public.activity_events for select to authenticated using(private.can_access_folder(folder_id));
create policy messages_read on public.study_messages for select to authenticated using(private.can_access_folder(folder_id));
create policy messages_insert on public.study_messages for insert to authenticated with check(user_id = (select auth.uid()) and private.can_access_folder(folder_id));
create policy messages_delete on public.study_messages for delete to authenticated using(user_id = (select auth.uid()) or private.owns_folder(folder_id));

create function private.touch_asset() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
create trigger touch_study_asset before update on public.study_assets for each row execute function private.touch_asset();

create function public.create_folder(p_title text,p_description text default '',p_color text default '#8c8d65')
returns public.folders language plpgsql security definer set search_path = '' as $$
declare result public.folders;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.folders(owner_id,title,description,color) values(auth.uid(),trim(p_title),trim(p_description),p_color) returning * into result;
  return result;
end;
$$;
create function public.create_invitation(p_folder_id uuid,p_role text default 'viewer',p_email text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare token text := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
begin
  if not private.owns_folder(p_folder_id) then raise exception 'Only the folder owner can invite people'; end if;
  insert into public.folder_invitations(folder_id,token_hash,role,email)
  values(p_folder_id,encode(sha256(convert_to(token,'UTF8')),'hex'),p_role,nullif(lower(trim(p_email)),''));
  return token;
end;
$$;
create function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare inv public.folder_invitations; caller_email text;
begin
  if auth.uid() is null then raise exception 'Sign in before opening an invite'; end if;
  select * into inv from public.folder_invitations where token_hash = encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
  if inv.id is null or inv.accepted_at is not null or inv.expires_at <= now() then raise exception 'Invite expired, invalid, or already used'; end if;
  select lower(email) into caller_email from auth.users where id = auth.uid();
  if inv.email is not null and inv.email <> caller_email then raise exception 'This invitation is for a different email address'; end if;
  if private.owns_folder(inv.folder_id) then raise exception 'You already own this folder'; end if;
  insert into public.folder_members(folder_id,user_id,role) values(inv.folder_id,auth.uid(),inv.role)
  on conflict(folder_id,user_id) do update set role = excluded.role;
  update public.folder_invitations set accepted_at = now() where id = inv.id;
  insert into public.activity_events(folder_id,user_id,message) values(inv.folder_id,auth.uid(),'joined the study space');
  return inv.folder_id;
end;
$$;
create function public.update_member(p_folder_id uuid,p_user_id uuid,p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.owns_folder(p_folder_id) then raise exception 'Owner access required'; end if;
  if p_role is null then delete from public.folder_members where folder_id=p_folder_id and user_id=p_user_id;
  else update public.folder_members set role=p_role where folder_id=p_folder_id and user_id=p_user_id; end if;
end;
$$;
create function public.submit_quiz(p_asset_id uuid,p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.study_assets; q jsonb; score integer := 0; i integer := 0; expected text; response text; is_correct boolean; feedback jsonb := '[]';
begin
  select * into a from public.study_assets where id = p_asset_id and kind='quiz';
  if a.id is null or not private.can_access_folder(a.folder_id) then raise exception 'Quiz unavailable'; end if;
  if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> jsonb_array_length(a.data) or jsonb_array_length(a.data)=0 then raise exception 'Answer every question'; end if;
  if octet_length(p_answers::text)>20000 then raise exception 'Answers are too long'; end if;
  for q in select value from jsonb_array_elements(a.data) loop
    expected := lower(trim(q->>'answer')); response := lower(trim(p_answers->>i));
    is_correct := coalesce(response = expected or exists(select 1 from jsonb_array_elements_text(coalesce(q->'accepted_answers','[]'::jsonb)) s where lower(trim(s.value))=response),false);
    if is_correct then score := score+1; end if;
    feedback := feedback || jsonb_build_array(jsonb_build_object('correct',is_correct,'answer',q->>'answer','explanation',q->>'explanation'));
    i := i+1;
  end loop;
  insert into public.quiz_attempts(asset_id,user_id,correct,total,answers) values(a.id,auth.uid(),score,i,p_answers);
  insert into public.activity_events(folder_id,user_id,message) values(a.folder_id,auth.uid(),'completed ' || a.title || ' with ' || round(100.0*score/i)::text || '% accuracy');
  return jsonb_build_object('correct',score,'total',i,'feedback',feedback);
end;
$$;
create function public.review_card(p_asset_id uuid,p_card_index integer,p_rating integer)
returns public.flashcard_progress language plpgsql security definer set search_path = '' as $$
declare a public.study_assets; result public.flashcard_progress; days integer; reps integer;
begin
  select * into a from public.study_assets where id=p_asset_id and kind='deck';
  if a.id is null or not private.can_access_folder(a.folder_id) then raise exception 'Deck unavailable'; end if;
  if p_card_index<0 or p_card_index>=jsonb_array_length(a.data) or p_rating not in (1,2,3,4) then raise exception 'Invalid card review'; end if;
  insert into public.flashcard_progress(user_id,asset_id,card_index) values(auth.uid(),a.id,p_card_index) on conflict do nothing;
  select * into result from public.flashcard_progress where user_id=auth.uid() and asset_id=a.id and card_index=p_card_index for update;
  reps := case when p_rating=1 then 0 else result.repetitions+1 end;
  days := case when p_rating=1 then 0 when p_rating=2 then greatest(1,result.interval_days)
    when reps=1 then 1 when reps=2 then 3 else greatest(1,round(result.interval_days*result.ease))::integer end;
  if p_rating=4 then days:=greatest(3,round(days*1.3))::integer; end if;
  update public.flashcard_progress set repetitions=reps,interval_days=days,ease=greatest(1.3,least(3.5,ease + case when p_rating=1 then -0.2 when p_rating=2 then -0.15 when p_rating=4 then 0.15 else 0 end)),
    due_at=now() + case when days=0 then interval '10 minutes' else make_interval(days=>days) end,updated_at=now()
    where user_id=auth.uid() and asset_id=a.id and card_index=p_card_index returning * into result;
  return result;
end;
$$;
create function public.log_study_session(p_folder_id uuid,p_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_access_folder(p_folder_id) then raise exception 'Folder unavailable'; end if;
  insert into public.study_sessions(folder_id,user_id,duration_seconds) values(p_folder_id,auth.uid(),p_seconds);
  insert into public.activity_events(folder_id,user_id,message) values(p_folder_id,auth.uid(),'finished a ' || greatest(1,round(p_seconds/60.0))::text || ' minute focus session');
end;
$$;
-- Lifetime totals and a calendar-day streak without exposing another user's progress.
create function public.my_progress_stats(p_timezone text default 'UTC')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare tz text := p_timezone; base_day date; streak integer;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not exists(select 1 from pg_timezone_names where name=tz) then tz := 'UTC'; end if;
  base_day := (now() at time zone tz)::date;
  if not exists(select 1 from public.study_sessions where user_id=auth.uid() and (created_at at time zone tz)::date=base_day)
    and not exists(select 1 from public.quiz_attempts where user_id=auth.uid() and (created_at at time zone tz)::date=base_day) then base_day:=base_day-1; end if;
  with days as (
    select (created_at at time zone tz)::date as day from public.study_sessions where user_id=auth.uid()
    union select (created_at at time zone tz)::date from public.quiz_attempts where user_id=auth.uid()
  ), ranked as (select day,(row_number() over(order by day desc)-1)::integer as n from days where day<=base_day)
  select count(*)::integer into streak from ranked where day=base_day-n;
  return jsonb_build_object(
    'minutes',(select coalesce(sum(duration_seconds),0)/60 from public.study_sessions where user_id=auth.uid()),
    'mastered',(select count(*) from public.flashcard_progress where user_id=auth.uid() and repetitions>=3),
    'quizzes',(select count(*) from public.quiz_attempts where user_id=auth.uid()),'streak',streak);
end;
$$;
-- Only backend callers can claim AI work or persist AI output. Atomic claim prevents duplicate spend.
create function public.claim_generation(p_document_id uuid,p_user_id uuid)
returns public.document_files language plpgsql security definer set search_path = '' as $$
declare doc public.document_files; used integer;
begin
  select * into doc from public.document_files where id=p_document_id for update;
  if doc.id is null or not (exists(select 1 from public.folders where id=doc.folder_id and owner_id=p_user_id) or exists(select 1 from public.folder_members where folder_id=doc.folder_id and user_id=p_user_id and role='editor')) then raise exception 'Editor access required'; end if;
  if doc.status='ready' then return doc; end if;
  if doc.status='processing' and doc.processing_started_at > now()-interval '15 minutes' then raise exception 'This document is already processing'; end if;
  if doc.purged_at is not null or doc.expires_at<=now() then raise exception 'Raw file expired. Upload it again'; end if;
  insert into private.ai_usage(user_id,usage_date,requests) values(p_user_id,current_date,1)
  on conflict(user_id,usage_date) do update set requests=private.ai_usage.requests+1 returning requests into used;
  if used>20 then raise exception 'Daily limit reached (20 AI generations per user)'; end if;
  update public.document_files set status='processing',processing_started_at=now(),error_message=null where id=doc.id returning * into doc;
  return doc;
end;
$$;
create function public.complete_generation(p_document_id uuid,p_user_id uuid,p_output jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document_files;
begin
  select * into doc from public.document_files where id=p_document_id and status='processing' for update;
  if doc.id is null then raise exception 'Generation claim is missing'; end if;
  insert into public.study_assets(folder_id,document_id,kind,title,content,data,created_by) values
    (doc.folder_id,doc.id,'note',p_output->>'title',p_output->>'notes','[]',p_user_id),
    (doc.folder_id,doc.id,'deck',(p_output->>'title') || ' · Flashcards','',p_output->'flashcards',p_user_id),
    (doc.folder_id,doc.id,'quiz',(p_output->>'title') || ' · Practice','',p_output->'quiz',p_user_id);
  update public.document_files set status='ready',extracted_text=left(p_output->>'source_text',100000),expires_at=now()+interval '24 hours' where id=doc.id;
  insert into public.activity_events(folder_id,user_id,message) values(doc.folder_id,p_user_id,'created study materials from ' || doc.name);
end;
$$;
revoke all on all functions in schema private from public,anon;
grant execute on function private.can_access_folder(uuid,boolean),private.owns_folder(uuid),private.shares_folder(uuid),private.realtime_access(text) to authenticated,service_role;
revoke all on function public.create_folder(text,text,text),public.create_invitation(uuid,text,text),public.accept_invitation(text),public.update_member(uuid,uuid,text),public.submit_quiz(uuid,jsonb),public.review_card(uuid,integer,integer),public.log_study_session(uuid,integer),public.my_progress_stats(text) from public,anon;
grant execute on function public.create_folder(text,text,text),public.create_invitation(uuid,text,text),public.accept_invitation(text),public.update_member(uuid,uuid,text),public.submit_quiz(uuid,jsonb),public.review_card(uuid,integer,integer),public.log_study_session(uuid,integer),public.my_progress_stats(text) to authenticated;
revoke all on function public.claim_generation(uuid,uuid),public.complete_generation(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_generation(uuid,uuid),public.complete_generation(uuid,uuid,jsonb) to service_role;
grant all on all tables in schema public to service_role;
grant all on all tables in schema private to service_role;

-- Private, temporary raw files. No public object URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('study-files','study-files',false,10485760,
  array['application/pdf','image/jpeg','image/png','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-powerpoint']);
create policy synapse_storage_read on storage.objects for select to authenticated using(bucket_id='study-files' and exists(select 1 from public.document_files d where d.storage_path=storage.objects.name and private.can_access_folder(d.folder_id)));
create policy synapse_storage_insert on storage.objects for insert to authenticated with check(bucket_id='study-files' and exists(select 1 from public.document_files d where d.storage_path=storage.objects.name and d.uploaded_by=(select auth.uid()) and private.can_access_folder(d.folder_id,true) and d.status='uploaded' and d.purged_at is null));
create policy synapse_storage_delete on storage.objects for delete to authenticated using(bucket_id='study-files' and exists(select 1 from public.document_files d where d.storage_path=storage.objects.name and ((d.uploaded_by=(select auth.uid()) and private.can_access_folder(d.folder_id,true)) or private.owns_folder(d.folder_id))));
-- Do not ALTER realtime.messages: Supabase already owns/enables its RLS.
create policy synapse_realtime_read on realtime.messages for select to authenticated using(extension in ('broadcast','presence') and private.realtime_access((select realtime.topic())));
create policy synapse_realtime_write on realtime.messages for insert to authenticated with check(extension in ('broadcast','presence') and private.realtime_access((select realtime.topic())));
-- Shared content sync. Only tables needed by the workspace are published.
do $$ declare tbl text; begin
  foreach tbl in array array['folders','folder_members','study_assets','document_files','activity_events','study_messages'] loop
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=tbl) then
      execute format('alter publication supabase_realtime add table public.%I',tbl);
    end if;
  end loop;
end; $$;
commit;
