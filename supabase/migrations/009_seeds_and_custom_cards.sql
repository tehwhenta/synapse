-- Synapse 1.6. Run ONCE after 008. Seeds reset at midnight Asia/Manila.
begin;
create table private.seed_usage (
 user_id uuid not null references public.profiles(id) on delete cascade,
 usage_date date not null,
 spent integer not null default 0 check(spent between 0 and 30),
 primary key(user_id,usage_date)
);
create table private.material_concepts (
 material_id uuid not null references public.study_materials(id) on delete cascade,
 concept_id text not null,
 topic_id text not null,
 label text not null check(char_length(label) between 1 and 300),
 primary key(material_id,concept_id)
);
create table private.material_coverage (
 material_id uuid not null,
 kind text not null check(kind in('note','deck','quiz')),
 concept_id text not null,
 primary key(material_id,kind,concept_id),
 foreign key(material_id,concept_id) references private.material_concepts(material_id,concept_id) on delete cascade
);
create index seed_usage_day on private.seed_usage(usage_date);
create index concepts_topic on private.material_concepts(material_id,topic_id);
alter table private.seed_usage enable row level security;
alter table private.material_concepts enable row level security;
alter table private.material_coverage enable row level security;
grant all on private.seed_usage,private.material_concepts,private.material_coverage to service_role;
create function private.seed_day()
returns date language sql stable set search_path='' as $$ select (now() at time zone 'Asia/Manila')::date $$;
create function public.my_seed_balance()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.account_available(auth.uid()) then raise exception 'Sign in to see your Seeds'; end if;
 return jsonb_build_object('remaining',30-coalesce((select spent from private.seed_usage where user_id=auth.uid() and usage_date=private.seed_day()),0),'total',30,
 'reset_at',(private.seed_day()+1)::timestamp at time zone 'Asia/Manila','server_now',now(),'timezone','Asia/Manila');
end;
$$;
alter table public.study_assets add column is_custom boolean not null default false;
update public.study_assets set is_custom=true where kind='deck' and material_id is null and document_id is null;
update public.study_assets a set data=(select coalesce(jsonb_agg(q||jsonb_build_object('id',gen_random_uuid()) order by ord),'[]') from jsonb_array_elements(a.data) with ordinality as c(q,ord)) where is_custom;
revoke update(data) on public.study_assets from authenticated;
create or replace function public.create_manual_deck(p_folder_id uuid,p_title text,p_cards jsonb)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare item jsonb; result public.study_assets; cards jsonb='[]';
begin
 if not private.can_access_folder(p_folder_id,true) then raise exception 'Editor access required'; end if;
 if length(trim(coalesce(p_title,''))) not between 1 and 150 or jsonb_typeof(p_cards) is distinct from 'array' or jsonb_array_length(p_cards) not between 1 and 100 or octet_length(p_cards::text)>120000 then raise exception 'Enter a title and 1 to 100 custom flashcards'; end if;
 for item in select jsonb_array_elements(p_cards) loop
   if length(trim(coalesce(item->>'front',''))) not between 1 and 1000 or length(trim(coalesce(item->>'back',''))) not between 1 and 2000 then raise exception 'Each card needs a question and answer'; end if;
   cards:=cards||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'front',trim(item->>'front'),'back',trim(item->>'back')));
 end loop;
 if octet_length(cards::text)>120000 then raise exception 'This deck is too large. Split it into smaller decks'; end if;
 insert into public.study_assets(folder_id,kind,title,data,created_by,is_custom) values(p_folder_id,'deck',trim(p_title),cards,auth.uid(),true) returning * into result;
 return result;
