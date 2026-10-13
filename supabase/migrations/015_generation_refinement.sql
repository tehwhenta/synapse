-- Synapse 1.8.1. Run once after 012 and 014; preserves existing materials and progress.
begin;
alter table private.generation_queue add column pause_reason text check(pause_reason in('temporary','service','source','access','exhausted'));
alter table private.generation_queue add column auto_resume_at timestamptz;
alter table private.generation_queue add column recovery_cycles integer not null default 0;
alter table private.generation_queue add column continuation_token uuid;
create index generation_queue_recovery on private.generation_queue(auto_resume_at) where status='paused' and auto_resume_at is not null;
create function private.generation_pause_reason(p_error text)
returns text language sql immutable set search_path='' as $$
 select case
 when p_error ~* 'Editor access|scheduled for deletion|permission denied|account.*unavailable' then 'access'
 when p_error ~* 'No fresh (study content|questions)|SOURCE_EXHAUSTED|covered everything' then 'exhausted'
 when p_error ~* 'cannot be read|not legible|not enough readable|Source text could not be read|original.*(expired|missing)|file.*(expired|missing)|Upload.*again|size.*match|100,000.*characters|blocked.*(safety|policy)' then 'source'
 when p_error ~* 'GEMINI_API_KEY|GEMINI_MODEL|credentials|function configuration|Gemini.*\((400|401|402|403|404)' then 'service'
 else 'temporary' end;
$$;
create or replace function private.generation_snapshot(q private.generation_queue)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',q.id,'title',coalesce((select name from public.document_files where id=q.document_id),(select title from public.study_assets where id=q.asset_id),'Study material'),'folder_id',q.folder_id,'document_id',q.document_id,'asset_id',q.asset_id,'kind',q.kind,'stage',q.stage,'status',q.status,'completed_kinds',q.completed_kinds,'result_asset_id',q.result_asset_id,'message',q.message,'pause_reason',q.pause_reason,'auto_resume_at',q.auto_resume_at,'progress',case when q.status='completed' then 100 when q.kind is null then least(99,cardinality(q.completed_kinds)*100/3) else 0 end,'updated_at',q.updated_at);
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
 if q.id is not null then return private.generation_snapshot(q); end if;
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
  select * into q from private.generation_queue where user_id=p_user_id and (asset_id=p_asset_id or (material_id=mid and kind=a.kind)) and (status in('queued','processing') or status='paused' and auto_resume_at is not null) order by created_at limit 1;
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

create or replace function private.advance_generation_task(p_id uuid,p_asset_id uuid default null)
returns void language plpgsql set search_path='' as $$
declare q private.generation_queue; next_stage text; saved text[];
begin
 select * into q from private.generation_queue where id=p_id;
 if q.document_id is not null then
  select coalesce(array_agg(k order by ord),'{}') into saved from unnest(array['note','deck','quiz']) with ordinality u(k,ord) where exists(select 1 from public.study_assets where material_id=q.material_id and kind=k and not is_custom);
  select k into next_stage from unnest(array['note','deck','quiz']) with ordinality u(k,ord) where not k=any(saved) order by ord limit 1;
 else
  saved:=case when q.stage='prepare' then '{}'::text[] else array[q.stage] end;
  next_stage:=case when q.stage='prepare' then q.kind else null end;
 end if;

 update private.generation_queue set status=case when next_stage is null then 'completed' else 'queued' end,
 stage=coalesce(next_stage,stage),completed_kinds=saved,
 result_asset_id=coalesce(p_asset_id,result_asset_id),source_text=null,attempts=0,recovery_cycles=0,available_at=now(),continuation_token=lease_token,lease_token=null,lease_until=null,material_job_id=null,analysis_token=null,message=null,last_error=null,pause_reason=null,auto_resume_at=null,updated_at=now() where id=q.id;
end;
$$;

