-- Synapse 1.8. Run once after 011. Keeps saved sets, source details and progress.
begin;
create table private.generation_queue (
 id uuid primary key default gen_random_uuid(), request_id uuid not null,
 user_id uuid not null references public.profiles(id) on delete cascade,
 folder_id uuid not null references public.folders(id) on delete cascade,
 document_id uuid references public.document_files(id) on delete cascade,
 asset_id uuid references public.study_assets(id) on delete cascade,
 material_id uuid references public.study_materials(id) on delete set null,
 kind text check(kind in('note','deck','quiz')),
 stage text not null default 'prepare' check(stage in('prepare','note','deck','quiz')),
 status text not null default 'queued' check(status in('queued','processing','paused','completed')),
 source_text text check(length(source_text)<=100000),
 completed_kinds text[] not null default '{}', result_asset_id uuid references public.study_assets(id) on delete set null,
 attempts integer not null default 0, available_at timestamptz not null default now(),
 lease_token uuid, lease_until timestamptz, worker_started boolean not null default false, material_job_id uuid, analysis_token uuid,
 message text, last_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(user_id,request_id), check ((document_id is null) <> (asset_id is null))
);
create unique index generation_upload_once on private.generation_queue(document_id) where document_id is not null;
create index generation_queue_pending on private.generation_queue(available_at,created_at) where status='queued';
create index generation_queue_running on private.generation_queue(lease_until,user_id,material_id) where status='processing';
create index generation_queue_user on private.generation_queue(user_id,created_at desc);
create index generation_queue_folder on private.generation_queue(folder_id,created_at desc);
create index material_jobs_user_processing on private.material_jobs(user_id,created_at) where status='processing';
create table private.generation_capacity (
 id boolean primary key default true check(id), max_parallel integer not null default 2 check(max_parallel between 1 and 4),
 cooldown_until timestamptz, last_dispatched_at timestamptz, scheduler_ready boolean not null default false
);
insert into private.generation_capacity(id) values(true);
alter table private.generation_queue enable row level security;
alter table private.generation_capacity enable row level security;
grant all on private.generation_queue,private.generation_capacity to service_role;

create function private.generation_snapshot(q private.generation_queue)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',q.id,'title',coalesce((select name from public.document_files where id=q.document_id),(select title from public.study_assets where id=q.asset_id),'Study material'),'folder_id',q.folder_id,'document_id',q.document_id,'asset_id',q.asset_id,'kind',q.kind,'stage',q.stage,'status',q.status,'completed_kinds',q.completed_kinds,'result_asset_id',q.result_asset_id,'message',q.message,'updated_at',q.updated_at);
$$;
create function public.my_generation_tasks(p_folder_id uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(private.generation_snapshot(q) order by q.created_at desc),'[]') from
 (select q.* from private.generation_queue q where (q.user_id=auth.uid() or q.folder_id=p_folder_id) and private.generation_editor(q.folder_id,auth.uid()) and (q.status<>'completed' or q.updated_at>now()-interval '1 day') order by (q.user_id=auth.uid()) desc,(q.status in('queued','processing')) desc,q.created_at desc limit 50) q;