end;
$$;
create function public.update_custom_card(p_asset_id uuid,p_card_id uuid,p_front text default null,p_back text default null,p_delete boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.study_assets; idx integer; cards jsonb; item jsonb; schedules jsonb;
begin
 select * into a from public.study_assets where id=p_asset_id for update;
 if a.id is null or not private.can_access_folder(a.folder_id,true) then raise exception 'Editor access required'; end if;
 if a.kind<>'deck' or not a.is_custom then raise exception 'Only custom flashcards can be changed'; end if;
 select (ord-1)::integer into idx from jsonb_array_elements(a.data) with ordinality c(q,ord) where q->>'id'=p_card_id::text;
 if idx is null then raise exception 'This card was already removed. Reopen the deck'; end if;
 if p_delete then
   if jsonb_array_length(a.data)=1 then delete from public.study_assets where id=a.id; return jsonb_build_object('deleted_deck',true,'asset_id',a.id); end if;
   cards:=a.data-idx;
   perform 1 from public.flashcard_progress where asset_id=a.id for update;
   select coalesce(jsonb_agg(to_jsonb(p)),'[]') into schedules from public.flashcard_progress p where asset_id=a.id;
   delete from public.flashcard_progress where asset_id=a.id;
   insert into public.flashcard_progress(user_id,asset_id,card_index,ease,interval_days,repetitions,due_at,updated_at)
     select user_id,asset_id,case when card_index>idx then card_index-1 else card_index end,ease,interval_days,repetitions,due_at,updated_at from jsonb_to_recordset(schedules) p(user_id uuid,asset_id uuid,card_index integer,ease numeric,interval_days integer,repetitions integer,due_at timestamptz,updated_at timestamptz) where card_index<>idx;
 else
   if length(trim(coalesce(p_front,''))) not between 1 and 1000 or length(trim(coalesce(p_back,''))) not between 1 and 2000 then raise exception 'Enter a question and answer within the card limits'; end if;
   item:=jsonb_build_object('id',p_card_id,'front',trim(p_front),'back',trim(p_back));
   cards:=jsonb_set(a.data,array[idx::text],item);
   if octet_length(cards::text)>120000 then raise exception 'This deck is too large'; end if;
   delete from public.flashcard_progress where asset_id=a.id and card_index=idx;
 end if;
 update public.study_assets set data=cards where id=a.id returning * into a;
 return jsonb_build_object('asset',to_jsonb(a));
end;
$$;

-- Earlier scans have no finite concept inventory. Analyze their retained source
-- once under the new schema; existing study assets/history remain intact.
update public.study_materials set analysis_status='unscanned',analysis_attempts=0,analysis_token=null where analysis_status in('ready','failed');
create or replace function public.claim_material_analysis(p_material_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials; used integer; history jsonb;
begin
 select * into m from public.study_materials where id=p_material_id for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if m.analysis_status='ready' then return jsonb_build_object('cached',true,'material',to_jsonb(m)); end if;
 if m.analysis_status='scanning' and m.analysis_started_at>now()-interval '15 minutes' then raise exception 'This material is already being scanned'; end if;
 if m.analysis_attempts>=3 then raise exception 'This source could not be scanned. Upload a clearer chapter or contact the app owner'; end if;
 insert into private.ai_usage(user_id,usage_date,requests) values(p_user_id,private.seed_day(),1) on conflict(user_id,usage_date) do update set requests=private.ai_usage.requests+1 returning requests into used;
 if used>30 then raise exception 'Daily source scan limit reached. Try again tomorrow'; end if;
 update public.study_materials set analysis_status='scanning',analysis_attempts=analysis_attempts+1,analysis_started_at=now(),analysis_token=gen_random_uuid(),analysis_error=null where id=m.id returning * into m;
 select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'prompt',prompt)),'[]') into history from private.material_history where material_id=m.id;
 return jsonb_build_object('cached',false,'token',m.analysis_token,'material',to_jsonb(m),'history',history);