create or replace function public.defer_generation_task(p_task_id uuid,p_lease uuid,p_error text,p_retry_seconds integer,p_message text,p_provider_busy boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; reason text; resume_at timestamptz;
begin
 perform 1 from private.generation_capacity where id for update;
 select * into q from private.generation_queue where id=p_task_id and lease_token=p_lease and status='processing' for update;
 if q.id is null then return; end if; -- Includes an already committed, lost response.
 update private.material_jobs set status='failed',last_error=left(p_error,500) where id=q.material_job_id and status='processing';
 update public.study_materials set analysis_status='failed',analysis_token=null,analysis_error=left(p_error,500) where id=q.material_id and analysis_token=q.analysis_token;
 reason:=private.generation_pause_reason(p_error);
 if p_retry_seconds is null and reason in('temporary','service') and q.created_at>now()-interval '24 hours' and q.recovery_cycles<(case when reason='service' then 24 else 3 end) then
  resume_at:=now()+case when reason='service' then interval '15 minutes' else interval '2 minutes' end;
 end if;
 update private.generation_queue set status=case when p_retry_seconds is null then 'paused' else 'queued' end,
 available_at=now()+make_interval(secs=>greatest(5,least(3600,coalesce(p_retry_seconds,60)))),lease_token=null,lease_until=null,material_job_id=null,analysis_token=null,continuation_token=null,
 last_error=left(p_error,500),pause_reason=case when p_retry_seconds is null then reason else null end,auto_resume_at=resume_at,
 message=case when resume_at is not null then case when reason='service' then 'The AI service needs attention. Your materials will continue automatically once it is available.' else 'Taking a short pause. Your materials will continue automatically.' end when p_retry_seconds is null and reason in('temporary','service') then 'Automatic recovery could not finish this material. Saved sets are safe; try a clearer chapter or contact the app owner.' else left(p_message,300) end,updated_at=now() where id=q.id;
 if p_provider_busy then update private.generation_capacity set cooldown_until=greatest(coalesce(cooldown_until,now()),coalesce(resume_at,now()+make_interval(secs=>coalesce(p_retry_seconds,300)))) where id; end if;

end;
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
 and not exists(select 1 from private.generation_queue other where other.status='processing' and (other.user_id=t.user_id or other.material_id=t.material_id))
 order by t.available_at,t.created_at for update skip locked limit 1;
 if q.id is null then return null; end if;
 if not private.generation_editor(q.folder_id,q.user_id) then
  update private.generation_queue set status='paused',pause_reason='access',auto_resume_at=null,message='Generation stopped because editor access is no longer available.',updated_at=now() where id=q.id; return null;
 end if;
 update private.generation_queue set status='processing',continuation_token=null,worker_started=false,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',message=null,updated_at=now() where id=q.id returning * into q;
 return to_jsonb(q);
end;
$$;

create function public.continue_generation_task(p_task_id uuid,p_previous_lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; capacity private.generation_capacity;
begin
 select * into capacity from private.generation_capacity where id for update;
 if capacity.cooldown_until>now() or (select count(*) from private.generation_queue where status='processing')>=capacity.max_parallel then return null;end if;
 select * into q from private.generation_queue where id=p_task_id and status='queued' and continuation_token=p_previous_lease and available_at<=now() for update;
 if q.id is null or not private.generation_editor(q.folder_id,q.user_id) then return null;end if;
 if exists(select 1 from private.generation_queue where status='processing' and (user_id=q.user_id or material_id=q.material_id)) then return null;end if;
 -- Let an eligible waiting user go first instead of repeatedly taking the warm slot.
 if exists(select 1 from private.generation_queue other where other.id<>q.id and other.status='queued' and other.available_at<=now() and other.created_at<q.created_at and not exists(select 1 from private.generation_queue running where running.status='processing' and (running.user_id=other.user_id or running.material_id=other.material_id))) then return null;end if;
 update private.generation_queue set status='processing',worker_started=true,continuation_token=null,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',message=null,updated_at=now() where id=q.id returning * into q;
 return to_jsonb(q);
end;
$$;
create or replace function public.reconcile_processing_documents()
returns void language sql security definer set search_path='' as $$
 update public.document_files d set status='failed',error_message='Preparation was interrupted before it reached the queue. Open this upload to continue.'
 where d.status='processing' and d.processing_started_at<now()-interval '15 minutes'
 and not exists(select 1 from private.generation_queue q where q.document_id=d.id and (q.status in('queued','processing') or (q.status='paused' and q.auto_resume_at is not null)));
$$;

create or replace function public.admin_resume_generation(p_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform private.require_app_admin();
 if p_ids is null or cardinality(p_ids) not between 1 and 25 then raise exception 'Select 1 to 25 paused tasks'; end if;
 update private.generation_queue set status='queued',attempts=0,recovery_cycles=0,pause_reason=null,auto_resume_at=null,continuation_token=null,available_at=now(),message=null,last_error=null,updated_at=now() where id=any(p_ids) and status='paused' and private.generation_editor(folder_id,user_id);get diagnostics n=row_count;
 insert into private.maintenance_events(actor_id,action) values(auth.uid(),'resume_generation');
 perform public.dispatch_generation_queue();
 return n;
end;
$$;
create or replace function public.admin_cleanup_preview()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_app_admin();
 return jsonb_build_object(
 'invitations',(select count(*) from (select 1 from public.folder_invitations where expires_at<now()-interval '30 days' limit 1001) s),
 'activity',(select count(*) from (select 1 from public.activity_events where created_at<now()-interval '90 days' limit 1001) s),
 'jobs',(select count(*) from (select 1 from private.material_jobs j where status<>'processing' and created_at<now()-interval '30 days' and not exists(select 1 from private.generation_queue q where q.material_job_id=j.id) union all select 1 from private.asset_refresh_jobs where status<>'processing' and created_at<now()-interval '30 days' union all select 1 from private.generation_queue where (status='completed' and updated_at<now()-interval '14 days') or (status='paused' and updated_at<now()-interval '30 days') limit 1001) s),
 'usage',(select count(*) from (select 1 from private.ai_usage where usage_date<current_date-60 union all select 1 from private.seed_usage where usage_date<current_date-60 limit 1001) s),
 'audits',(select count(*) from (select 1 from private.maintenance_events where created_at<now()-interval '180 days' limit 1001) s),
 'duplicate_text',(select count(*) from (select 1 from public.document_files d join public.study_materials m on m.id=d.material_id where d.purged_at is not null and d.extracted_text=m.source_text and length(m.source_text)>=20 limit 1001) s),
 'queue',jsonb_build_object('waiting',(select count(*) from private.generation_queue where status='queued'),'running',(select count(*) from private.generation_queue where status='processing'),'paused',(select count(*) from private.generation_queue where status='paused'),'scheduler_ready',(select scheduler_ready from private.generation_capacity where id),'parallel',(select max_parallel from private.generation_capacity where id)),
 'paused_tasks',(select coalesce(jsonb_agg(t),'[]') from(select q.id,q.stage,q.message,q.last_error,q.updated_at,q.auto_resume_at,q.pause_reason,coalesce(d.name,a.title,'Study material') as title from private.generation_queue q left join public.document_files d on d.id=q.document_id left join public.study_assets a on a.id=q.asset_id where q.status='paused' order by q.updated_at desc limit 10)t));
end;
$$;
-- Classify existing paused jobs so users benefit without manually reopening them.
update private.generation_queue set pause_reason=private.generation_pause_reason(coalesce(last_error,message,'')) where status='paused';
update private.generation_queue set auto_resume_at=now()+interval '15 seconds',message='Your materials will continue automatically.' where status='paused' and pause_reason in('temporary','service') and created_at>now()-interval '24 hours';
revoke all on function private.generation_pause_reason(text),public.continue_generation_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.continue_generation_task(uuid,uuid) to service_role;
commit;
