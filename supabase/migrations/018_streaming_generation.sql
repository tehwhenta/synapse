-- Synapse 1.9.0. Run after 017. Existing study content and concurrency limits are preserved.
begin;
alter table private.generation_queue add column stream_draft integer not null default 0;
alter table private.generation_queue add column stream_chars integer not null default 0;
alter table private.generation_queue add column stream_updated_at timestamptz;
alter table private.generation_runs add column first_token_ms integer;
alter table private.generation_runs add column stream_chunks integer;

-- Reset provisional stream counters on every lease/stage change, including retries.
create function private.reset_generation_stream()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.lease_token is distinct from old.lease_token or new.stage is distinct from old.stage or new.status<>'processing' then
  new.stream_draft:=0;new.stream_chars:=0;new.stream_updated_at:=null;
 end if;return new;
end;
$$;
create trigger generation_stream_lifecycle before update on private.generation_queue for each row execute function private.reset_generation_stream();
create function public.record_generation_progress(p_task_id uuid,p_lease uuid,p_draft integer,p_chars integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if p_draft not between 1 and 3 or p_chars not between 0 and 1000000 or p_draft is null or p_chars is null then return false;end if;
 update private.generation_queue set stream_draft=p_draft,stream_chars=p_chars,stream_updated_at=clock_timestamp()
 where id=p_task_id and lease_token=p_lease and status='processing' and worker_started and lease_until>clock_timestamp()
 and (p_draft>stream_draft or p_draft=stream_draft and p_chars>stream_chars)
 and (stream_updated_at is null or stream_updated_at<clock_timestamp()-interval '7 seconds');
 get diagnostics n=row_count;return n=1;
end;
$$;
revoke all on function private.reset_generation_stream(),public.record_generation_progress(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.record_generation_progress(uuid,uuid,integer,integer) to service_role;

-- Index each polling scope separately. Keep full source text out of polling projections.
-- Reuse generation_queue_user / generation_queue_folder indexes from 012.
create or replace function public.my_generation_tasks(p_folder_id uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
 with ids as (
  select id from private.generation_queue where user_id=auth.uid() and (status<>'completed' or updated_at>now()-interval '1 day')
  union
  select id from private.generation_queue where folder_id=p_folder_id and (status<>'completed' or updated_at>now()-interval '1 day')
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
 if p_metrics ? 'first_token_ms' and p_metrics->'first_token_ms'<>'null'::jsonb and (jsonb_typeof(p_metrics->'first_token_ms')<>'number' or (p_metrics->>'first_token_ms')::numeric not between 0 and 150000) then raise exception 'Invalid first token timing';end if;
 if p_metrics ? 'stream_chunks' and (jsonb_typeof(p_metrics->'stream_chunks')<>'number' or (p_metrics->>'stream_chunks')::numeric not between 0 and 1000000) then raise exception 'Invalid stream count';end if;
 -- An old delivery can report its own timings without touching its successor.
 -- Repeated reports never inflate counters, and unstarted tickets cannot report.
 update private.generation_runs set reported_at=clock_timestamp(),
 first_token_ms=(p_metrics->>'first_token_ms')::integer,stream_chunks=(p_metrics->>'stream_chunks')::integer,
 source_read_ms=(p_metrics->>'source_read_ms')::integer,gemini_ms=(p_metrics->>'gemini_ms')::integer,
 save_ms=(p_metrics->>'save_ms')::integer,validation_ms=(p_metrics->>'validation_ms')::integer,
 gemini_calls=(p_metrics->>'gemini_calls')::integer,draft_retries=(p_metrics->>'draft_retries')::integer,provider_retries=(p_metrics->>'provider_retries')::integer,
 source_cached=(p_metrics->>'source_cached')::boolean,source_chars=(p_metrics->>'source_chars')::integer,output_chars=(p_metrics->>'output_chars')::integer,
 input_tokens=(p_metrics->>'input_tokens')::integer,output_tokens=(p_metrics->>'output_tokens')::integer,thought_tokens=(p_metrics->>'thought_tokens')::integer,model=nullif(p_metrics->>'model','')
 where task_id=p_task_id and lease_token=p_lease and started_at is not null and reported_at is null;
 get diagnostics n=row_count;return n=1;
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
 'streaming',(select jsonb_build_object('first_token_ms',round(avg(first_token_ms)),'chunks',coalesce(sum(stream_chunks),0),'saved_workers',count(*) filter(where outcome='saved' and ended_at is not null),'worker_p50_ms',round((percentile_cont(0.5) within group(order by extract(epoch from(ended_at-started_at))*1000) filter(where outcome='saved' and started_at is not null and ended_at is not null))::numeric),'worker_p95_ms',round((percentile_cont(0.95) within group(order by extract(epoch from(ended_at-started_at))*1000) filter(where outcome='saved' and started_at is not null and ended_at is not null))::numeric)) from sample),
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

commit;