end;
$$;
create or replace function public.finish_material_analysis(p_material_id uuid,p_user_id uuid,p_token uuid,p_output jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare m public.study_materials; topic jsonb; concept jsonb; tid integer=0; cid integer; count_all integer=0; covered_kind text;
begin
 select * into m from public.study_materials where id=p_material_id and analysis_token=p_token and analysis_status='scanning' and analysis_started_at>now()-interval '15 minutes' for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Source analysis claim expired'; end if;
 if jsonb_typeof(p_output->'topics') is distinct from 'array' or jsonb_array_length(p_output->'topics') not between 1 and 24 or length(trim(coalesce(p_output->>'source_text',''))) not between 20 and 100000 then raise exception 'Source analysis is incomplete'; end if;
 for topic in select jsonb_array_elements(p_output->'topics') loop
  tid:=tid+1;cid:=0;
  if topic->>'id' is distinct from ('topic-'||tid) or length(trim(coalesce(topic->>'title',''))) not between 1 and 100 or coalesce(topic->>'card_count','') !~ '^[0-9]{1,2}$' or coalesce(topic->>'quiz_count','') !~ '^[0-9]{1,2}$'
   or (topic->>'card_count')::integer not between 3 and 30 or (topic->>'quiz_count')::integer not between 3 and 30 or (topic->>'quiz_count')::integer%3<>0 or jsonb_typeof(topic->'concepts') is distinct from 'array' or jsonb_array_length(topic->'concepts') not between 1 and 80 then raise exception 'Topic inventory is invalid'; end if;
  for concept in select jsonb_array_elements(topic->'concepts') loop
   cid:=cid+1;count_all:=count_all+1;
   if count_all>500 or concept->>'id' is distinct from ('topic-'||tid||':concept-'||cid) or length(trim(coalesce(concept->>'label',''))) not between 1 and 300 then raise exception 'Concept inventory is invalid'; end if;
   insert into private.material_concepts(material_id,concept_id,topic_id,label) values(m.id,concept->>'id',topic->>'id',concept->>'label');
   if jsonb_typeof(concept->'covered_by') is distinct from 'array' then raise exception 'Invalid prior coverage'; end if;
   for covered_kind in select jsonb_array_elements_text(concept->'covered_by') loop
    if covered_kind not in('note','deck','quiz') or not exists(select 1 from private.material_history where material_id=m.id and kind=covered_kind) then raise exception 'Prior coverage has no supporting saved content'; end if;
    insert into private.material_coverage values(m.id,covered_kind,concept->>'id') on conflict do nothing;
   end loop;
  end loop;
 end loop;
 update public.study_materials set title=left(coalesce(nullif(trim(p_output->>'title'),''),m.title),150),topics=p_output->'topics',source_text=p_output->>'source_text',source_format='markdown',analysis_status='ready',analysis_error=null where id=m.id;
 update public.document_files set status='ready',error_message=null where material_id=m.id;
end;
$$;
create function private.remaining_concepts(mid uuid,k text,tid text default null)
returns setof private.material_concepts language sql stable set search_path='' as $$
 select c.* from private.material_concepts c where c.material_id=mid and (tid is null or c.topic_id=tid) and not exists(select 1 from private.material_coverage h where h.material_id=mid and h.kind=k and h.concept_id=c.concept_id) order by c.topic_id,c.concept_id;
$$;
create or replace function public.material_generation_info(p_material_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.study_materials; topics jsonb; notes integer; cards integer; quizzes integer;
begin
 select * into m from public.study_materials where id=p_material_id and private.can_access_folder(folder_id);
 if m.id is null then raise exception 'This material is unavailable'; end if;
 select count(*) into notes from private.remaining_concepts(m.id,'note'); select count(*) into cards from private.remaining_concepts(m.id,'deck'); select count(*) into quizzes from private.remaining_concepts(m.id,'quiz');
 select coalesce(jsonb_agg((t-'concepts')||jsonb_build_object('available_cards',least((t->>'card_count')::integer,(select count(*) from private.remaining_concepts(m.id,'deck',t->>'id'))),
 'available_quiz',least((t->>'quiz_count')::integer,((select count(*) from private.remaining_concepts(m.id,'quiz',t->>'id'))/3)*3)) order by ord),'[]') into topics from jsonb_array_elements(m.topics) with ordinality q(t,ord);
 return jsonb_build_object('id',m.id,'title',m.title,'topics',topics,'status',m.analysis_status,'error',m.analysis_error,'remaining',jsonb_build_object('note',notes,'deck',cards,'quiz',quizzes),
 'exhausted',m.analysis_status='ready' and notes=0 and cards=0 and quizzes<3);
end;
$$;

create or replace function public.claim_material_generation(p_material_id uuid,p_user_id uuid,p_kind text,p_options jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials; topic jsonb; opts jsonb=p_options; total integer; tf integer; mc integer; ident integer; used integer; attempt integer; series uuid; next_set integer; job uuid; previous jsonb; available integer; concepts jsonb; ids jsonb;
begin
 select * into m from public.study_materials where id=p_material_id for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if m.analysis_status<>'ready' then raise exception 'Scan this material before generating a set'; end if;
 if p_kind is null or p_kind not in ('note','deck','quiz') then raise exception 'Invalid study set type'; end if;
 if jsonb_typeof(opts) is distinct from 'object' then raise exception 'Invalid generation options'; end if;
 if exists(select 1 from private.material_jobs where material_id=m.id and kind=p_kind and status='processing' and created_at>now()-interval '15 minutes') then raise exception 'A set of this type is already generating'; end if;
 if p_kind<>'note' then
   if opts->>'workflow'='topic' then
     select t into topic from jsonb_array_elements(m.topics) t where t->>'id'=opts->>'topic_id';
     if topic is null then raise exception 'Select one of the extracted topics'; end if;
     select count(*) into available from private.remaining_concepts(m.id,p_kind,topic->>'id');
     total:=least((topic->>case when p_kind='deck' then 'card_count' else 'quiz_count' end)::integer,available);
     if p_kind='quiz' then total:=(total/3)*3; end if;
     if total<1 then raise exception 'We''ve covered everything! Try a different topic or material.'; end if;
     tf:=total/3; mc:=total/3; ident:=total/3;
     opts:=jsonb_build_object('workflow','topic','topic_id',topic->>'id','topic_title',topic->>'title','total',total,'true_false',tf,'multiple_choice',mc,'short_answer',ident);
   elsif opts->>'workflow'='manual' then
     if coalesce(opts->>'total','') !~ '^[0-9]{1,2}$' then raise exception 'Choose 10, 15, 20, or 30 items'; end if;
     total:=(opts->>'total')::integer;
     if total not in (10,15,20,30) then raise exception 'Choose 10, 15, 20, or 30 items'; end if;
     if p_kind='quiz' then
       if coalesce(opts->>'true_false','') !~ '^[0-9]{1,2}$' or coalesce(opts->>'multiple_choice','') !~ '^[0-9]{1,2}$' or coalesce(opts->>'short_answer','') !~ '^[0-9]{1,2}$' then raise exception 'Enter a quantity for each question type'; end if;
       tf:=(opts->>'true_false')::integer; mc:=(opts->>'multiple_choice')::integer; ident:=(opts->>'short_answer')::integer;
       if tf+mc+ident<>total then raise exception 'Question-type quantities must add up to the selected total'; end if;
     end if;
     opts:=jsonb_build_object('workflow','manual','total',total,'true_false',tf,'multiple_choice',mc,'short_answer',ident);
   else raise exception 'Choose manual parameters or a topic'; end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.concept_id,'label',c.label,'topic_id',c.topic_id)),'[]'),coalesce(jsonb_agg(c.concept_id),'[]'),count(*) into concepts,ids,available from private.remaining_concepts(m.id,p_kind,case when opts->>'workflow'='topic' then opts->>'topic_id' else null end) c;
 if available=0 or (p_kind='quiz' and available<3) then raise exception 'We''ve covered everything! Try a different topic or material.'; end if;
 if p_kind<>'note' and total>available then raise exception 'Not enough uncovered concepts for that count. Choose fewer items or a topic'; end if;
 insert into private.seed_usage(user_id,usage_date,spent) values(p_user_id,private.seed_day(),1)
 on conflict(user_id,usage_date) do update set spent=private.seed_usage.spent+1 where private.seed_usage.spent<30 returning spent into used;
 if used is null then raise exception 'No Seeds left. Your 30 Seeds reset at midnight Philippine time'; end if;
 insert into private.material_attempts(material_id,kind,attempts) values(m.id,p_kind,1) on conflict(material_id,kind) do update set attempts=private.material_attempts.attempts+1 returning attempts into attempt;
 if p_kind='note' then opts:=jsonb_build_object('workflow','reviewer','angle','comprehensive'); end if;
 opts:=opts||jsonb_build_object('concept_ids',ids);
 select a.series_id into series from public.study_assets a where a.material_id=m.id and a.kind=p_kind order by a.created_at,a.id limit 1;
 series:=coalesce(series,gen_random_uuid());
 select coalesce(max(a.set_number),0)+1 into next_set from public.study_assets a where a.series_id=series;
 insert into private.material_jobs(material_id,document_id,user_id,kind,series_id,set_number,options) values(m.id,(select id from public.document_files where material_id=m.id order by expires_at desc limit 1),p_user_id,p_kind,series,next_set,opts) returning id into job;
 select coalesce(jsonb_agg(jsonb_build_object('prompt',h.prompt,'coverage_key',h.coverage_key)),'[]') into previous from private.material_history h where h.material_id=m.id and h.kind=p_kind;
 return jsonb_build_object('job_id',job,'kind',p_kind,'seeds_remaining',30-used,'concepts',concepts,'options',opts,'source_text',m.source_text,'source_format',m.source_format,'title',m.title,'previous',previous,'topics',m.topics,
 'source_document',(select to_jsonb(d) from public.document_files d where d.material_id=m.id order by d.expires_at desc limit 1));
