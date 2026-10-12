-- Synapse 1.7. Run once after 009. Existing sets, custom decks and progress remain.
begin;
create function public.claim_auto_source(p_material_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials;
begin
 select * into m from public.study_materials where id=p_material_id for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if length(trim(m.source_text))>=20 then
  update public.study_materials set analysis_status='ready',analysis_error=null,analysis_token=null where id=m.id returning * into m;
  return jsonb_build_object('cached',true,'material',to_jsonb(m));
 end if;
 if m.analysis_status='scanning' and m.analysis_started_at>now()-interval '15 minutes' then raise exception 'This material is already being prepared'; end if;
 update public.study_materials set analysis_status='scanning',analysis_token=gen_random_uuid(),analysis_started_at=now(),analysis_error=null where id=m.id returning * into m;
 return jsonb_build_object('cached',false,'token',m.analysis_token,'material',to_jsonb(m));
end;
$$;
create function public.retain_auto_source(p_material_id uuid,p_user_id uuid,p_text text,p_token uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials;
begin
 select * into m from public.study_materials where id=p_material_id for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if p_token is not null and (m.analysis_token is distinct from p_token or m.analysis_status<>'scanning') then raise exception 'Source preparation expired. Try again'; end if;
 if length(trim(coalesce(p_text,''))) not between 20 and 100000 then raise exception 'Source text is incomplete. Upload a readable chapter'; end if;
 if length(trim(m.source_text))<20 then
  update public.study_materials set source_text=p_text,source_format='markdown',analysis_status='ready',analysis_error=null,analysis_token=null where id=m.id returning * into m;
 end if;
 return to_jsonb(m);
end;
$$;
create function public.claim_auto_generation(p_material_id uuid,p_user_id uuid,p_kind text,p_initial boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.study_materials; existing public.study_assets; series uuid; next_set integer; job uuid; history jsonb; opts jsonb; variant text;
begin
 select * into m from public.study_materials where id=p_material_id for update;
 if m.id is null or not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if p_kind is null or p_kind not in('note','deck','quiz') then raise exception 'Invalid study set type'; end if;
 if length(trim(m.source_text))<20 then raise exception 'Prepare this source before generating study materials'; end if;
 if p_initial then
  select * into existing from public.study_assets where material_id=m.id and kind=p_kind and not is_custom order by created_at desc,id limit 1;
  if existing.id is not null then
   update public.document_files set status=case when (select count(distinct kind) from public.study_assets where material_id=m.id and not is_custom)=3 then 'ready' else 'processing' end,error_message=null where material_id=m.id;
   return jsonb_build_object('existing_asset_id',existing.id,'material_id',m.id);
  end if;
 end if;
 perform 1 from public.profiles where id=p_user_id for update;
 if exists(select 1 from private.material_jobs where (material_id=m.id or user_id=p_user_id) and status='processing' and created_at>now()-interval '15 minutes') then raise exception 'Study material is already generating. Wait for it to finish'; end if;
 select a.series_id into series from public.study_assets a where a.material_id=m.id and a.kind=p_kind and not a.is_custom order by a.created_at,a.id limit 1;
 series:=coalesce(series,gen_random_uuid());
 select coalesce(max(a.set_number),0)+1 into next_set from public.study_assets a where a.series_id=series;
 variant:=(array['comprehensive','worked examples and applications','concept connections and comparisons','misconceptions and qualifications','recall and applied reasoning'])[((next_set-1)%5)+1];
 opts:=jsonb_build_object('automatic',true,'variant',variant);
 insert into private.material_jobs(material_id,document_id,user_id,kind,series_id,set_number,options)
 values(m.id,(select id from public.document_files where material_id=m.id order by expires_at desc limit 1),p_user_id,p_kind,series,next_set,opts) returning id into job;
 select coalesce(jsonb_agg(jsonb_build_object('prompt',h.prompt,'coverage_key',h.coverage_key)),'[]') into history from private.material_history h where h.material_id=m.id and h.kind=p_kind;
 return jsonb_build_object('job_id',job,'kind',p_kind,'options',opts,'source_text',m.source_text,'source_format',m.source_format,'title',m.title,'previous',history,'source_document',(select to_jsonb(d) from public.document_files d where material_id=m.id order by expires_at desc limit 1));
end;
$$;
create function public.complete_auto_generation(p_job_id uuid,p_user_id uuid,p_output jsonb)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare j private.material_jobs; m public.study_materials; item jsonb; text_value text; coverage text; sig text; data_value jsonb; result public.study_assets;
begin
 select * into j from private.material_jobs where id=p_job_id and user_id=p_user_id and status='processing' and options->>'automatic'='true' and created_at>now()-interval '15 minutes' for update;
 if j.id is null then raise exception 'Generation claim is missing or expired'; end if;
 select * into m from public.study_materials where id=j.material_id for update;
 if not private.generation_editor(m.folder_id,p_user_id) then raise exception 'Editor access required'; end if;
 if j.kind='note' then
  text_value:=p_output->>'notes';
  if length(trim(coalesce(text_value,''))) not between 1 and 60000 then raise exception 'Reviewer is incomplete'; end if;
  sig:=private.prompt_signature(text_value);
  if exists(select 1 from private.material_history where material_id=m.id and kind=j.kind and signature=sig) then raise exception 'AI repeated an earlier reviewer. Existing sets are kept'; end if;
  insert into private.material_history(material_id,kind,signature,prompt,coverage_key) values(m.id,j.kind,sig,text_value,null);
  data_value:='[]';
 else
  data_value:=p_output->case when j.kind='deck' then 'flashcards' else 'quiz' end;
  if jsonb_typeof(data_value) is distinct from 'array' or jsonb_array_length(data_value)<3 or jsonb_array_length(data_value)>(case when j.kind='deck' then 50 else 30 end) or octet_length(data_value::text)>120000 then raise exception 'Generated study set is incomplete'; end if;
  for item in select jsonb_array_elements(data_value) loop
   text_value:=item->>case when j.kind='deck' then 'front' else 'question' end;coverage:=lower(trim(coalesce(item->>'coverage_key','')));sig:=private.prompt_signature(text_value);
   if length(trim(coalesce(text_value,''))) not between 1 and (case when j.kind='deck' then 1000 else 1500 end) or length(coverage) not between 3 and 200 then raise exception 'Generated question is incomplete'; end if;
   if j.kind='deck' and length(trim(coalesce(item->>'back',''))) not between 1 and 2000 then raise exception 'Flashcard answer is incomplete'; end if;
   if j.kind='quiz' and (coalesce(item->>'type','') not in('true_false','multiple_choice','short_answer') or length(trim(coalesce(item->>'answer',''))) not between 1 and 1000 or length(trim(coalesce(item->>'explanation',''))) not between 1 and 2000 or jsonb_typeof(item->'options') is distinct from 'array' or jsonb_typeof(item->'accepted_answers') is distinct from 'array') then raise exception 'Quiz question is invalid'; end if;
   if j.kind='quiz' and item->>'type'='multiple_choice' and (jsonb_array_length(item->'options')<>4 or not (item->'options') ? (item->>'answer')) then raise exception 'Multiple Choice answer is invalid'; end if;
   if j.kind='quiz' and item->>'type'='true_false' and (item->'options'<> '["True","False"]'::jsonb or item->>'answer' not in('True','False')) then raise exception 'True/False answer is invalid'; end if;
   if j.kind='quiz' and item->>'type'='short_answer' and jsonb_array_length(item->'options')<>0 then raise exception 'Identification must not have choices'; end if;
   if exists(select 1 from private.material_history h where h.material_id=m.id and h.kind=j.kind and (h.signature=sig or h.coverage_key=coverage)) then raise exception 'AI repeated an earlier question or learning objective. Existing sets are kept'; end if;
   insert into private.material_history(material_id,kind,signature,prompt,coverage_key) values(m.id,j.kind,sig,text_value,coverage);
  end loop;
 end if;
 insert into public.study_assets(folder_id,document_id,material_id,kind,title,content,data,created_by,series_id,set_number,generation_options)
 values(m.folder_id,j.document_id,m.id,j.kind,left(m.title||case when j.kind='note' then ' · Reviewer' when j.kind='deck' then ' · Flashcards' else ' · Practice quiz' end,150),case when j.kind='note' then p_output->>'notes' else '' end,data_value,p_user_id,j.series_id,j.set_number,j.options) returning * into result;
 update private.material_jobs set status='completed' where id=j.id;
 update public.document_files set status=case when (select count(distinct kind) from public.study_assets where material_id=m.id and not is_custom)=3 then 'ready' else 'processing' end,error_message=null,processing_started_at=now() where material_id=m.id;
 return result;
end;
$$;
revoke all on function public.claim_auto_source(uuid,uuid),public.retain_auto_source(uuid,uuid,text,uuid),public.claim_auto_generation(uuid,uuid,text,boolean),public.complete_auto_generation(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_auto_source(uuid,uuid),public.retain_auto_source(uuid,uuid,text,uuid),public.claim_auto_generation(uuid,uuid,text,boolean),public.complete_auto_generation(uuid,uuid,jsonb) to service_role;
-- Disable the retired currency entry point. Its history is retained for safe rollback/maintenance.
revoke execute on function public.my_seed_balance() from authenticated;
commit;
