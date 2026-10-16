-- Synapse 2.1.0. Run once after 021; deploy the updated generate-study function.
begin;
alter table private.generation_queue add column tool_phase text not null default 'generating' check(tool_phase in('generating','checking'));
alter table private.generation_queue add column tool_draft jsonb check(tool_draft is null or jsonb_typeof(tool_draft)='object' and octet_length(tool_draft::text)<=150000);
alter table private.generation_queue add column tool_feedback jsonb check(tool_feedback is null or jsonb_typeof(tool_feedback)='array' and octet_length(tool_feedback::text)<=5000);
alter table private.generation_queue add column tool_revisions integer not null default 0 check(tool_revisions between 0 and 2);
alter table private.generation_runs add column tool_phase text;
create table private.highlight_card_saves (
 user_id uuid not null references public.profiles(id) on delete cascade,
 request_id uuid not null, signature text not null,
 deck_id uuid not null references public.study_assets(id) on delete cascade,
 created_at timestamptz not null default now(), primary key(user_id,request_id)
);
create index highlight_card_saves_age on private.highlight_card_saves(created_at);
alter table private.highlight_card_saves enable row level security;
grant all on private.highlight_card_saves to service_role;

-- A cache version identifies the complete generation AND verification contract.
create or replace function private.study_tool_hash(p_asset_id uuid,p_tool text,p_highlights jsonb)
returns text language sql stable set search_path='' as $$
 select md5(jsonb_build_array('grounded-tools-v2-checked',a.id,a.folder_id,a.content_format,a.content,
   coalesce(m.source_format,'markdown'),coalesce(m.source_text,''),p_tool,p_highlights)::text)
 from public.study_assets a left join public.study_materials m on m.id=a.material_id and m.folder_id=a.folder_id where a.id=p_asset_id;
$$;
-- Derived previews are rebuilt on their next opening. Saved study sets remain.
delete from private.study_tool_results;
update private.generation_queue set status='paused',pause_reason='source',auto_resume_at=null,
 message='Study tools updated. Reopen this reviewer to continue.',updated_at=now()
 where tool is not null and status in('queued','paused');

