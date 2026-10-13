-- Synapse 1.8.2. Run after 015 and 016, before deploying generate-study.
-- Allows 3 stages overall, 2 per account, and one stage per source material.
-- Adds bounded private timing records; saved learning data is preserved.
begin;
alter table private.generation_capacity add column if not exists max_per_user integer not null default 2 check(max_per_user between 1 and 4);
update private.generation_capacity set max_parallel=3,max_per_user=2 where id;
alter table private.generation_queue add column if not exists waiting_since timestamptz not null default now();
update private.generation_queue set waiting_since=updated_at where status in('queued','paused') and waiting_since>updated_at;
alter table private.generation_queue add column if not exists client_read_ms integer check(client_read_ms between 0 and 3600000);
alter table private.generation_queue add column if not exists client_upload_ms integer check(client_upload_ms between 0 and 3600000);

-- Keep the five-argument admission function for older clients/tests. This
-- overload records optional browser timings in the SAME admission transaction.
create or replace function public.enqueue_generation(p_user_id uuid,p_request_id uuid,p_document_id uuid,p_asset_id uuid,p_text text,p_intake jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=public.enqueue_generation(p_user_id,p_request_id,p_document_id,p_asset_id,p_text);
 if jsonb_typeof(p_intake)='object' and octet_length(p_intake::text)<=200 and jsonb_typeof(p_intake->'read_ms')='number' and jsonb_typeof(p_intake->'upload_ms')='number' then
  if (p_intake->>'read_ms')::numeric between 0 and 3600000 and (p_intake->>'upload_ms')::numeric between 0 and 3600000 then
   update private.generation_queue set client_read_ms=round((p_intake->>'read_ms')::numeric),client_upload_ms=round((p_intake->>'upload_ms')::numeric)
   where id=(result->>'id')::uuid and user_id=p_user_id and request_id=p_request_id and document_id is not null and client_read_ms is null;
  end if;
 end if;
 return result;
end;
$$;
revoke all on function public.enqueue_generation(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_generation(uuid,uuid,uuid,uuid,text,jsonb) to service_role;

create or replace function private.generation_task_eligible(p_user uuid,p_material uuid,p_limit integer)
returns boolean language sql stable set search_path='' as $$
 select (select count(*) from private.generation_queue where status='processing' and user_id=p_user)<p_limit
 and not exists(select 1 from private.generation_queue where status='processing' and material_id=p_material);
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
 and private.generation_task_eligible(t.user_id,t.material_id,capacity.max_per_user)
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
 and private.generation_task_eligible(t.user_id,t.material_id,capacity.max_per_user)
 order by (select count(*) from private.generation_queue running where running.status='processing' and running.user_id=t.user_id),t.available_at,t.created_at,t.id limit 1;
 if next_id is distinct from q.id then return null;end if;
 update private.generation_queue set status='processing',worker_started=true,continuation_token=null,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',message=null,updated_at=now() where id=q.id returning * into q;
 return to_jsonb(q);
end;
$$;

create or replace function public.claim_auto_generation(p_material_id uuid,p_user_id uuid,p_kind text,p_initial boolean default false)
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
 -- The material lock protects series numbering across users; the profile lock
 -- serializes this short account admission check across DIFFERENT materials.
 if exists(select 1 from private.material_jobs where material_id=m.id and status='processing' and created_at>now()-interval '15 minutes') then raise exception 'Study material is already generating. Wait for it to finish'; end if;
 if (select count(*) from private.material_jobs where user_id=p_user_id and status='processing' and created_at>now()-interval '15 minutes') >= (select max_per_user from private.generation_capacity where id) then raise exception 'Your parallel study tasks are still generating. Wait for a slot'; end if;
 select a.series_id into series from public.study_assets a where a.material_id=m.id and a.kind=p_kind and not a.is_custom order by a.created_at,a.id limit 1;
 series:=coalesce(series,gen_random_uuid());
 select coalesce(max(a.set_number),0)+1 into next_set from public.study_assets a where a.series_id=series;
 variant:=(array['comprehensive foundations','worked examples and applications','concept connections and comparisons','misconceptions and error diagnosis','case analysis and transfer','retrieval with justification and synthesis'])[((next_set-1)%6)+1];
 opts:=jsonb_build_object('automatic',true,'variant',variant,'set_number',next_set);
 insert into private.material_jobs(material_id,document_id,user_id,kind,series_id,set_number,options)
 values(m.id,(select id from public.document_files where material_id=m.id order by expires_at desc limit 1),p_user_id,p_kind,series,next_set,opts) returning id into job;
 select coalesce(jsonb_agg(jsonb_build_object('prompt',h.prompt,'coverage_key',h.coverage_key) order by h.created_at,h.signature),'[]') into history from private.material_history h where h.material_id=m.id and h.kind=p_kind;
 return jsonb_build_object('job_id',job,'kind',p_kind,'options',opts,'source_text',m.source_text,'source_format',m.source_format,'title',m.title,'previous',history,'source_document',(select to_jsonb(d) from public.document_files d where material_id=m.id order by expires_at desc limit 1));
end;
$$;

-- One small row per worker delivery. No source, prompt, answers, or credentials.
create table if not exists private.generation_runs (
 lease_token uuid primary key,
 task_id uuid not null references private.generation_queue(id) on delete cascade,
 stage text not null check(stage in('prepare','note','deck','quiz')),
 attempt integer not null,
 is_retry boolean not null default false,
 reserved_at timestamptz not null default clock_timestamp(), started_at timestamptz, ended_at timestamptz,
 queue_wait_ms bigint not null default 0 check(queue_wait_ms>=0), dispatch_wait_ms integer,
 outcome text not null default 'running' check(outcome in('running','saved','deferred','abandoned')),
 reported_at timestamptz,
 source_read_ms integer, gemini_ms integer, save_ms integer, validation_ms integer,
 gemini_calls integer, draft_retries integer, provider_retries integer,
 source_cached boolean, source_chars integer, output_chars integer,
 input_tokens integer, output_tokens integer, thought_tokens integer, model text
);
create index if not exists generation_runs_recent on private.generation_runs(reserved_at desc);
create index if not exists generation_runs_task on private.generation_runs(task_id,reserved_at desc);
alter table private.generation_runs enable row level security;
grant all on private.generation_runs to service_role;

create or replace function private.track_generation_wait()
returns trigger language plpgsql set search_path='' as $$
begin
 -- Preserve automatic pause time through recovery; a manual restart begins
 -- another wait. This clock is independent of status UI updates.
 if old.status='processing' and new.status<>'processing' or old.status='completed' and new.status='queued' or old.status='paused' and new.status='queued' and old.auto_resume_at is null then new.waiting_since:=clock_timestamp();end if;
 return new;
end;
$$;
drop trigger if exists generation_wait_lifecycle on private.generation_queue;
create trigger generation_wait_lifecycle before update on private.generation_queue for each row execute function private.track_generation_wait();

create or replace function private.track_generation_run()
returns trigger language plpgsql set search_path='' as $$
declare stamp timestamptz:=clock_timestamp();
begin
 if tg_op='UPDATE' and old.status='processing' and (new.status<>'processing' or new.lease_token is distinct from old.lease_token) then
  update private.generation_runs set ended_at=stamp,outcome=case when new.continuation_token=old.lease_token then 'saved' when new.last_error='Worker lease expired' then 'abandoned' else 'deferred' end
  where lease_token=old.lease_token and outcome='running';
 end if;
 if new.status='processing' and new.lease_token is not null and (tg_op='INSERT' or old.status<>'processing' or new.lease_token is distinct from old.lease_token) then
  insert into private.generation_runs(lease_token,task_id,stage,attempt,is_retry,reserved_at,queue_wait_ms)
  values(new.lease_token,new.id,new.stage,new.attempts,exists(select 1 from private.generation_runs where task_id=new.id and stage=new.stage),stamp,greatest(0,floor(extract(epoch from(stamp-new.waiting_since))*1000)))
  on conflict(lease_token) do nothing;
 end if;
 if new.status='processing' and new.worker_started then
  update private.generation_runs set started_at=stamp,dispatch_wait_ms=greatest(0,floor(extract(epoch from(stamp-reserved_at))*1000)) where lease_token=new.lease_token and started_at is null;
 end if;
 return new;
end;
$$;
drop trigger if exists generation_run_lifecycle on private.generation_queue;
create trigger generation_run_lifecycle after insert or update on private.generation_queue for each row execute function private.track_generation_run();

create or replace function public.record_generation_metrics(p_task_id uuid,p_lease uuid,p_metrics jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare metric text; ceiling integer; n integer;
begin
 if jsonb_typeof(p_metrics) is distinct from 'object' or octet_length(p_metrics::text)>3000 then raise exception 'Invalid timing report';end if;
 foreach metric in array array['source_read_ms','gemini_ms','save_ms','validation_ms','gemini_calls','draft_retries','provider_retries','source_chars','output_chars','input_tokens','output_tokens','thought_tokens'] loop
  ceiling:=case when metric in('gemini_calls','draft_retries','provider_retries') then 20 when metric in('source_chars','output_chars') then 1000000 when metric like '%tokens' then 10000000 else 150000 end;
  if jsonb_typeof(p_metrics->metric) is distinct from 'number' or (p_metrics->>metric)::numeric<0 or (p_metrics->>metric)::numeric>ceiling or trunc((p_metrics->>metric)::numeric)<>(p_metrics->>metric)::numeric then raise exception 'Invalid timing value';end if;
 end loop;
 if jsonb_typeof(p_metrics->'source_cached') is distinct from 'boolean' or coalesce(p_metrics->>'model','') !~ '^[a-z0-9.-]{0,100}$' then raise exception 'Invalid timing metadata';end if;
 -- An old delivery can report its own timings without touching its successor.
 -- Repeated reports never inflate counters, and unstarted tickets cannot report.
 update private.generation_runs set reported_at=clock_timestamp(),
 source_read_ms=(p_metrics->>'source_read_ms')::integer,gemini_ms=(p_metrics->>'gemini_ms')::integer,
 save_ms=(p_metrics->>'save_ms')::integer,validation_ms=(p_metrics->>'validation_ms')::integer,
 gemini_calls=(p_metrics->>'gemini_calls')::integer,draft_retries=(p_metrics->>'draft_retries')::integer,provider_retries=(p_metrics->>'provider_retries')::integer,
 source_cached=(p_metrics->>'source_cached')::boolean,source_chars=(p_metrics->>'source_chars')::integer,output_chars=(p_metrics->>'output_chars')::integer,
 input_tokens=(p_metrics->>'input_tokens')::integer,output_tokens=(p_metrics->>'output_tokens')::integer,thought_tokens=(p_metrics->>'thought_tokens')::integer,model=nullif(p_metrics->>'model','')
 where task_id=p_task_id and lease_token=p_lease and started_at is not null and reported_at is null;
 get diagnostics n=row_count;return n=1;
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
  delete from private.generation_queue where id in(select id from private.generation_queue where (status='completed' and updated_at<now()-interval '14 days') or (status='paused' and updated_at<now()-interval '30 days') order by updated_at limit 1000);get diagnostics extra=row_count;result:=result||jsonb_build_object('jobs',n+extra);
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

create or replace function public.prune_maintenance_records()
returns jsonb language sql security definer set search_path='' as $$
 select private.prune_selected_records(array['invitations','activity','jobs','usage','audits','duplicate_text','timings']);
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
 with sample as (select * from private.generation_runs where reserved_at>now()-interval '7 days' order by reserved_at desc limit 2000),
 intakes as (select distinct q.id,q.client_read_ms,q.client_upload_ms from sample g join private.generation_queue q on q.id=g.task_id where q.client_read_ms is not null),
 stages as (select stage,count(*)::integer deliveries,count(*) filter(where reported_at is not null)::integer measured,
 round(avg(queue_wait_ms)) queue_wait_ms,round(avg(dispatch_wait_ms)) dispatch_wait_ms,
 round(avg(source_read_ms) filter(where not source_cached)) source_read_ms,
 round(avg(gemini_ms) filter(where gemini_calls>0)) gemini_ms,
 round(avg(save_ms)) save_ms,
 count(*) filter(where outcome='saved')::integer saved,
 coalesce(sum(draft_retries),0)::integer draft_retries,coalesce(sum(provider_retries),0)::integer provider_retries,
 count(*) filter(where is_retry)::integer worker_retries from sample group by stage)
 select jsonb_build_object('checked_at',now(),'window_days',7,'sample_limit',2000,
 'capacity',(select jsonb_build_object('overall',max_parallel,'per_user',max_per_user) from private.generation_capacity where id),
 'intake',(select jsonb_build_object('uploads',count(*),'read_ms',round(avg(client_read_ms)),'upload_ms',round(avg(client_upload_ms))) from intakes),
 'totals',(select jsonb_build_object('deliveries',count(*),'measured',count(*) filter(where reported_at is not null),'queue_wait_ms',round(avg(queue_wait_ms)),'dispatch_wait_ms',round(avg(dispatch_wait_ms)),
 'source_read_ms',round(avg(source_read_ms) filter(where not source_cached)),'gemini_ms',round(avg(gemini_ms) filter(where gemini_calls>0)),
 'draft_retries',coalesce(sum(draft_retries),0),'provider_retries',coalesce(sum(provider_retries),0),'worker_retries',count(*) filter(where is_retry),'abandoned',count(*) filter(where outcome='abandoned'),
 'input_tokens',coalesce(sum(input_tokens),0),'output_tokens',coalesce(sum(output_tokens),0),'thought_tokens',coalesce(sum(thought_tokens),0),'source_cached',count(*) filter(where source_cached),'source_checks',count(*) filter(where reported_at is not null)) from sample),
 'stages',(select coalesce(jsonb_agg(to_jsonb(s) order by array_position(array['prepare','note','deck','quiz'],s.stage)),'[]') from stages s),
 'recent',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reserved_at desc),'[]') from (
 select coalesce(d.name,a.title,'Study material') title,g.stage,g.outcome,g.reserved_at,g.queue_wait_ms,g.dispatch_wait_ms,g.source_read_ms,g.gemini_ms,g.save_ms,g.gemini_calls,g.draft_retries,g.provider_retries,case when g.is_retry then 1 else 0 end worker_retries,g.reported_at,
 case when g.started_at is not null and g.ended_at is not null then greatest(0,round(extract(epoch from(g.ended_at-g.started_at))*1000)) else null end worker_ms
 from sample g join private.generation_queue q on q.id=g.task_id left join public.document_files d on d.id=q.document_id left join public.study_assets a on a.id=q.asset_id order by g.reserved_at desc limit 12) r)) into result;
 return result;
end;
$$;

revoke all on function private.track_generation_wait(),private.track_generation_run(),public.record_generation_metrics(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_generation_metrics(uuid,uuid,jsonb) to service_role;
revoke all on function public.admin_generation_performance() from public,anon;
grant execute on function public.admin_generation_performance() to authenticated;

revoke all on function private.generation_task_eligible(uuid,uuid,integer) from public,anon,authenticated;
commit;
