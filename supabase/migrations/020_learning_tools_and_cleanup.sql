-- Synapse 2.0.0. Run once after 019. Saved study sets and account data are retained.
begin;
update storage.buckets set file_size_limit=10485760 where id='profile-photos';
create index profiles_avatar_reference on public.profiles(avatar_path) where avatar_path is not null;

create table public.mistake_items (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 asset_id uuid references public.study_assets(id) on delete set null,
 folder_id uuid references public.folders(id) on delete set null,
 question_index integer not null check(question_index between 0 and 49),
 source_title text not null check(char_length(source_title)<=150),
 question text not null check(char_length(question) between 1 and 1500),
 question_type text not null check(question_type in('multiple_choice','true_false','short_answer')),
 answer text not null check(char_length(answer)<=1000),
 accepted_answers jsonb not null default '[]',
 explanation text not null check(char_length(explanation)<=2000),
 user_answer text not null check(char_length(user_answer)<=1000),
 misses integer not null default 1 check(misses between 1 and 1000000),
 mastered_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(user_id,asset_id,question_index)
);
create index mistake_items_personal on public.mistake_items(user_id,updated_at desc,id);
alter table public.mistake_items enable row level security;
grant select,delete on public.mistake_items to authenticated;
grant update(mastered_at) on public.mistake_items to authenticated;
grant all on public.mistake_items to service_role;
create policy mistakes_read on public.mistake_items for select to authenticated using(user_id=(select auth.uid()) and private.account_available(auth.uid()));
create policy mistakes_update on public.mistake_items for update to authenticated using(user_id=(select auth.uid()) and private.account_available(auth.uid())) with check(user_id=(select auth.uid()) and private.account_available(auth.uid()));
create policy mistakes_delete on public.mistake_items for delete to authenticated using(user_id=(select auth.uid()) and private.account_available(auth.uid()));
create table private.mistake_imports(user_id uuid primary key references public.profiles(id) on delete cascade, imported_at timestamptz not null default now());
alter table private.mistake_imports enable row level security;
grant all on private.mistake_imports to service_role;

create function private.keep_quiz_mistake(a public.study_assets,p_user uuid,p_index integer,p_answer text,p_stamp timestamptz)
returns void language plpgsql set search_path='' as $$
declare q jsonb:=a.data->p_index;
begin
 if length(coalesce(q->>'question',''))=0 then return;end if;
 insert into public.mistake_items(user_id,asset_id,folder_id,question_index,source_title,question,question_type,answer,accepted_answers,explanation,user_answer,created_at,updated_at)
 values(p_user,a.id,a.folder_id,p_index,a.title,left(q->>'question',1500),case when q->>'type' in('multiple_choice','true_false') then q->>'type' else 'short_answer' end,left(coalesce(q->>'answer',''),1000),coalesce(q->'accepted_answers','[]'),left(coalesce(q->>'explanation',''),2000),left(coalesce(p_answer,''),1000),p_stamp,p_stamp)
 on conflict(user_id,asset_id,question_index) do update set
 user_answer=excluded.user_answer,answer=excluded.answer,explanation=excluded.explanation,question=excluded.question,accepted_answers=excluded.accepted_answers,source_title=excluded.source_title,
 misses=least(1000000,public.mistake_items.misses+1),mastered_at=null,updated_at=excluded.updated_at
 where public.mistake_items.updated_at<excluded.updated_at;
end;
$$;
create or replace function public.submit_quiz(p_asset_id uuid,p_answers jsonb)
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
    if is_correct then score := score+1;
    else perform private.keep_quiz_mistake(a,auth.uid(),i,p_answers->>i,clock_timestamp());end if;
    feedback := feedback || jsonb_build_array(jsonb_build_object('correct',is_correct,'answer',q->>'answer','explanation',q->>'explanation'));
    i := i+1;
  end loop;
  insert into public.quiz_attempts(asset_id,user_id,correct,total,answers) values(a.id,auth.uid(),score,i,p_answers);
  insert into public.activity_events(folder_id,user_id,message) values(a.folder_id,auth.uid(),'completed ' || a.title || ' with ' || round(100.0*score/i)::text || '% accuracy');
  return jsonb_build_object('correct',score,'total',i,'feedback',feedback);
end;
$$;

