-- Synapse 2.0.1. Run once after 020, before deploying generate-study.
-- AI study tools share the existing 3-global / 2-per-user queue and recovery.
begin;
alter table private.generation_queue add column tool text check(tool in('highlights','connections'));
alter table private.generation_queue add column tool_input jsonb;
alter table private.generation_queue add column tool_hash text;
alter table private.generation_queue add column tool_output jsonb;
alter table private.generation_queue add constraint study_tool_request check(tool is null or (asset_id is not null and document_id is null and kind is not null and stage=kind and tool_hash is not null and jsonb_typeof(tool_input)='array' and octet_length(tool_input::text)<=160000));
create index generation_tool_pending on private.generation_queue(asset_id,tool,tool_hash,created_at desc) where tool is not null;
-- At most one retained result per reviewer/tool. Older queue receipts expire
-- through the existing 14-day technical-job cleanup, not study-set deletion.
create table private.study_tool_results (
 asset_id uuid not null references public.study_assets(id) on delete cascade,
 tool text not null check(tool in('highlights','connections')),
 input_hash text not null, output jsonb not null check(octet_length(output::text)<=150000),
 created_by uuid not null references public.profiles(id) on delete cascade,
 updated_at timestamptz not null default now(), primary key(asset_id,tool)
);
alter table private.study_tool_results enable row level security;
grant all on private.study_tool_results to service_role;

