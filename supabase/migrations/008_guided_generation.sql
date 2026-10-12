-- Synapse 1.5. Run ONCE after 006 and the 007 admin repair.
begin;
alter table public.document_files drop constraint document_files_size_bytes_check;
alter table public.document_files add constraint document_files_size_bytes_check check(size_bytes between 1 and 20971520);
update storage.buckets set file_size_limit=20971520 where id='study-files';

create table public.study_materials (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  title text not null check(char_length(title) between 1 and 150),
  source_hash text check(source_hash ~ '^[0-9a-f]{64}$'),
  source_text text not null default '' check(char_length(source_text)<=100000),
  source_format text not null default 'markdown' check(source_format in ('markdown','html')),
  topics jsonb not null default '[]' check(jsonb_typeof(topics)='array' and jsonb_array_length(topics)<=24),
  analysis_status text not null default 'unscanned' check(analysis_status in ('unscanned','scanning','ready','failed')),
  analysis_attempts integer not null default 0,
  analysis_token uuid,
  analysis_started_at timestamptz,
  analysis_error text,
  created_at timestamptz not null default now(),
  unique(id,folder_id)
);
create unique index materials_source_hash on public.study_materials(folder_id,source_hash) where source_hash is not null;
alter table public.study_materials enable row level security;
create policy materials_read on public.study_materials for select to authenticated using(private.can_access_folder(folder_id));
grant select(id,folder_id,title,topics,analysis_status,analysis_error,created_at) on public.study_materials to authenticated;
grant all on public.study_materials to service_role;
alter table public.document_files add column material_id uuid references public.study_materials(id) on delete set null;
alter table public.study_assets add column material_id uuid references public.study_materials(id) on delete cascade;
alter table public.study_assets add column generation_options jsonb not null default '{}';
create index documents_material on public.document_files(material_id);
create index assets_material_kind on public.study_assets(material_id,kind,set_number);

insert into public.study_materials(id,folder_id,created_by,title,source_text)
 select id,folder_id,uploaded_by,left(name,150),coalesce(extracted_text,'') from public.document_files;
update public.document_files set material_id=id;
update public.study_assets set material_id=document_id where document_id is not null;