-- Import at most the last 200 attempts once, on the owner's first notebook visit.
create function public.my_mistakes(p_mastered boolean default false,p_before timestamptz default null,p_before_id uuid default null)
returns setof public.mistake_items language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); attempt record; a public.study_assets; q jsonb; i integer; response text; expected text; claimed integer;
begin
 if not private.account_available(uid) then raise exception 'Sign in first';end if;
 insert into private.mistake_imports(user_id) values(uid) on conflict do nothing;
 get diagnostics claimed=row_count;
 if claimed=1 then
  for attempt in select * from (select qa.* from public.quiz_attempts qa where qa.user_id=uid order by qa.created_at desc limit 200) recent order by created_at loop
   select * into a from public.study_assets where id=attempt.asset_id and kind='quiz';
   if a.id is null or not private.can_access_folder(a.folder_id) then continue;end if;
   i:=0;
   for q in select value from jsonb_array_elements(a.data) loop
    expected:=lower(trim(q->>'answer'));response:=lower(trim(attempt.answers->>i));
    if not coalesce(response=expected or exists(select 1 from jsonb_array_elements_text(coalesce(q->'accepted_answers','[]')) s where lower(trim(s.value))=response),false) then
     perform private.keep_quiz_mistake(a,uid,i,attempt.answers->>i,attempt.created_at);
    end if;i:=i+1;
   end loop;
  end loop;
 end if;
 return query select m.* from public.mistake_items m where m.user_id=uid and (m.mastered_at is not null)=p_mastered
 and (p_before is null or p_before_id is null or (m.updated_at,m.id)<(p_before,p_before_id)) order by m.updated_at desc,m.id desc limit 51;
end;
$$;
revoke all on function private.keep_quiz_mistake(public.study_assets,uuid,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.my_mistakes(boolean,timestamptz,uuid) from public,anon;
grant execute on function public.my_mistakes(boolean,timestamptz,uuid) to authenticated;

-- Highlight-derived cards are editable custom cards; they never consume an AI call.
create function public.save_highlight_cards(p_source_id uuid,p_title text,p_cards jsonb,p_deck_id uuid default null)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare source public.study_assets; deck public.study_assets; cards jsonb:='[]'; item jsonb;
begin
 select * into source from public.study_assets where id=p_source_id and kind='note';
 if source.id is null or not private.can_access_folder(source.folder_id,true) then raise exception 'Editor access required';end if;
 if p_deck_id is null then return public.create_manual_deck(source.folder_id,p_title,p_cards);end if;
 select * into deck from public.study_assets where id=p_deck_id for update;
 if deck.id is null or not deck.is_custom or deck.kind<>'deck' or deck.folder_id<>source.folder_id or deck.created_by<>auth.uid() then raise exception 'Choose your own custom deck in this space';end if;
 if jsonb_typeof(p_cards) is distinct from 'array' or jsonb_array_length(p_cards) not between 1 and 100 or jsonb_array_length(deck.data)+jsonb_array_length(p_cards)>100 then raise exception 'A custom deck can contain up to 100 cards';end if;
 for item in select jsonb_array_elements(p_cards) loop
  if jsonb_typeof(item->'front') is distinct from 'string' or jsonb_typeof(item->'back') is distinct from 'string' or length(trim(item->>'front')) not between 1 and 1000 or length(trim(item->>'back')) not between 1 and 2000 then raise exception 'Each card needs a question and answer';end if;
  cards:=cards||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'front',trim(item->>'front'),'back',trim(item->>'back')));
 end loop;
 cards:=deck.data||cards;
 if octet_length(cards::text)>120000 then raise exception 'This deck is too large. Split it into smaller decks';end if;
 update public.study_assets set data=cards where id=deck.id returning * into deck;
 return deck;