$$;
create function public.enqueue_generation(p_user_id uuid,p_request_id uuid,p_document_id uuid default null,p_asset_id uuid default null,p_text text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; d public.document_files; a public.study_assets; fid uuid; mid uuid;
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
   if q.status='paused' then
    update private.generation_queue set status='queued',attempts=0,available_at=now(),message=null,last_error=null,source_text=coalesce(p_text,source_text),updated_at=now(),user_id=p_user_id where id=q.id returning * into q;
   end if;
   return private.generation_snapshot(q);
  end if;
 else
  select * into q from private.generation_queue where user_id=p_user_id and (asset_id=p_asset_id or (material_id=mid and kind=a.kind)) and status in('queued','processing') order by created_at limit 1;
  if q.id is not null then return private.generation_snapshot(q); end if;
 end if;
 if (select count(*) from private.generation_queue where user_id=p_user_id and status in('queued','processing'))>=3 then raise exception 'Your three materials are still being prepared. You can keep studying while they finish'; end if;
 insert into private.generation_queue(request_id,user_id,folder_id,document_id,asset_id,material_id,kind,source_text)
 values(p_request_id,p_user_id,fid,p_document_id,p_asset_id,mid,a.kind,p_text) returning * into q;
 if p_document_id is not null then update public.document_files set status='processing',processing_started_at=now(),error_message=null where id=p_document_id; end if;
 return private.generation_snapshot(q);
end;
$$;
create function public.claim_generation_task()
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; stale private.generation_queue; capacity private.generation_capacity;
begin
 select * into capacity from private.generation_capacity where id for update;
 -- A worker lease outlives the 130-second request budget. Recover killed workers.
 for stale in select * from private.generation_queue where status='processing' and lease_until<now() order by lease_until limit 20 for update skip locked loop
  update private.material_jobs set status='failed',last_error='Worker lease expired' where id=stale.material_job_id and status='processing';
  update public.study_materials set analysis_status='failed',analysis_token=null where id=stale.material_id and analysis_token=stale.analysis_token;
  update private.generation_queue set status=case when attempts>=5 then 'paused' else 'queued' end,available_at=now(),lease_token=null,lease_until=null,material_job_id=null,analysis_token=null,updated_at=now(),message=case when attempts>=5 then 'Generation is paused. The app owner can check the service; saved sets are safe.' else 'Continuing your study materials…' end where id=stale.id;
 end loop;
 if capacity.cooldown_until>now() or (select count(*) from private.generation_queue where status='processing')>=capacity.max_parallel then return null; end if;
 select * into q from private.generation_queue t where t.status='queued' and t.available_at<=now()
 and not exists(select 1 from private.generation_queue other where other.status='processing' and (other.user_id=t.user_id or other.material_id=t.material_id))
 order by t.available_at,t.created_at for update skip locked limit 1;
 if q.id is null then return null; end if;
 if not private.generation_editor(q.folder_id,q.user_id) then
  update private.generation_queue set status='paused',message='Generation stopped because editor access is no longer available.',updated_at=now() where id=q.id; return null;
 end if;
 update private.generation_queue set status='processing',worker_started=false,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',message=null,updated_at=now() where id=q.id returning * into q;
 return to_jsonb(q);
end;
$$;
create function public.start_generation_task(p_task_id uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue;
begin
 update private.generation_queue set worker_started=true where id=p_task_id and lease_token=p_lease and lease_until>now() and status='processing' and not worker_started returning * into q;
 if q.id is null then return null; end if;
 return to_jsonb(q);
end;
$$;
create function private.lock_generation_task(p_id uuid,p_lease uuid)
returns private.generation_queue language plpgsql set search_path='' as $$
declare q private.generation_queue;
begin
 select * into q from private.generation_queue where id=p_id and lease_token=p_lease and status='processing' and lease_until>now() for update;
 if q.id is null then raise exception 'Worker lease expired'; end if;
 if not private.generation_editor(q.folder_id,q.user_id) then raise exception 'Editor access required'; end if;
 return q;
end;
$$;
create function public.claim_queued_source(p_task_id uuid,p_lease uuid,p_material_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; result jsonb;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 result:=public.claim_auto_source(p_material_id,q.user_id);
 update private.generation_queue set material_id=p_material_id,analysis_token=(result->>'token')::uuid where id=q.id;
 return result;
end;
$$;
create function public.retain_queued_source(p_task_id uuid,p_lease uuid,p_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; result jsonb;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 result:=public.retain_auto_source(q.material_id,q.user_id,p_text,q.analysis_token);
 update private.generation_queue set analysis_token=null,source_text=null where id=q.id;
 return result;
end;
$$;
create function private.advance_generation_task(p_id uuid,p_asset_id uuid default null)
returns void language plpgsql set search_path='' as $$
declare q private.generation_queue; next_stage text;
begin
 select * into q from private.generation_queue where id=p_id;
 next_stage:=case when q.stage='prepare' then coalesce(q.kind,'note') when q.kind is not null then null when q.stage='note' then 'deck' when q.stage='deck' then 'quiz' else null end;
 update private.generation_queue set status=case when next_stage is null then 'completed' else 'queued' end,
 stage=coalesce(next_stage,stage),completed_kinds=case when q.stage='prepare' then completed_kinds else array_append(completed_kinds,q.stage) end,
 result_asset_id=coalesce(p_asset_id,result_asset_id),source_text=null,attempts=0,available_at=now(),lease_token=null,lease_until=null,material_job_id=null,analysis_token=null,message=null,last_error=null,updated_at=now() where id=q.id;
end;
$$;
create function public.finish_generation_prepare(p_task_id uuid,p_lease uuid)
returns void language plpgsql security definer set search_path='' as $$
declare q private.generation_queue;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.stage<>'prepare' then raise exception 'Invalid preparation stage'; end if;
 perform private.advance_generation_task(q.id);
end;
$$;
create function public.claim_queued_generation(p_task_id uuid,p_lease uuid,p_material_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; result jsonb;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 if q.stage='prepare' then raise exception 'Source preparation has not completed'; end if;
 result:=public.claim_auto_generation(p_material_id,q.user_id,q.stage,q.document_id is not null);
 update private.generation_queue set material_id=p_material_id,material_job_id=(result->>'job_id')::uuid where id=q.id;
 if result->>'existing_asset_id' is not null then perform private.advance_generation_task(q.id,(result->>'existing_asset_id')::uuid); end if;
 return result;
end;
$$;
create function public.complete_queued_generation(p_task_id uuid,p_lease uuid,p_output jsonb)
returns public.study_assets language plpgsql security definer set search_path='' as $$
declare q private.generation_queue; result public.study_assets;
begin
 q:=private.lock_generation_task(p_task_id,p_lease);
 result:=public.complete_auto_generation(q.material_job_id,q.user_id,p_output);
 -- Set creation and queue advancement COMMIT TOGETHER. Lost HTTP responses cannot create another set.
 perform private.advance_generation_task(q.id,result.id);
 return result;
end;
$$;
create function public.defer_generation_task(p_task_id uuid,p_lease uuid,p_error text,p_retry_seconds integer,p_message text,p_provider_busy boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare q private.generation_queue;
begin
 perform 1 from private.generation_capacity where id for update;
 select * into q from private.generation_queue where id=p_task_id and lease_token=p_lease and status='processing' for update;
 if q.id is null then return; end if; -- Includes an already committed, lost response.
 update private.material_jobs set status='failed',last_error=left(p_error,500) where id=q.material_job_id and status='processing';
 update public.study_materials set analysis_status='failed',analysis_token=null,analysis_error=left(p_error,500) where id=q.material_id and analysis_token=q.analysis_token;
 update private.generation_queue set status=case when p_retry_seconds is null then 'paused' else 'queued' end,
 available_at=now()+make_interval(secs=>greatest(5,least(3600,coalesce(p_retry_seconds,60)))),lease_token=null,lease_until=null,material_job_id=null,analysis_token=null,
 last_error=left(p_error,500),message=left(p_message,300),updated_at=now() where id=q.id;
 if p_provider_busy and p_retry_seconds is not null then update private.generation_capacity set cooldown_until=greatest(coalesce(cooldown_until,now()),now()+make_interval(secs=>p_retry_seconds)) where id; end if;
end;
$$;
-- 013 replaces this with pg_net dispatch. API can detect missing scheduler setup.
create function public.dispatch_generation_queue() returns integer language sql security definer set search_path='' as $$ select 0 $$;
create function public.generation_queue_ready() returns boolean language sql stable security definer set search_path='' as $$ select scheduler_ready from private.generation_capacity where id $$;
revoke all on function private.generation_snapshot(private.generation_queue),private.lock_generation_task(uuid,uuid),private.advance_generation_task(uuid,uuid) from public,anon,authenticated;
revoke all on function public.enqueue_generation(uuid,uuid,uuid,uuid,text),public.claim_generation_task(),public.start_generation_task(uuid,uuid),public.claim_queued_source(uuid,uuid,uuid),public.retain_queued_source(uuid,uuid,text),public.finish_generation_prepare(uuid,uuid),public.claim_queued_generation(uuid,uuid,uuid),public.complete_queued_generation(uuid,uuid,jsonb),public.defer_generation_task(uuid,uuid,text,integer,text,boolean),public.dispatch_generation_queue(),public.generation_queue_ready() from public,anon,authenticated;
grant execute on function public.enqueue_generation(uuid,uuid,uuid,uuid,text),public.claim_generation_task(),public.start_generation_task(uuid,uuid),public.claim_queued_source(uuid,uuid,uuid),public.retain_queued_source(uuid,uuid,text),public.finish_generation_prepare(uuid,uuid),public.claim_queued_generation(uuid,uuid,uuid),public.complete_queued_generation(uuid,uuid,jsonb),public.defer_generation_task(uuid,uuid,text,integer,text,boolean),public.dispatch_generation_queue(),public.generation_queue_ready() to service_role;
revoke all on function public.my_generation_tasks(uuid) from public,anon;
grant execute on function public.my_generation_tasks(uuid) to authenticated;
commit;