create table private.material_attempts (
  material_id uuid not null references public.study_materials(id) on delete cascade,
  kind text not null check(kind in ('note','deck','quiz')),
  attempts integer not null default 0 check(attempts>=0),
  primary key(material_id,kind)
);
create table private.material_jobs (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.study_materials(id) on delete cascade,
  document_id uuid references public.document_files(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check(kind in ('note','deck','quiz')),
  series_id uuid not null,
  set_number integer not null,
  options jsonb not null,
  status text not null default 'processing' check(status in ('processing','completed','failed')),
  last_error text,
  created_at timestamptz not null default now()
);
create index material_jobs_processing on private.material_jobs(material_id,kind,created_at) where status='processing';
create table private.material_history (
  material_id uuid not null references public.study_materials(id) on delete cascade,
  kind text not null,
  signature text not null,
  prompt text not null,
  coverage_key text,
  primary key(material_id,kind,signature)
);
create unique index material_coverage_unique on private.material_history(material_id,kind,coverage_key) where coverage_key is not null;
alter table private.material_attempts enable row level security;
alter table private.material_jobs enable row level security;
alter table private.material_history enable row level security;
grant all on private.material_attempts,private.material_jobs,private.material_history to service_role;
insert into private.material_attempts(material_id,kind,attempts)
 select material_id,kind,count(*) from public.study_assets where material_id is not null group by material_id,kind;
-- Include earlier failed/in-flight refresh requests where their source still exists.
insert into private.material_attempts(material_id,kind,attempts)
 select a.material_id,a.kind,count(*) from private.asset_refresh_jobs j join public.study_assets a on a.id=j.asset_id
 where a.material_id is not null and j.status<>'completed' group by a.material_id,a.kind
 on conflict(material_id,kind) do update set attempts=private.material_attempts.attempts+excluded.attempts;

create function private.generation_editor(fid uuid,uid uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select private.account_available(uid) and exists(select 1 from public.folders f where f.id=fid and private.account_available(f.owner_id)
 and (f.owner_id=uid or exists(select 1 from public.folder_members m where m.folder_id=fid and m.user_id=uid and m.role='editor')));
$$;
create function private.prompt_signature(value text)
returns text language sql immutable set search_path='' as $$
 select md5(trim(regexp_replace(lower(normalize(coalesce(value,''),NFKC)),'[^[:alnum:]]+',' ','g')));
$$;
insert into private.material_history(material_id,kind,signature,prompt)
 select material_id,kind,private.prompt_signature(content),content from public.study_assets where material_id is not null and kind='note' and length(trim(content))>0
 on conflict do nothing;
insert into private.material_history(material_id,kind,signature,prompt)
 select a.material_id,a.kind,private.prompt_signature(coalesce(q->>'front',q->>'question')),coalesce(q->>'front',q->>'question')
 from public.study_assets a cross join lateral jsonb_array_elements(a.data) q where a.material_id is not null and a.kind in ('deck','quiz')
 and coalesce(q->>'front',q->>'question') is not null on conflict do nothing;

create function public.generation_source(p_document_id uuid,p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d public.document_files; m public.study_materials;
begin
 select * into d from public.document_files where id=p_document_id;
 if d.id is null or not private.generation_editor(d.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 select * into m from public.study_materials where id=d.material_id;
 return jsonb_build_object('document',to_jsonb(d),'material',case when m.id is null then null else to_jsonb(m) end);
end;
$$;
-- Hash is computed from actual Storage bytes by the Edge Function, never trusted
-- from a browser. Re-uploading the same bytes in a space preserves attempt limits.
create function public.bind_generation_source(p_document_id uuid,p_user_id uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.document_files; m public.study_materials; existing public.study_materials;
begin
 select * into d from public.document_files where id=p_document_id for update;
 if d.id is null or not private.generation_editor(d.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if p_hash !~ '^[0-9a-f]{64}$' or p_hash is null then raise exception 'Invalid source fingerprint'; end if;
 perform pg_advisory_xact_lock(hashtextextended(d.folder_id::text||p_hash,0));
 select * into existing from public.study_materials where folder_id=d.folder_id and source_hash=p_hash for update;
 select * into m from public.study_materials where id=d.material_id for update;
 if existing.id is not null then
   if m.id is not null and m.id<>existing.id then
     if exists(select 1 from private.material_jobs where material_id in(m.id,existing.id) and status='processing' and created_at>now()-interval '15 minutes') then raise exception 'This material is already generating a set. Try the upload again after it finishes'; end if;
     -- Old unhashed material histories are merged rather than resetting quotas.
     insert into private.material_attempts select existing.id,kind,attempts from private.material_attempts where material_id=m.id
       on conflict(material_id,kind) do update set attempts=private.material_attempts.attempts+excluded.attempts;
     insert into private.material_history(material_id,kind,signature,prompt,coverage_key)
       select existing.id,kind,signature,prompt,null from private.material_history where material_id=m.id on conflict do nothing;
     update public.study_assets set material_id=existing.id where material_id=m.id;
     update public.document_files set material_id=existing.id where material_id=m.id;
     delete from public.study_materials where id=m.id;
   end if;
   m:=existing;
 elsif m.id is not null then
   update public.study_materials set source_hash=p_hash where id=m.id returning * into m;
 else
   insert into public.study_materials(folder_id,created_by,title,source_hash) values(d.folder_id,d.uploaded_by,left(d.name,150),p_hash) returning * into m;
 end if;
 update public.document_files set material_id=m.id where id=d.id;
 return to_jsonb(m);
end;
$$;
create function public.bind_note_source(p_asset_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.study_assets; m public.study_materials;
begin
 select * into a from public.study_assets where id=p_asset_id for update;
 if a.id is null or a.kind<>'note' or not private.generation_editor(a.folder_id,p_user_id) then raise exception 'Upload a source material first'; end if;
 select * into m from public.study_materials where id=a.material_id;
 if m.id is null then
   insert into public.study_materials(folder_id,created_by,title,source_text,source_format) values(a.folder_id,a.created_by,a.title,a.content,a.content_format) returning * into m;
   update public.study_assets set material_id=m.id where id=a.id;
 end if;
 return to_jsonb(m);
end;
$$;
create function public.claim_material_analysis(p_material_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials; used integer;
begin
 select * into m from public.study_materials where id=p_material_id for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if m.analysis_status='ready' then return jsonb_build_object('cached',true,'material',to_jsonb(m)); end if;
 if m.analysis_status='scanning' and m.analysis_started_at>now()-interval '15 minutes' then raise exception 'This material is already being scanned'; end if;
 if m.analysis_attempts>=3 then raise exception 'Topic analysis limit reached. Contact the app owner if the source cannot be read'; end if;
 insert into private.ai_usage(user_id,usage_date,requests) values(p_user_id,current_date,1) on conflict(user_id,usage_date) do update set requests=private.ai_usage.requests+1 returning requests into used;
 if used>20 then raise exception 'Daily limit reached (20 AI requests per user)'; end if;
 update public.study_materials set analysis_status='scanning',analysis_attempts=analysis_attempts+1,analysis_started_at=now(),analysis_token=gen_random_uuid(),analysis_error=null where id=m.id returning * into m;
 return jsonb_build_object('cached',false,'token',m.analysis_token,'material',to_jsonb(m));
end;
$$;
create function public.finish_material_analysis(p_material_id uuid,p_user_id uuid,p_token uuid,p_output jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare m public.study_materials; topic jsonb; i integer=0;
begin
 select * into m from public.study_materials where id=p_material_id and analysis_token=p_token and analysis_status='scanning' and analysis_started_at>now()-interval '15 minutes' for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Topic analysis claim expired'; end if;
 if jsonb_typeof(p_output->'topics') is distinct from 'array' or jsonb_array_length(p_output->'topics') not between 1 and 24
 or length(trim(coalesce(p_output->>'source_text',''))) not between 20 and 100000 then raise exception 'Source analysis is incomplete'; end if;
 for topic in select jsonb_array_elements(p_output->'topics') loop
   i:=i+1;
   if topic->>'id' is distinct from ('topic-'||i) or length(trim(coalesce(topic->>'title',''))) not between 1 and 100
   or coalesce(topic->>'card_count','') !~ '^[0-9]{1,2}$' or coalesce(topic->>'quiz_count','') !~ '^[0-9]{1,2}$'
   or (topic->>'card_count')::integer not between 3 and 30 or (topic->>'quiz_count')::integer not between 3 and 30 or (topic->>'quiz_count')::integer%3<>0 then raise exception 'Topic estimates are invalid'; end if;
 end loop;
 update public.study_materials set title=left(coalesce(nullif(trim(p_output->>'title'),''),m.title),150),topics=p_output->'topics',source_text=p_output->>'source_text',source_format='markdown',analysis_status='ready',analysis_error=null where id=m.id;
 update public.document_files set status='ready',error_message=null where material_id=m.id;
end;
$$;
create function public.fail_material_analysis(p_material_id uuid,p_token uuid,p_error text)
returns void language sql security definer set search_path='' as $$
 update public.study_materials set analysis_status='failed',analysis_error=left(p_error,300) where id=p_material_id and analysis_token=p_token and analysis_status='scanning';
$$;
create function public.material_generation_info(p_material_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.study_materials;
begin
 select * into m from public.study_materials where id=p_material_id and private.can_access_folder(folder_id);
 if m.id is null then raise exception 'This material is unavailable'; end if;
 return jsonb_build_object('id',m.id,'title',m.title,'topics',m.topics,'status',m.analysis_status,'error',m.analysis_error,
 'usage',jsonb_build_object('note',coalesce((select attempts from private.material_attempts where material_id=m.id and kind='note'),0),
 'deck',coalesce((select attempts from private.material_attempts where material_id=m.id and kind='deck'),0),'quiz',coalesce((select attempts from private.material_attempts where material_id=m.id and kind='quiz'),0)));
end;
$$;
create function public.claim_material_generation(p_material_id uuid,p_user_id uuid,p_kind text,p_options jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials; topic jsonb; opts jsonb=p_options; total integer; tf integer; mc integer; ident integer; used integer; attempt integer; series uuid; next_set integer; job uuid; previous jsonb;
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
     total:=(topic->>case when p_kind='deck' then 'card_count' else 'quiz_count' end)::integer;
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
 insert into private.material_attempts(material_id,kind) values(m.id,p_kind) on conflict do nothing;
 update private.material_attempts set attempts=attempts+1 where material_id=m.id and kind=p_kind and attempts<case when p_kind='deck' then 10 else 5 end returning attempts into attempt;
 if attempt is null then raise exception 'Generation limit reached for this material (% attempts)',case when p_kind='deck' then 10 else 5 end; end if;
 insert into private.ai_usage(user_id,usage_date,requests) values(p_user_id,current_date,1) on conflict(user_id,usage_date) do update set requests=private.ai_usage.requests+1 returning requests into used;
 if used>20 then raise exception 'Daily limit reached (20 AI requests per user)'; end if;
 if p_kind='note' then opts:=jsonb_build_object('workflow','reviewer','angle',(array['comprehensive','worked_examples','concept_connections','misconceptions','recall_and_application'])[least(attempt,5)]); end if;
 select a.series_id into series from public.study_assets a where a.material_id=m.id and a.kind=p_kind order by a.created_at,a.id limit 1;
 series:=coalesce(series,gen_random_uuid());
 select coalesce(max(a.set_number),0)+1 into next_set from public.study_assets a where a.series_id=series;
 insert into private.material_jobs(material_id,document_id,user_id,kind,series_id,set_number,options) values(m.id,(select id from public.document_files where material_id=m.id order by expires_at desc limit 1),p_user_id,p_kind,series,next_set,opts) returning id into job;
 select coalesce(jsonb_agg(jsonb_build_object('prompt',h.prompt,'coverage_key',h.coverage_key)),'[]') into previous from private.material_history h where h.material_id=m.id and h.kind=p_kind;
 return jsonb_build_object('job_id',job,'kind',p_kind,'attempt',attempt,'options',opts,'source_text',m.source_text,'source_format',m.source_format,'title',m.title,'previous',previous,'topics',m.topics,
 'source_document',(select to_jsonb(d) from public.document_files d where d.material_id=m.id order by d.expires_at desc limit 1));
end;
$$;

-- Scheduled cleanup drops temporary job records, never the persistent per-source
-- attempt counters/history that keep limits valid after set deletion.
create or replace function public.prune_maintenance_records()
returns jsonb language plpgsql security definer set search_path='' as $$
declare invitations integer; usage integer; events integer; jobs integer; guided_jobs integer; audits integer;
begin
  delete from public.folder_invitations where id in(select id from public.folder_invitations where expires_at<now()-interval '30 days' order by expires_at limit 1000); get diagnostics invitations=row_count;
  delete from private.ai_usage where(user_id,usage_date) in(select user_id,usage_date from private.ai_usage where usage_date<current_date-60 order by usage_date limit 1000); get diagnostics usage=row_count;
  delete from public.activity_events where id in(select id from public.activity_events where created_at<now()-interval '90 days' order by created_at limit 1000); get diagnostics events=row_count;
  delete from private.asset_refresh_jobs where id in(select id from private.asset_refresh_jobs where created_at<now()-interval '30 days' order by created_at limit 1000); get diagnostics jobs=row_count;
  delete from private.material_jobs where id in(select id from private.material_jobs where created_at<now()-interval '30 days' order by created_at limit 1000); get diagnostics guided_jobs=row_count;
  delete from private.maintenance_events where id in(select id from private.maintenance_events where created_at<now()-interval '180 days' order by created_at limit 1000); get diagnostics audits=row_count;
  return jsonb_build_object('expired_invitations',invitations,'old_usage',usage,'old_activity',events,'old_jobs',jobs,'old_generation_jobs',guided_jobs,'old_audits',audits);
end;
$$;
create function public.complete_material_generation(p_job_id uuid,p_user_id uuid,p_output jsonb)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare j private.material_jobs; m public.study_materials; item jsonb; text_value text; question_signature text; coverage text; result public.study_assets; total integer; data_value jsonb;
begin
 select * into j from private.material_jobs where id=p_job_id and user_id=p_user_id and status='processing' and created_at>now()-interval '15 minutes' for update;
 if j.id is null then raise exception 'Generation claim is missing or expired'; end if;
 select * into m from public.study_materials where id=j.material_id for update;
 if not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if j.kind='note' then
   text_value:=p_output->>'notes';
   if length(trim(coalesce(text_value,''))) not between 1 and 60000 then raise exception 'Reviewer is incomplete'; end if;
   insert into private.material_history(material_id,kind,signature,prompt,coverage_key) values(m.id,j.kind,private.prompt_signature(text_value),text_value,j.options->>'angle');
   data_value:='[]';
 else
   data_value:=p_output->case when j.kind='deck' then 'flashcards' else 'quiz' end; total:=(j.options->>'total')::integer;
   if jsonb_typeof(data_value) is distinct from 'array' or jsonb_array_length(data_value)<>total or octet_length(data_value::text)>120000 then raise exception 'Generated set does not match the requested item count'; end if;
   if j.kind='quiz' and ((select count(*) from jsonb_array_elements(data_value) q where q->>'type'='true_false')<>(j.options->>'true_false')::integer
     or (select count(*) from jsonb_array_elements(data_value) q where q->>'type'='multiple_choice')<>(j.options->>'multiple_choice')::integer
     or (select count(*) from jsonb_array_elements(data_value) q where q->>'type'='short_answer')<>(j.options->>'short_answer')::integer) then raise exception 'Generated quiz does not match the requested type distribution'; end if;
   for item in select jsonb_array_elements(data_value) loop
     text_value:=item->>case when j.kind='deck' then 'front' else 'question' end;
     coverage:=lower(trim(coalesce(item->>'coverage_key','')));
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
create function public.fail_material_generation(p_job_id uuid,p_user_id uuid,p_error text)
returns void language sql security definer set search_path='' as $$
 update private.material_jobs set status='failed',last_error=left(p_error,300) where id=p_job_id and user_id=p_user_id and status='processing';
$$;
create function public.create_manual_deck(p_folder_id uuid,p_title text,p_cards jsonb)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare item jsonb; result public.study_assets;
begin
 if not private.can_access_folder(p_folder_id,true) then raise exception 'Editor access required'; end if;
 if length(trim(coalesce(p_title,''))) not between 1 and 150 or jsonb_typeof(p_cards) is distinct from 'array' or jsonb_array_length(p_cards) not between 1 and 100 or octet_length(p_cards::text)>120000 then raise exception 'Enter a title and 1 to 100 custom flashcards'; end if;
 for item in select jsonb_array_elements(p_cards) loop
   if length(trim(coalesce(item->>'front',''))) not between 1 and 1000 or length(trim(coalesce(item->>'back',''))) not between 1 and 2000 then raise exception 'Each card needs a question and answer'; end if;
 end loop;
 insert into public.study_assets(folder_id,kind,title,data,created_by) values(p_folder_id,'deck',trim(p_title),p_cards,auth.uid()) returning * into result;
 return result;
end;
$$;

revoke all on function public.generation_source(uuid,uuid),public.bind_generation_source(uuid,uuid,text),public.bind_note_source(uuid,uuid),public.claim_material_analysis(uuid,uuid),public.finish_material_analysis(uuid,uuid,uuid,jsonb),public.fail_material_analysis(uuid,uuid,text),public.claim_material_generation(uuid,uuid,text,jsonb),public.complete_material_generation(uuid,uuid,jsonb),public.fail_material_generation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.generation_source(uuid,uuid),public.bind_generation_source(uuid,uuid,text),public.bind_note_source(uuid,uuid),public.claim_material_analysis(uuid,uuid),public.finish_material_analysis(uuid,uuid,uuid,jsonb),public.fail_material_analysis(uuid,uuid,text),public.claim_material_generation(uuid,uuid,text,jsonb),public.complete_material_generation(uuid,uuid,jsonb),public.fail_material_generation(uuid,uuid,text) to service_role;
revoke all on function private.generation_editor(uuid,uuid),private.prompt_signature(text) from public,anon,authenticated;
revoke all on function public.material_generation_info(uuid),public.create_manual_deck(uuid,text,jsonb) from public,anon;
grant execute on function public.material_generation_info(uuid),public.create_manual_deck(uuid,text,jsonb) to authenticated;
-- Older deployed function versions must not bypass the new counters.
revoke execute on function public.claim_generation(uuid,uuid),public.complete_generation(uuid,uuid,jsonb),public.claim_asset_refresh(uuid,uuid),public.complete_asset_refresh(uuid,uuid,jsonb) from service_role;
notify pgrst,'reload schema';
commit;