end;
$$;
revoke all on function public.save_highlight_cards(uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.save_highlight_cards(uuid,text,jsonb,uuid) to authenticated;

-- A small quarantine prevents a reference/upload race while the Storage API removes an orphan.
create table private.orphan_storage_claims(
 bucket_id text not null check(bucket_id in('study-files','profile-photos')),storage_path text not null,
 object_id uuid not null,claim_id uuid not null default gen_random_uuid(),run_token uuid not null,claimed_at timestamptz not null default now(),
 primary key(bucket_id,storage_path),unique(claim_id)
);
alter table private.orphan_storage_claims enable row level security;
grant all on private.orphan_storage_claims to service_role;
create function private.storage_write_available(p_bucket text,p_path text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_bucket not in('study-files','profile-photos') then return true;end if;
 perform pg_advisory_xact_lock(hashtextextended(p_bucket||'/'||p_path,0));
 return not exists(select 1 from private.orphan_storage_claims where bucket_id=p_bucket and storage_path=p_path);
end;
$$;
grant execute on function private.storage_write_available(text,text) to authenticated;
revoke all on function private.storage_write_available(text,text) from public,anon;
create policy synapse_cleanup_insert_guard on storage.objects as restrictive for insert to authenticated with check(private.storage_write_available(bucket_id,name));
create policy synapse_cleanup_update_guard on storage.objects as restrictive for update to authenticated using(private.storage_write_available(bucket_id,name)) with check(private.storage_write_available(bucket_id,name));
create function private.guard_storage_reference()
returns trigger language plpgsql security definer set search_path='' as $$
declare bucket text; path text;
begin
 if tg_table_name='profiles' then bucket:='profile-photos';path:=new.avatar_path;else bucket:='study-files';path:=new.storage_path;end if;
 if path is not null and not private.storage_write_available(bucket,path) then raise exception 'This unused file is being cleaned up. Upload it again.';end if;
 return new;
end;
$$;
create trigger profile_storage_cleanup_guard before insert or update of avatar_path on public.profiles for each row execute function private.guard_storage_reference();
create trigger document_storage_cleanup_guard before insert or update of storage_path on public.document_files for each row execute function private.guard_storage_reference();
revoke all on function private.guard_storage_reference() from public,anon,authenticated;

create function private.require_maintenance_lease(p_run_token uuid)
returns void language plpgsql stable set search_path='' as $$
begin
 if not exists(select 1 from private.maintenance_state where id and run_token=p_run_token and running_until>clock_timestamp()) then raise exception 'Cleanup lease expired';end if;
end;
$$;
create function public.expired_storage_files(p_run_token uuid)
returns table(id uuid,storage_path text) language plpgsql security definer set search_path='' as $$
begin
 perform private.require_maintenance_lease(p_run_token);
 return query select d.id,d.storage_path from public.document_files d where d.expires_at<=now() and d.purged_at is null
 and not exists(select 1 from private.generation_queue q where q.status='processing' and q.lease_until>clock_timestamp() and (q.document_id=d.id or q.material_id=d.material_id))
 and not exists(select 1 from private.material_jobs j where j.material_id=d.material_id and j.status='processing' and j.created_at>now()-interval '15 minutes')
 order by d.expires_at limit 200;
end;
$$;
create function public.claim_orphan_storage(p_run_token uuid)
returns setof private.orphan_storage_claims language plpgsql security definer set search_path='' as $$
declare o record; result private.orphan_storage_claims;
begin
 perform private.require_maintenance_lease(p_run_token);
 for o in select s.id,s.bucket_id,s.name from storage.objects s
 where s.bucket_id in('study-files','profile-photos') and s.created_at<now()-interval '24 hours'
 and (s.bucket_id<>'study-files' or not exists(select 1 from public.document_files d where d.storage_path=s.name))
 and (s.bucket_id<>'profile-photos' or not exists(select 1 from public.profiles p where p.avatar_path=s.name))
 order by s.created_at,s.id limit 200 loop
  perform pg_advisory_xact_lock(hashtextextended(o.bucket_id||'/'||o.name,0));
  -- Recheck after acquiring the same transaction lock used by reference creation.
  if exists(select 1 from public.document_files where storage_path=o.name) and o.bucket_id='study-files' or exists(select 1 from public.profiles where avatar_path=o.name) and o.bucket_id='profile-photos' then continue;end if;
  if not exists(select 1 from storage.objects where id=o.id and bucket_id=o.bucket_id and name=o.name and created_at<now()-interval '24 hours') then continue;end if;
  insert into private.orphan_storage_claims(bucket_id,storage_path,object_id,run_token) values(o.bucket_id,o.name,o.id,p_run_token)
  on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,run_token=excluded.run_token,claim_id=gen_random_uuid(),claimed_at=now()
  returning * into result;
  return next result;
 end loop;
 -- Remove stale quarantine metadata only when its original object no longer exists.
 delete from private.orphan_storage_claims c where not exists(select 1 from storage.objects s where s.id=c.object_id) and c.claimed_at<now()-interval '24 hours';
end;
$$;
create function public.finish_orphan_storage(p_run_token uuid,p_claim_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform private.require_maintenance_lease(p_run_token);
 if cardinality(p_claim_ids)>200 then raise exception 'Cleanup batch is too large';end if;
 delete from private.orphan_storage_claims where run_token=p_run_token and claim_id=any(p_claim_ids);
 get diagnostics n=row_count;return n;
end;
$$;
-- Never remove a queued path if a live metadata record still references it.
create or replace function public.pending_storage_deletions()
returns table(storage_path text) language sql security definer set search_path='' as $$
 select q.storage_path from private.storage_deletion_queue q where not exists(select 1 from public.document_files d where d.storage_path=q.storage_path) order by q.created_at limit 200;
$$;
revoke all on function private.require_maintenance_lease(uuid),public.expired_storage_files(uuid),public.claim_orphan_storage(uuid),public.finish_orphan_storage(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.expired_storage_files(uuid),public.claim_orphan_storage(uuid),public.finish_orphan_storage(uuid,uuid[]) to service_role;
commit;