create or replace function public.claim_study_tool(p_task_id uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; a record; m record; cached jsonb;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.tool is null then raise exception 'Invalid study tool task';end if;
 select id,folder_id,kind,title,content,content_format,material_id into a from public.study_assets where id=q.asset_id;
 if a.id is null or a.kind<>'note' or a.folder_id<>q.folder_id or not private.generation_editor(a.folder_id,q.user_id) then raise exception 'Reviewer access required';end if;
 if q.tool_hash is distinct from private.study_tool_hash(a.id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 select r.output into cached from private.study_tool_results r where r.asset_id=a.id and r.tool=q.tool and r.input_hash=q.tool_hash and r.output#>>'{verification,version}'='2';
 if cached is not null then return jsonb_build_object('cached_output',cached);end if;
 select source_text,source_format into m from public.study_materials where id=a.material_id and folder_id=a.folder_id;
 return jsonb_build_object('tool',q.tool,'tool_phase',q.tool_phase,'draft',q.tool_draft,'feedback',q.tool_feedback,
 'title',a.title,'content',a.content,'content_format',a.content_format,
 'source_text',coalesce(m.source_text,''),'source_format',coalesce(m.source_format,'markdown'),'highlights',q.tool_input);
end;$$;

create function private.tool_item_ids(p_tool text,p_draft jsonb)
returns text[] language sql immutable set search_path='' as $$
 select case when p_tool='highlights' then array(select value->>'highlight_id' from jsonb_array_elements(p_draft->'cards'))
 else array(select 'node:'||(value->>'id') from jsonb_array_elements(p_draft->'nodes')) || array(select 'edge:'||ordinality::text from jsonb_array_elements(p_draft->'edges') with ordinality) end;
$$;
create function public.checkpoint_study_tool(p_task_id uuid,p_lease uuid,p_draft jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; ids text[];
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.tool is null or q.tool_phase<>'generating' or p_draft is null or jsonb_typeof(p_draft)<>'object' or octet_length(p_draft::text)>150000 then raise exception 'Invalid study tool draft';end if;
 if q.tool_hash is distinct from private.study_tool_hash(q.asset_id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 if q.tool='highlights' then
  if jsonb_typeof(p_draft->'cards') is distinct from 'array' or jsonb_array_length(p_draft->'cards')<>jsonb_array_length(q.tool_input) then raise exception 'Invalid highlight draft';end if;
 else
  if jsonb_typeof(p_draft->'nodes') is distinct from 'array' or jsonb_typeof(p_draft->'edges') is distinct from 'array' or jsonb_array_length(p_draft->'nodes') not between 2 and 32 or jsonb_array_length(p_draft->'edges') not between 1 and 64 then raise exception 'Invalid connection draft';end if;
 end if;
 ids:=private.tool_item_ids(q.tool,p_draft);
 if array_position(ids,null) is not null or cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Invalid study tool item IDs';end if;
 update private.generation_queue set tool_phase='checking',tool_draft=p_draft,tool_feedback=null,
 status='queued',continuation_token=lease_token,lease_token=null,lease_until=null,attempts=0,recovery_cycles=0,
 available_at=now(),message=null,last_error=null,pause_reason=null,auto_resume_at=null,updated_at=now() where id=q.id returning * into q;
 return private.generation_snapshot(q);
end;$$;
create function private.persist_checked_tool(p_task_id uuid,p_lease uuid,p_output jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare q private.generation_queue;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 perform 1 from public.study_assets where id=q.asset_id for share;
 if q.tool is null or q.tool_hash is distinct from private.study_tool_hash(q.asset_id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 insert into private.study_tool_results(asset_id,tool,input_hash,output,created_by) values(q.asset_id,q.tool,q.tool_hash,p_output,q.user_id)
 on conflict(asset_id,tool) do update set input_hash=excluded.input_hash,output=excluded.output,created_by=excluded.created_by,updated_at=now();
 update private.generation_queue set tool_output=p_output,tool_draft=null,tool_feedback=null,status='completed',source_text=null,
 completed_kinds='{}',attempts=0,recovery_cycles=0,continuation_token=lease_token,lease_token=null,lease_until=null,
 message=null,last_error=null,pause_reason=null,auto_resume_at=null,updated_at=now() where id=q.id;
 return p_output;
end;$$;
create function public.review_study_tool(p_task_id uuid,p_lease uuid,p_checks jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; ids text[]; item jsonb; seen text[]:='{}'; failures jsonb; output jsonb;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.tool is null or q.tool_phase<>'checking' or q.tool_draft is null or p_checks is null or jsonb_typeof(p_checks)<>'array' or octet_length(p_checks::text)>50000 then raise exception 'Invalid study tool verification';end if;
 if q.tool_hash is distinct from private.study_tool_hash(q.asset_id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 ids:=private.tool_item_ids(q.tool,q.tool_draft);
 if cardinality(ids)<>jsonb_array_length(p_checks) then raise exception 'Verify every study tool item';end if;
 for item in select value from jsonb_array_elements(p_checks) loop
  if item->>'id' is null or not (item->>'id')=any(ids) or (item->>'id')=any(seen)
   or jsonb_typeof(item->'supported') is distinct from 'boolean' or jsonb_typeof(item->'reason') is distinct from 'string'
   or length(item->>'reason')>300 or item->>'supported'='false' and length(trim(item->>'reason'))=0 then raise exception 'Invalid study tool verification item';end if;
  seen:=array_append(seen,item->>'id');
 end loop;
 select coalesce(jsonb_agg(value),'[]') into failures from (select value from jsonb_array_elements(p_checks) where value->>'supported'='false' limit 8) failed;
 if jsonb_array_length(failures)>0 then
  if q.tool_revisions>=2 then
   update private.generation_queue set status='paused',pause_reason='source',auto_resume_at=null,
    tool_draft=null,tool_feedback=null,continuation_token=null,lease_token=null,lease_until=null,
    message='We could not verify this content from its source. Choose a passage with more context or improve the reviewer.',updated_at=now() where id=q.id;
   return jsonb_build_object('needs_context',true);
  end if;
  update private.generation_queue set tool_phase='generating',tool_draft=null,tool_feedback=failures,tool_revisions=tool_revisions+1,
   status='queued',continuation_token=lease_token,lease_token=null,lease_until=null,attempts=0,recovery_cycles=0,
   available_at=now(),message=null,last_error=null,pause_reason=null,auto_resume_at=null,updated_at=now() where id=q.id;
  return jsonb_build_object('revising',true);
 end if;
 output:=q.tool_draft||jsonb_build_object('verification',jsonb_build_object('version',2,'checked_items',cardinality(ids)));
 return private.persist_checked_tool(q.id,p_lease,output);
end;$$;
-- This legacy endpoint now only copies a previously checked cached result.
-- Fresh drafts must pass review_study_tool, including after worker recovery.
create or replace function public.complete_study_tool(p_task_id uuid,p_lease uuid,p_output jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if p_output is null or p_output#>>'{verification,version}' is distinct from '2' or not (
  exists(select 1 from private.study_tool_results r where r.asset_id=q.asset_id and r.tool=q.tool and r.input_hash=q.tool_hash and r.output=p_output)
  or exists(select 1 from private.generation_queue other where other.asset_id=q.asset_id and other.tool=q.tool and other.tool_hash=q.tool_hash and other.status='completed' and other.tool_output=p_output)
 ) then raise exception 'Study tool requires source verification';end if;
 return private.persist_checked_tool(q.id,p_lease,p_output);
end;$$;

-- A retry with the same key returns the same deck without another append.
create function public.save_highlight_cards_v2(p_request_id uuid,p_source_id uuid,p_title text,p_cards jsonb,p_deck_id uuid default null,p_highlights jsonb default '[]',p_fingerprint text default null)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); signature text; receipt private.highlight_card_saves; deck public.study_assets; source public.study_assets; highlights jsonb;
begin
 if p_request_id is null or not private.account_available(uid) then raise exception 'Sign in to save flashcards';end if;
 signature:=md5(jsonb_build_array(p_source_id,p_title,p_cards,p_deck_id,p_highlights,p_fingerprint)::text);
 perform 1 from public.profiles where id=uid for update;
 select * into receipt from private.highlight_card_saves where user_id=uid and request_id=p_request_id;
 if receipt.request_id is not null then
  if receipt.signature<>signature then raise exception 'Use a new save request ID for changed cards';end if;
  select * into deck from public.study_assets where id=receipt.deck_id;
  if deck.id is null or not private.can_access_folder(deck.folder_id,true) then raise exception 'Deck access required';end if;
  return deck;
 end if;
 select * into source from public.study_assets where id=p_source_id and kind='note' for share;
 if source.id is null or not private.can_access_folder(source.folder_id,true) then raise exception 'Editor access required';end if;
 highlights:=private.study_tool_highlights('highlights',p_highlights);
 if p_fingerprint is null or p_fingerprint is distinct from private.study_tool_hash(source.id,'highlights',highlights) then raise exception 'Reviewer changed. Generate these highlights again before saving';end if;
 if not (exists(select 1 from private.study_tool_results r where r.asset_id=source.id and r.tool='highlights' and r.input_hash=p_fingerprint and r.output#>>'{verification,version}'='2')
 or exists(select 1 from private.generation_queue q where q.asset_id=source.id and q.tool='highlights' and q.tool_hash=p_fingerprint and q.status='completed' and q.tool_output#>>'{verification,version}'='2')) then raise exception 'Generate and check these highlights before saving';end if;
 deck:=public.save_highlight_cards(source.id,p_title,p_cards,p_deck_id);
 insert into private.highlight_card_saves(user_id,request_id,signature,deck_id) values(uid,p_request_id,signature,deck.id);
 return deck;
end;$$;

create or replace function private.generation_snapshot(q private.generation_queue)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',q.id,'title',coalesce((select name from public.document_files where id=q.document_id),(select title from public.study_assets where id=q.asset_id),'Study material'),'folder_id',q.folder_id,'document_id',q.document_id,'asset_id',q.asset_id,'tool',q.tool,'tool_phase',q.tool_phase,'stream_chars',q.stream_chars,'stream_updated_at',q.stream_updated_at,'kind',q.kind,'stage',q.stage,'status',q.status,'completed_kinds',q.completed_kinds,'result_asset_id',q.result_asset_id,'message',q.message,'pause_reason',q.pause_reason,'auto_resume_at',q.auto_resume_at,'progress',case when q.status='completed' then 100 when q.kind is null then least(99,cardinality(q.completed_kinds)*100/3) else 0 end,'updated_at',q.updated_at);
$$;

create or replace function public.read_study_tool(p_asset_id uuid,p_tool text,p_highlights jsonb default '[]')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.study_assets; highlights jsonb; fingerprint text; output jsonb;
begin
 select * into a from public.study_assets where id=p_asset_id;
 if a.id is null or a.kind<>'note' or not private.can_access_folder(a.folder_id) or not private.account_available(auth.uid()) then raise exception 'Reviewer access required';end if;
 highlights:=private.study_tool_highlights(p_tool,p_highlights);
 fingerprint:=private.study_tool_hash(a.id,p_tool,highlights);
 select r.output into output from private.study_tool_results r where r.asset_id=a.id and r.tool=p_tool and r.input_hash=fingerprint;
 return jsonb_build_object('output',output,'fingerprint',fingerprint);
end;$$;

create or replace function public.read_study_tool_task(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q private.generation_queue;
begin
 select * into q from private.generation_queue where id=p_task_id;
 if q.id is null or q.tool is null or not private.can_access_folder(q.folder_id) or not private.account_available(auth.uid()) then raise exception 'Reviewer access required';end if;
 if q.tool_hash is distinct from private.study_tool_hash(q.asset_id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 return jsonb_build_object('fingerprint',q.tool_hash,'task',private.generation_snapshot(q),'output',case when q.status='completed' then q.tool_output end);
end;$$;

create or replace function public.enqueue_study_tool(p_user_id uuid,p_request_id uuid,p_asset_id uuid,p_tool text,p_highlights jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.study_assets; q private.generation_queue; highlights jsonb; fingerprint text; cached jsonb;
begin
 select * into a from public.study_assets where id=p_asset_id;
 if a.id is null or a.kind<>'note' or not private.generation_editor(a.folder_id,p_user_id) then raise exception 'Editor access required';end if;
 if p_request_id is null then raise exception 'A request ID is required';end if;
 highlights:=private.study_tool_highlights(p_tool,p_highlights);
 -- Same short user admission lock as ordinary generation; no network work here.
 perform 1 from public.profiles where id=p_user_id for update;
 select * into a from public.study_assets where id=p_asset_id for share;
 if a.id is null or a.kind<>'note' or not private.generation_editor(a.folder_id,p_user_id) then raise exception 'Editor access required';end if;
 fingerprint:=private.study_tool_hash(a.id,p_tool,highlights);
 select r.output into cached from private.study_tool_results r where r.asset_id=a.id and r.tool=p_tool and r.input_hash=fingerprint;
 if cached is not null then return jsonb_build_object('output',cached,'fingerprint',fingerprint);end if;
 select * into q from private.generation_queue where user_id=p_user_id and request_id=p_request_id;
 if q.id is not null then
  if q.asset_id is distinct from p_asset_id or q.tool is distinct from p_tool or q.tool_hash is distinct from fingerprint then raise exception 'Use a new request ID for this source';end if;
  return jsonb_build_object('fingerprint',q.tool_hash,'task',private.generation_snapshot(q),'output',case when q.status='completed' then q.tool_output end);
 end if;
 -- Serialize same-reviewer admission across editors so double opens share work.
 perform pg_advisory_xact_lock(hashtextextended(a.id::text||p_tool,0));
 select * into q from private.generation_queue where asset_id=a.id and tool=p_tool and tool_hash=fingerprint
 and (status in('queued','processing') or status='paused' and auto_resume_at is not null or status='completed' and tool_output is not null) order by created_at desc limit 1;
 if q.id is not null then return jsonb_build_object('fingerprint',q.tool_hash,'task',private.generation_snapshot(q),'output',case when q.status='completed' then q.tool_output end);end if;
 if (select count(*) from private.generation_queue where user_id=p_user_id and (status in('queued','processing') or status='paused' and auto_resume_at is not null))>=3 then raise exception 'Your three materials are still being prepared. You can keep studying while they finish';end if;
 insert into private.generation_queue(request_id,user_id,folder_id,asset_id,material_id,kind,stage,tool,tool_input,tool_hash)
 values(p_request_id,p_user_id,a.folder_id,a.id,a.material_id,case when p_tool='highlights' then 'deck' else 'note' end,case when p_tool='highlights' then 'deck' else 'note' end,p_tool,highlights,fingerprint) returning * into q;
 return jsonb_build_object('fingerprint',q.tool_hash,'task',private.generation_snapshot(q));
end;$$;

create or replace function private.track_generation_run()
returns trigger language plpgsql set search_path='' as $$
declare stamp timestamptz:=clock_timestamp();
begin
 if tg_op='UPDATE' and old.status='processing' and (new.status<>'processing' or new.lease_token is distinct from old.lease_token) then
  update private.generation_runs set ended_at=stamp,outcome=case when new.continuation_token=old.lease_token then 'saved' when new.last_error='Worker lease expired' then 'abandoned' else 'deferred' end
  where lease_token=old.lease_token and outcome='running';
 end if;
 if new.status='processing' and new.lease_token is not null and (tg_op='INSERT' or old.status<>'processing' or new.lease_token is distinct from old.lease_token) then
  insert into private.generation_runs(lease_token,task_id,stage,tool_phase,attempt,is_retry,reserved_at,queue_wait_ms)
  values(new.lease_token,new.id,new.stage,case when new.tool is not null then new.tool_phase end,new.attempts,exists(select 1 from private.generation_runs where task_id=new.id and stage=new.stage and tool_phase is not distinct from case when new.tool is not null then new.tool_phase end),stamp,greatest(0,floor(extract(epoch from(stamp-new.waiting_since))*1000)))
  on conflict(lease_token) do nothing;
 end if;
 if new.status='processing' and new.worker_started then
  update private.generation_runs set started_at=stamp,dispatch_wait_ms=greatest(0,floor(extract(epoch from(stamp-reserved_at))*1000)) where lease_token=new.lease_token and started_at is null;
 end if;
 return new;
end;
$$;

create or replace function private.prune_selected_records(p_categories text[])
returns jsonb language plpgsql set search_path='' as $$
declare n integer; extra integer; result jsonb:='{}';
begin
 if p_categories is null or cardinality(p_categories)=0 or not p_categories <@ array['invitations','activity','jobs','usage','audits','duplicate_text','timings'] then raise exception 'Choose supported cleanup categories'; end if;
 if 'invitations'=any(p_categories) then
  delete from public.folder_invitations where id in(select id from public.folder_invitations where expires_at<now()-interval '30 days' order by expires_at limit 1000);get diagnostics n=row_count;result:=result||jsonb_build_object('invitations',n);
 end if;
 if 'activity'=any(p_categories) then
  delete from public.activity_events where id in(select id from public.activity_events where created_at<now()-interval '90 days' order by created_at limit 1000);get diagnostics n=row_count;result:=result||jsonb_build_object('activity',n);
 end if;
 if 'jobs'=any(p_categories) then
  delete from private.material_jobs where id in(select j.id from private.material_jobs j where status<>'processing' and created_at<now()-interval '30 days' and not exists(select 1 from private.generation_queue q where q.material_job_id=j.id) order by created_at limit 1000);get diagnostics n=row_count;
  delete from private.asset_refresh_jobs where id in(select id from private.asset_refresh_jobs where status<>'processing' and created_at<now()-interval '30 days' order by created_at limit 1000);get diagnostics extra=row_count;n:=n+extra;
  delete from private.generation_queue where id in(select id from private.generation_queue where (status='completed' and updated_at<now()-interval '14 days') or (status='paused' and updated_at<now()-interval '30 days') order by updated_at limit 1000);get diagnostics extra=row_count;n:=n+extra;
  delete from private.highlight_card_saves where (user_id,request_id) in(select user_id,request_id from private.highlight_card_saves where created_at<now()-interval '30 days' order by created_at limit 1000);get diagnostics extra=row_count;result:=result||jsonb_build_object('jobs',n+extra);
 end if;
 if 'usage'=any(p_categories) then
  delete from private.ai_usage where (user_id,usage_date) in(select user_id,usage_date from private.ai_usage where usage_date<current_date-60 order by usage_date limit 1000);get diagnostics n=row_count;
  delete from private.seed_usage where (user_id,usage_date) in(select user_id,usage_date from private.seed_usage where usage_date<current_date-60 order by usage_date limit 1000);get diagnostics extra=row_count;result:=result||jsonb_build_object('usage',n+extra);
 end if;
 if 'audits'=any(p_categories) then
  delete from private.maintenance_events where id in(select id from private.maintenance_events where created_at<now()-interval '180 days' order by created_at limit 1000);get diagnostics n=row_count;result:=result||jsonb_build_object('audits',n);
 end if;
 if 'duplicate_text'=any(p_categories) then
  -- Clear an old duplicate ONLY when the retained source is an exact match.
  update public.document_files set extracted_text=null where id in(select d.id from public.document_files d join public.study_materials m on m.id=d.material_id where d.extracted_text=m.source_text and length(m.source_text)>=20 and d.purged_at is not null order by d.created_at limit 1000);get diagnostics n=row_count;result:=result||jsonb_build_object('duplicate_text',n);
 end if;
 if 'timings'=any(p_categories) then
  delete from private.generation_runs where lease_token in(select lease_token from private.generation_runs where reserved_at<now()-interval '14 days' and outcome<>'running' order by reserved_at limit 1000);get diagnostics n=row_count;result:=result||jsonb_build_object('timings',n);
 end if;
 return result;
end;
$$;

create or replace function public.admin_cleanup_preview()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_app_admin();
 return jsonb_build_object(
 'invitations',(select count(*) from (select 1 from public.folder_invitations where expires_at<now()-interval '30 days' limit 1001) s),
 'activity',(select count(*) from (select 1 from public.activity_events where created_at<now()-interval '90 days' limit 1001) s),
 'jobs',(select count(*) from (select 1 from private.material_jobs j where status<>'processing' and created_at<now()-interval '30 days' and not exists(select 1 from private.generation_queue q where q.material_job_id=j.id) union all select 1 from private.asset_refresh_jobs where status<>'processing' and created_at<now()-interval '30 days' union all select 1 from private.generation_queue where (status='completed' and updated_at<now()-interval '14 days') or (status='paused' and updated_at<now()-interval '30 days') union all select 1 from private.highlight_card_saves where created_at<now()-interval '30 days' limit 1001) s),
 'usage',(select count(*) from (select 1 from private.ai_usage where usage_date<current_date-60 union all select 1 from private.seed_usage where usage_date<current_date-60 limit 1001) s),
 'audits',(select count(*) from (select 1 from private.maintenance_events where created_at<now()-interval '180 days' limit 1001) s),
 'duplicate_text',(select count(*) from (select 1 from public.document_files d join public.study_materials m on m.id=d.material_id where d.purged_at is not null and d.extracted_text=m.source_text and length(m.source_text)>=20 limit 1001) s),
 'timings',(select count(*) from (select 1 from private.generation_runs where reserved_at<now()-interval '14 days' and outcome<>'running' limit 1001) s),
 'queue',jsonb_build_object('waiting',(select count(*) from private.generation_queue where status='queued'),'running',(select count(*) from private.generation_queue where status='processing'),'paused',(select count(*) from private.generation_queue where status='paused'),'scheduler_ready',(select scheduler_ready from private.generation_capacity where id),'parallel',(select max_parallel from private.generation_capacity where id),'per_user',(select max_per_user from private.generation_capacity where id)),
 'paused_tasks',(select coalesce(jsonb_agg(t),'[]') from(select q.id,q.stage,q.message,q.last_error,q.updated_at,q.auto_resume_at,q.pause_reason,coalesce(d.name,a.title,'Study material') as title from private.generation_queue q left join public.document_files d on d.id=q.document_id left join public.study_assets a on a.id=q.asset_id where q.status='paused' order by q.updated_at desc limit 10)t));
end;
$$;

create or replace function public.admin_generation_performance()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_app_admin();
 -- Index-backed, bounded samples keep the free-plan dashboard inexpensive.
 with sample as (select g.*,case when q.tool is not null then q.tool||'_'||coalesce(g.tool_phase,'generating') else g.stage end measured_stage from private.generation_runs g join private.generation_queue q on q.id=g.task_id where g.reserved_at>now()-interval '7 days' order by g.reserved_at desc limit 2000),
 intakes as (select distinct q.id,q.client_read_ms,q.client_upload_ms from sample g join private.generation_queue q on q.id=g.task_id where q.client_read_ms is not null),
 stages as (select measured_stage stage,count(*)::integer deliveries,count(*) filter(where reported_at is not null)::integer measured,
 round(avg(queue_wait_ms)) queue_wait_ms,round(avg(dispatch_wait_ms)) dispatch_wait_ms,
 round(avg(source_read_ms) filter(where not source_cached)) source_read_ms,
 round(avg(gemini_ms) filter(where gemini_calls>0)) gemini_ms,
 round(avg(save_ms)) save_ms,
 count(*) filter(where outcome='saved')::integer saved,
 coalesce(sum(draft_retries),0)::integer draft_retries,coalesce(sum(provider_retries),0)::integer provider_retries,
 count(*) filter(where is_retry)::integer worker_retries from sample group by measured_stage)
 select jsonb_build_object('checked_at',now(),'window_days',7,'sample_limit',2000,
 'capacity',(select jsonb_build_object('overall',max_parallel,'per_user',max_per_user) from private.generation_capacity where id),
 'intake',(select jsonb_build_object('uploads',count(*),'read_ms',round(avg(client_read_ms)),'upload_ms',round(avg(client_upload_ms))) from intakes),
 'streaming',(select jsonb_build_object('first_token_ms',round(avg(first_token_ms)),'chunks',coalesce(sum(stream_chunks),0),'saved_workers',count(*) filter(where outcome='saved' and ended_at is not null),'worker_p50_ms',round((percentile_cont(0.5) within group(order by extract(epoch from(ended_at-started_at))*1000) filter(where outcome='saved' and started_at is not null and ended_at is not null))::numeric),'worker_p95_ms',round((percentile_cont(0.95) within group(order by extract(epoch from(ended_at-started_at))*1000) filter(where outcome='saved' and started_at is not null and ended_at is not null))::numeric)) from sample),
 'totals',(select jsonb_build_object('deliveries',count(*),'measured',count(*) filter(where reported_at is not null),'queue_wait_ms',round(avg(queue_wait_ms)),'dispatch_wait_ms',round(avg(dispatch_wait_ms)),
 'source_read_ms',round(avg(source_read_ms) filter(where not source_cached)),'gemini_ms',round(avg(gemini_ms) filter(where gemini_calls>0)),
 'draft_retries',coalesce(sum(draft_retries),0),'provider_retries',coalesce(sum(provider_retries),0),'worker_retries',count(*) filter(where is_retry),'abandoned',count(*) filter(where outcome='abandoned'),
 'input_tokens',coalesce(sum(input_tokens),0),'output_tokens',coalesce(sum(output_tokens),0),'thought_tokens',coalesce(sum(thought_tokens),0),'source_cached',count(*) filter(where source_cached),'source_checks',count(*) filter(where reported_at is not null)) from sample),
 'stages',(select coalesce(jsonb_agg(to_jsonb(s) order by array_position(array['prepare','note','deck','quiz'],s.stage)),'[]') from stages s),
 'recent',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reserved_at desc),'[]') from (
 select coalesce(d.name,a.title,'Study material') title,g.measured_stage stage,g.outcome,g.reserved_at,g.queue_wait_ms,g.dispatch_wait_ms,g.source_read_ms,g.gemini_ms,g.save_ms,g.gemini_calls,g.draft_retries,g.provider_retries,case when g.is_retry then 1 else 0 end worker_retries,g.reported_at,
 case when g.started_at is not null and g.ended_at is not null then greatest(0,round(extract(epoch from(g.ended_at-g.started_at))*1000)) else null end worker_ms
 from sample g join private.generation_queue q on q.id=g.task_id left join public.document_files d on d.id=q.document_id left join public.study_assets a on a.id=q.asset_id order by g.reserved_at desc limit 12) r)) into result;
 return result;
end;
$$;


-- Treat an unbound reviewer as a source too, so a map/card check cannot race
-- a source-binding regeneration merely because material_id is still null.
create function private.generation_source_available(p_user uuid,p_material uuid,p_asset uuid,p_document uuid,p_limit integer)
returns boolean language sql stable set search_path='' as $$
 select (select count(*) from private.generation_queue where status='processing' and user_id=p_user)<p_limit
 and not exists(select 1 from private.generation_queue running where running.status='processing'
 and (running.material_id=p_material or running.asset_id=p_asset or running.document_id=p_document));
$$;

create or replace function public.claim_generation_task()
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; stale private.generation_queue; capacity private.generation_capacity;
begin
 select * into capacity from private.generation_capacity where id for update;
 -- A worker lease outlives the 130-second request budget. Recover killed workers.
 for stale in select * from private.generation_queue where status='processing' and lease_until<now() order by lease_until limit 20 for update skip locked loop
  perform public.defer_generation_task(stale.id,stale.lease_token,'Worker lease expired',case when stale.attempts>=5 then null else 5 end,'Continuing your study materials…',false);

 end loop;
 -- Resume due recoverable pauses without an admin action, within a finite recovery budget.
 for stale in select * from private.generation_queue where status='paused' and auto_resume_at<=now() order by auto_resume_at limit 20 for update skip locked loop
  if private.generation_editor(stale.folder_id,stale.user_id) and stale.created_at>now()-interval '24 hours' then
   update private.generation_queue set status='queued',attempts=0,recovery_cycles=recovery_cycles+1,available_at=now(),pause_reason=null,auto_resume_at=null,message='Continuing your study materials…',updated_at=now() where id=stale.id;
  else update private.generation_queue set auto_resume_at=null,pause_reason=case when not private.generation_editor(stale.folder_id,stale.user_id) then 'access' else pause_reason end,message='Preparation stopped. Check access or upload the source again.',updated_at=now() where id=stale.id;end if;
 end loop;
 if capacity.cooldown_until>now() or (select count(*) from private.generation_queue where status='processing')>=capacity.max_parallel then return null; end if;
 select * into q from private.generation_queue t where t.status='queued' and t.available_at<=now()
 and private.generation_source_available(t.user_id,t.material_id,t.asset_id,t.document_id,capacity.max_per_user)
 -- Give waiting users a first slot before awarding another user's second slot.
 order by (select count(*) from private.generation_queue running where running.status='processing' and running.user_id=t.user_id),t.available_at,t.created_at,t.id for update skip locked limit 1;
 if q.id is null then return null; end if;
 if not private.generation_editor(q.folder_id,q.user_id) then
  update private.generation_queue set status='paused',pause_reason='access',auto_resume_at=null,message='Generation stopped because editor access is no longer available.',updated_at=now() where id=q.id; return null;
 end if;
 update private.generation_queue set status='processing',continuation_token=null,worker_started=false,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',message=null,updated_at=now() where id=q.id returning * into q;
 return to_jsonb(q);
end;
$$;

create or replace function public.continue_generation_task(p_task_id uuid,p_previous_lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; capacity private.generation_capacity; next_id uuid;
begin
 select * into capacity from private.generation_capacity where id for update;
 if capacity.cooldown_until>now() or (select count(*) from private.generation_queue where status='processing')>=capacity.max_parallel then return null;end if;
 select * into q from private.generation_queue where id=p_task_id and status='queued' and continuation_token=p_previous_lease and available_at<=now() for update;
 if q.id is null or not private.generation_editor(q.folder_id,q.user_id) then return null;end if;
 -- A warm worker uses exactly the scheduler's eligibility and fairness rules.
 select t.id into next_id from private.generation_queue t where t.status='queued' and t.available_at<=now()
 and private.generation_source_available(t.user_id,t.material_id,t.asset_id,t.document_id,capacity.max_per_user)
 order by (select count(*) from private.generation_queue running where running.status='processing' and running.user_id=t.user_id),t.available_at,t.created_at,t.id limit 1;
 if next_id is distinct from q.id then return null;end if;
 update private.generation_queue set status='processing',worker_started=true,continuation_token=null,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',message=null,updated_at=now() where id=q.id returning * into q;
 return to_jsonb(q);
end;
$$;

revoke all on function private.generation_source_available(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function private.tool_item_ids(text,jsonb),private.persist_checked_tool(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.checkpoint_study_tool(uuid,uuid,jsonb),public.review_study_tool(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.checkpoint_study_tool(uuid,uuid,jsonb),public.review_study_tool(uuid,uuid,jsonb) to service_role;
revoke all on function public.save_highlight_cards_v2(uuid,uuid,text,jsonb,uuid,jsonb,text) from public,anon;
grant execute on function public.save_highlight_cards_v2(uuid,uuid,text,jsonb,uuid,jsonb,text) to authenticated;
commit;