end;
$$;


create or replace function public.complete_material_generation(p_job_id uuid,p_user_id uuid,p_output jsonb)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare j private.material_jobs; m public.study_materials; item jsonb; text_value text; question_signature text; coverage text; result public.study_assets; total integer; data_value jsonb; covered jsonb; cid text;
begin
 select * into j from private.material_jobs where id=p_job_id and user_id=p_user_id and status='processing' and created_at>now()-interval '15 minutes' for update;
 if j.id is null then raise exception 'Generation claim is missing or expired'; end if;
 select * into m from public.study_materials where id=j.material_id for update;
 if not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if j.kind='note' then
   text_value:=p_output->>'notes';
   if length(trim(coalesce(text_value,''))) not between 1 and 60000 then raise exception 'Reviewer is incomplete'; end if;
   insert into private.material_history(material_id,kind,signature,prompt,coverage_key) values(m.id,j.kind,private.prompt_signature(text_value),text_value,null);
   covered:=p_output->'covered_concepts';
   if jsonb_typeof(covered) is distinct from 'array' or jsonb_array_length(covered)<>jsonb_array_length(j.options->'concept_ids') or (select count(distinct value) from jsonb_array_elements_text(covered))<>jsonb_array_length(covered) then raise exception 'Reviewer coverage is incomplete'; end if;
   for cid in select jsonb_array_elements_text(covered) loop
    if not (j.options->'concept_ids') ? cid or exists(select 1 from private.material_coverage where material_id=m.id and kind=j.kind and concept_id=cid) then raise exception 'AI repeated a covered concept'; end if;
    insert into private.material_coverage values(m.id,j.kind,cid);
   end loop;
   data_value:='[]';
 else
   data_value:=p_output->case when j.kind='deck' then 'flashcards' else 'quiz' end; total:=(j.options->>'total')::integer;
   if jsonb_typeof(data_value) is distinct from 'array' or jsonb_array_length(data_value)<>total or octet_length(data_value::text)>120000 then raise exception 'Generated set does not match the requested item count'; end if;
   if j.kind='quiz' and ((select count(*) from jsonb_array_elements(data_value) q where q->>'type'='true_false')<>(j.options->>'true_false')::integer
     or (select count(*) from jsonb_array_elements(data_value) q where q->>'type'='multiple_choice')<>(j.options->>'multiple_choice')::integer
     or (select count(*) from jsonb_array_elements(data_value) q where q->>'type'='short_answer')<>(j.options->>'short_answer')::integer) then raise exception 'Generated quiz does not match the requested type distribution'; end if;
   for item in select jsonb_array_elements(data_value) loop
     text_value:=item->>case when j.kind='deck' then 'front' else 'question' end;
     coverage:=coalesce(item->>'concept_id','');
     if not (j.options->'concept_ids') ? coverage or exists(select 1 from private.material_coverage where material_id=m.id and kind=j.kind and concept_id=coverage) then raise exception 'AI repeated a covered concept or invented a new one'; end if;
     insert into private.material_coverage values(m.id,j.kind,coverage);
     if length(trim(coalesce(text_value,''))) not between 1 and 1500 or length(coverage) not between 3 and 200 then raise exception 'Generated question is incomplete'; end if;
     question_signature:=private.prompt_signature(text_value);
     if exists(select 1 from private.material_history h where h.material_id=m.id and h.kind=j.kind and (h.signature=question_signature or h.coverage_key=coverage)) then raise exception 'AI repeated an earlier question or learning objective. Existing sets are kept'; end if;
     insert into private.material_history(material_id,kind,signature,prompt,coverage_key) values(m.id,j.kind,question_signature,text_value,coverage);
   end loop;
 end if;
 insert into public.study_assets(folder_id,document_id,material_id,kind,title,content,data,created_by,series_id,set_number,generation_options)
 values(m.folder_id,j.document_id,m.id,j.kind,left(m.title||case when j.options->>'topic_title' is not null then ' · '|| (j.options->>'topic_title') else '' end||case when j.kind='deck' then ' · Flashcards' when j.kind='quiz' then ' · Practice' else '' end,150),
 case when j.kind='note' then p_output->>'notes' else '' end,data_value,p_user_id,j.series_id,j.set_number,j.options) returning * into result;
 update private.material_jobs set status='completed' where id=j.id;
 return result;