create function private.study_tool_highlights(p_tool text,p_highlights jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare h jsonb; result jsonb;
begin
 if p_tool is null or p_tool not in('highlights','connections') or p_highlights is null or jsonb_typeof(p_highlights)<>'array' then raise exception 'Invalid study tool request';end if;
 if p_tool='connections' then
  if jsonb_array_length(p_highlights)<>0 then raise exception 'Concept connections use the saved reviewer';end if;
  return '[]'::jsonb;
 end if;
 if jsonb_array_length(p_highlights) not between 1 and 20 then raise exception 'Choose 1 to 20 highlights';end if;
 for h in select value from jsonb_array_elements(p_highlights) loop
  if jsonb_typeof(h)<>'string' or length(trim(h#>>'{}')) not between 2 and 2000 then raise exception 'Each highlight must be 2 to 2,000 characters';end if;
 end loop;
 select jsonb_agg(text order by ord) into result from (
  select regexp_replace(trim(value#>>'{}'),'\s+',' ','g') text,min(ordinality) ord from jsonb_array_elements(p_highlights) with ordinality group by 1
 ) selected;
 return result;
end;$$;
create function private.study_tool_hash(p_asset_id uuid,p_tool text,p_highlights jsonb)
returns text language sql stable set search_path='' as $$
 select md5(jsonb_build_array('grounded-tools-v1',a.id,a.content_format,a.content,
   coalesce(m.source_format,'markdown'),coalesce(m.source_text,''),p_tool,p_highlights)::text)
 from public.study_assets a left join public.study_materials m on m.id=a.material_id where a.id=p_asset_id;
$$;
create function private.invalidate_study_tools()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.content is distinct from old.content or new.content_format is distinct from old.content_format or new.material_id is distinct from old.material_id then
  delete from private.study_tool_results where asset_id=new.id;
 end if;
 return new;
end;$$;
create trigger study_tool_cache_changed after update on public.study_assets for each row execute function private.invalidate_study_tools();

create function public.read_study_tool(p_asset_id uuid,p_tool text,p_highlights jsonb default '[]')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.study_assets; highlights jsonb; fingerprint text; output jsonb;
begin
 select * into a from public.study_assets where id=p_asset_id;
 if a.id is null or a.kind<>'note' or not private.can_access_folder(a.folder_id) or not private.account_available(auth.uid()) then raise exception 'Reviewer access required';end if;
 highlights:=private.study_tool_highlights(p_tool,p_highlights);
 fingerprint:=private.study_tool_hash(a.id,p_tool,highlights);
 select r.output into output from private.study_tool_results r where r.asset_id=a.id and r.tool=p_tool and r.input_hash=fingerprint;
 return jsonb_build_object('output',output);
end;$$;
create function public.enqueue_study_tool(p_user_id uuid,p_request_id uuid,p_asset_id uuid,p_tool text,p_highlights jsonb default '[]')
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
 if cached is not null then return jsonb_build_object('output',cached);end if;
 select * into q from private.generation_queue where user_id=p_user_id and request_id=p_request_id;
 if q.id is not null then
  if q.asset_id is distinct from p_asset_id or q.tool is distinct from p_tool or q.tool_hash is distinct from fingerprint then raise exception 'Use a new request ID for this source';end if;
  return jsonb_build_object('task',private.generation_snapshot(q),'output',case when q.status='completed' then q.tool_output end);
 end if;
 -- Serialize same-reviewer admission across editors so double opens share work.
 perform pg_advisory_xact_lock(hashtextextended(a.id::text||p_tool,0));
 select * into q from private.generation_queue where asset_id=a.id and tool=p_tool and tool_hash=fingerprint
 and (status in('queued','processing') or status='paused' and auto_resume_at is not null or status='completed' and tool_output is not null) order by created_at desc limit 1;
 if q.id is not null then return jsonb_build_object('task',private.generation_snapshot(q),'output',case when q.status='completed' then q.tool_output end);end if;
 if (select count(*) from private.generation_queue where user_id=p_user_id and (status in('queued','processing') or status='paused' and auto_resume_at is not null))>=3 then raise exception 'Your three materials are still being prepared. You can keep studying while they finish';end if;
 insert into private.generation_queue(request_id,user_id,folder_id,asset_id,material_id,kind,stage,tool,tool_input,tool_hash)
 values(p_request_id,p_user_id,a.folder_id,a.id,a.material_id,case when p_tool='highlights' then 'deck' else 'note' end,case when p_tool='highlights' then 'deck' else 'note' end,p_tool,highlights,fingerprint) returning * into q;
 return jsonb_build_object('task',private.generation_snapshot(q));
end;$$;
create function public.claim_study_tool(p_task_id uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; a public.study_assets; m public.study_materials; cached jsonb;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.tool is null then raise exception 'Invalid study tool task';end if;
 select * into a from public.study_assets where id=q.asset_id;
 if a.id is null or a.kind<>'note' then raise exception 'Reviewer access required';end if;
 if q.tool_hash is distinct from private.study_tool_hash(a.id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 select r.output into cached from private.study_tool_results r where r.asset_id=a.id and r.tool=q.tool and r.input_hash=q.tool_hash;
 if cached is not null then return jsonb_build_object('cached_output',cached);end if;
 select * into m from public.study_materials where id=a.material_id;
 return jsonb_build_object('tool',q.tool,'title',a.title,'content',a.content,'content_format',a.content_format,
 'source_text',coalesce(m.source_text,''),'source_format',coalesce(m.source_format,'markdown'),'highlights',q.tool_input);
end;$$;
create function public.complete_study_tool(p_task_id uuid,p_lease uuid,p_output jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.tool is null or p_output is null or jsonb_typeof(p_output)<>'object' or octet_length(p_output::text)>150000 then raise exception 'Invalid study tool output';end if;
 perform 1 from public.study_assets where id=q.asset_id for share;
 if q.tool_hash is distinct from private.study_tool_hash(q.asset_id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 if q.tool='highlights' and (jsonb_typeof(p_output->'cards') is distinct from 'array' or jsonb_array_length(p_output->'cards') not between 1 and 20)
 or q.tool='connections' and (jsonb_typeof(p_output->'nodes') is distinct from 'array' or jsonb_typeof(p_output->'edges') is distinct from 'array' or jsonb_array_length(p_output->'nodes') not between 2 and 32 or jsonb_array_length(p_output->'edges') not between 1 and 64) then raise exception 'Invalid study tool output';end if;
 insert into private.study_tool_results(asset_id,tool,input_hash,output,created_by) values(q.asset_id,q.tool,q.tool_hash,p_output,q.user_id)
 on conflict(asset_id,tool) do update set input_hash=excluded.input_hash,output=excluded.output,created_by=excluded.created_by,updated_at=now();
 update private.generation_queue set tool_output=p_output,status='completed',source_text=null,
 completed_kinds='{}',attempts=0,recovery_cycles=0,lease_token=null,lease_until=null,continuation_token=null,
 message=null,last_error=null,pause_reason=null,auto_resume_at=null,updated_at=now() where id=q.id;
 return p_output;
end;$$;
create function public.read_study_tool_task(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q private.generation_queue;
begin
 select * into q from private.generation_queue where id=p_task_id;
 if q.id is null or q.tool is null or not private.can_access_folder(q.folder_id) or not private.account_available(auth.uid()) then raise exception 'Reviewer access required';end if;
 if q.tool_hash is distinct from private.study_tool_hash(q.asset_id,q.tool,q.tool_input) then raise exception 'Reviewer changed. Save and reopen the study tool';end if;
 return jsonb_build_object('task',private.generation_snapshot(q),'output',case when q.status='completed' then q.tool_output end);
end;$$;
create or replace function private.generation_snapshot(q private.generation_queue)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',q.id,'title',coalesce((select name from public.document_files where id=q.document_id),(select title from public.study_assets where id=q.asset_id),'Study material'),'folder_id',q.folder_id,'document_id',q.document_id,'asset_id',q.asset_id,'tool',q.tool,'stream_chars',q.stream_chars,'stream_updated_at',q.stream_updated_at,'kind',q.kind,'stage',q.stage,'status',q.status,'completed_kinds',q.completed_kinds,'result_asset_id',q.result_asset_id,'message',q.message,'pause_reason',q.pause_reason,'auto_resume_at',q.auto_resume_at,'progress',case when q.status='completed' then 100 when q.kind is null then least(99,cardinality(q.completed_kinds)*100/3) else 0 end,'updated_at',q.updated_at);
$$;
create or replace function public.enqueue_generation(p_user_id uuid,p_request_id uuid,p_document_id uuid default null,p_asset_id uuid default null,p_text text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; d public.document_files; a public.study_assets; fid uuid; mid uuid; saved text[]; next_stage text;
begin
 if p_request_id is null or ((p_document_id is null)=(p_asset_id is null)) or length(coalesce(p_text,''))>100000 then raise exception 'Invalid generation request'; end if;
 if p_document_id is not null then
  select * into d from public.document_files where id=p_document_id; fid:=d.folder_id; mid:=d.material_id;
 else
  select * into a from public.study_assets where id=p_asset_id; fid:=a.folder_id; mid:=a.material_id;
  if a.is_custom then raise exception 'Custom flashcards are edited manually'; end if;
 end if;
 if fid is null or not private.generation_editor(fid,p_user_id) then raise exception 'Editor access required'; end if;
 -- Small admission transaction; no lock is held during an AI call.
 perform 1 from public.profiles where id=p_user_id for update;
 select * into q from private.generation_queue where user_id=p_user_id and request_id=p_request_id;
 if q.id is not null then if q.tool is not null then raise exception 'Use a new request ID for this source';end if;return private.generation_snapshot(q); end if;
 if p_document_id is not null then
  perform 1 from public.document_files where id=p_document_id for update;
  select * into q from private.generation_queue where document_id=p_document_id;
  if q.id is not null then
   if q.status='paused' and q.auto_resume_at is null then
    update private.generation_queue set status='queued',attempts=0,available_at=now(),message=null,last_error=null,pause_reason=null,auto_resume_at=null,recovery_cycles=0,source_text=coalesce(p_text,source_text),updated_at=now(),user_id=p_user_id where id=q.id returning * into q;
   end if;
   return private.generation_snapshot(q);
  end if;
 else
  select * into q from private.generation_queue where tool is null and user_id=p_user_id and (asset_id=p_asset_id or (material_id=mid and kind=a.kind)) and (status in('queued','processing') or status='paused' and auto_resume_at is not null) order by created_at limit 1;
  if q.id is not null then return private.generation_snapshot(q); end if;
 end if;
 if (select count(*) from private.generation_queue where user_id=p_user_id and (status in('queued','processing') or status='paused' and auto_resume_at is not null))>=3 then raise exception 'Your three materials are still being prepared. You can keep studying while they finish'; end if;
 insert into private.generation_queue(request_id,user_id,folder_id,document_id,asset_id,material_id,kind,source_text)
 values(p_request_id,p_user_id,fid,p_document_id,p_asset_id,mid,a.kind,p_text) returning * into q;
 -- Cached source goes directly to the requested/missing format; no preparation worker is reserved.
 if exists(select 1 from public.study_materials where id=mid and length(trim(source_text))>=20) then
  if p_document_id is null then next_stage:=a.kind;saved:='{}';
  else
   select coalesce(array_agg(k order by ord),'{}') into saved from unnest(array['note','deck','quiz']) with ordinality u(k,ord) where exists(select 1 from public.study_assets where material_id=mid and kind=k and not is_custom);
   select k into next_stage from unnest(array['note','deck','quiz']) with ordinality u(k,ord) where not k=any(saved) order by ord limit 1;
  end if;
  update private.generation_queue set stage=coalesce(next_stage,stage),status=case when next_stage is null then 'completed' else 'queued' end,completed_kinds=saved,source_text=null where id=q.id returning * into q;
 end if;
 if p_document_id is not null then update public.document_files set status=case when q.status='completed' then 'ready' else 'processing' end,processing_started_at=now(),error_message=null where id=p_document_id; end if;
 return private.generation_snapshot(q);
end;
$$;
create or replace function public.my_generation_tasks(p_folder_id uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
 with ids as (
  select id from private.generation_queue where tool is null and user_id=auth.uid() and (status<>'completed' or updated_at>now()-interval '1 day')
  union
  select id from private.generation_queue where tool is null and folder_id=p_folder_id and (status<>'completed' or updated_at>now()-interval '1 day')
 ), chosen as (
  select q.id,q.document_id,q.asset_id,q.folder_id,q.kind,q.stage,q.status,q.completed_kinds,q.result_asset_id,q.message,q.pause_reason,q.auto_resume_at,q.updated_at,q.created_at,q.stream_chars,q.stream_updated_at
  from ids join private.generation_queue q using(id)
  where private.generation_editor(q.folder_id,auth.uid())
  order by (q.user_id=auth.uid()) desc,(q.status in('queued','processing')) desc,q.created_at desc limit 50
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'title',coalesce(d.name,a.title,'Study material'),
 'folder_id',q.folder_id,'document_id',q.document_id,'asset_id',q.asset_id,'kind',q.kind,'stage',q.stage,'status',q.status,
 'completed_kinds',q.completed_kinds,'result_asset_id',q.result_asset_id,'message',q.message,'pause_reason',q.pause_reason,
 'auto_resume_at',q.auto_resume_at,'updated_at',q.updated_at,'stream_chars',q.stream_chars,'stream_updated_at',q.stream_updated_at,
 'progress',case when q.status='completed' then 100 when q.kind is null then least(99,cardinality(q.completed_kinds)*100/3) else 0 end)
 order by q.created_at desc),'[]')
 from chosen q left join public.document_files d on d.id=q.document_id left join public.study_assets a on a.id=q.asset_id;
$$;

create or replace function private.generation_pause_reason(p_error text)
returns text language sql immutable set search_path='' as $$
 select case
 when p_error ~* 'access required|Editor access|scheduled for deletion|permission denied|account.*unavailable' then 'access'
 when p_error ~* 'No fresh (study content|questions)|SOURCE_EXHAUSTED|covered everything' then 'exhausted'
 when p_error ~* 'Reviewer changed|selected highlight|saved reviewer|more readable content|cannot be read|not legible|not enough readable|Source text could not be read|original.*(expired|missing)|file.*(expired|missing)|Upload.*again|size.*match|100,000.*characters|blocked.*(safety|policy)' then 'source'
 when p_error ~* 'GEMINI_API_KEY|GEMINI_MODEL|credentials|function configuration|Gemini.*\((400|401|402|403|404)' then 'service'
 else 'temporary' end;
$$;

revoke all on function private.study_tool_highlights(text,jsonb),private.study_tool_hash(uuid,text,jsonb),private.invalidate_study_tools() from public,anon,authenticated;
revoke all on function public.read_study_tool(uuid,text,jsonb),public.read_study_tool_task(uuid) from public,anon;
grant execute on function public.read_study_tool(uuid,text,jsonb),public.read_study_tool_task(uuid) to authenticated;
revoke all on function public.enqueue_study_tool(uuid,uuid,uuid,text,jsonb),public.claim_study_tool(uuid,uuid),public.complete_study_tool(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_study_tool(uuid,uuid,uuid,text,jsonb),public.claim_study_tool(uuid,uuid),public.complete_study_tool(uuid,uuid,jsonb) to service_role;
commit;