end;
$$;

create or replace function public.prune_maintenance_records()
returns jsonb language plpgsql security definer set search_path='' as $$
declare invitations integer; usage integer; events integer; jobs integer; guided_jobs integer; audits integer; seeds integer;
begin
  delete from public.folder_invitations where id in(select id from public.folder_invitations where expires_at<now()-interval '30 days' order by expires_at limit 1000); get diagnostics invitations=row_count;
  delete from private.ai_usage where(user_id,usage_date) in(select user_id,usage_date from private.ai_usage where usage_date<current_date-60 order by usage_date limit 1000); get diagnostics usage=row_count;
  delete from public.activity_events where id in(select id from public.activity_events where created_at<now()-interval '90 days' order by created_at limit 1000); get diagnostics events=row_count;
  delete from private.asset_refresh_jobs where id in(select id from private.asset_refresh_jobs where created_at<now()-interval '30 days' order by created_at limit 1000); get diagnostics jobs=row_count;
  delete from private.material_jobs where id in(select id from private.material_jobs where created_at<now()-interval '30 days' order by created_at limit 1000); get diagnostics guided_jobs=row_count;
  delete from private.maintenance_events where id in(select id from private.maintenance_events where created_at<now()-interval '180 days' order by created_at limit 1000); get diagnostics audits=row_count;
  delete from private.seed_usage where (user_id,usage_date) in(select user_id,usage_date from private.seed_usage where usage_date<private.seed_day()-60 order by usage_date limit 1000); get diagnostics seeds=row_count;
  return jsonb_build_object('expired_invitations',invitations,'old_usage',usage,'old_activity',events,'old_jobs',jobs,'old_generation_jobs',guided_jobs,'old_audits',audits,'old_seed_days',seeds);
end;
$$;

revoke all on function private.seed_day(),private.remaining_concepts(uuid,text,text) from public,anon,authenticated;
revoke all on function public.my_seed_balance(),public.update_custom_card(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.my_seed_balance(),public.update_custom_card(uuid,uuid,text,text,boolean) to authenticated;
create or replace function public.review_card(p_asset_id uuid,p_card_index integer,p_rating integer)
returns public.flashcard_progress language plpgsql security definer set search_path = '' as $$
declare a public.study_assets; result public.flashcard_progress; days integer; reps integer;
begin
  select * into a from public.study_assets where id=p_asset_id and kind='deck' for share;
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

notify pgrst,'reload schema';
commit;
