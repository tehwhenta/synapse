-- Run once after 012. Removes only bounded, expired technical records.
begin;
create index if not exists material_jobs_cleanup on private.material_jobs(created_at) where status<>'processing';
create index if not exists generation_queue_cleanup on private.generation_queue(updated_at) where status in('completed','paused');
create index if not exists activity_cleanup_time on public.activity_events(created_at);
create index if not exists asset_refresh_cleanup_time on private.asset_refresh_jobs(created_at) where status<>'processing';
alter table private.maintenance_events drop constraint maintenance_events_action_check;
alter table private.maintenance_events add constraint maintenance_events_action_check check(action in('schedule_inactive','cancel_inactive','cleanup','resume_generation'));

create function private.prune_selected_records(p_categories text[])
returns jsonb language plpgsql set search_path='' as $$
declare n integer; extra integer; result jsonb:='{}';
begin
 if p_categories is null or cardinality(p_categories)=0 or not p_categories <@ array['invitations','activity','jobs','usage','audits','duplicate_text'] then raise exception 'Choose supported cleanup categories'; end if;
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
 return result;
end;
$$;
create or replace function public.prune_maintenance_records()
returns jsonb language sql security definer set search_path='' as $$
 select private.prune_selected_records(array['invitations','activity','jobs','usage','audits','duplicate_text']);
$$;
create function public.admin_cleanup_preview()
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
 'paused_tasks',(select coalesce(jsonb_agg(t),'[]') from(select q.id,q.stage,q.message,q.last_error,q.updated_at,coalesce(d.name,a.title,'Study material') as title from private.generation_queue q left join public.document_files d on d.id=q.document_id left join public.study_assets a on a.id=q.asset_id where q.status='paused' order by q.updated_at desc limit 10)t));
end;
$$;
create function public.admin_clean_records(p_categories text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare token uuid; result jsonb;
begin
 perform private.require_app_admin();
 token:=public.begin_maintenance_run(auth.uid());
 if token is null then raise exception 'Cleanup is already running. Wait a moment before starting another batch'; end if;
 result:=private.prune_selected_records(p_categories);
 perform public.finish_maintenance_run(token,jsonb_build_object('pruned',result,'errors','[]'::jsonb));
 return result;
end;
$$;
create function public.admin_resume_generation(p_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform private.require_app_admin();
 if p_ids is null or cardinality(p_ids) not between 1 and 25 then raise exception 'Select 1 to 25 paused tasks'; end if;
 update private.generation_queue set status='queued',attempts=0,available_at=now(),message=null,last_error=null,updated_at=now() where id=any(p_ids) and status='paused' and private.generation_editor(folder_id,user_id);get diagnostics n=row_count;
 insert into private.maintenance_events(actor_id,action) values(auth.uid(),'resume_generation');
 perform public.dispatch_generation_queue();
 return n;
end;
$$;
-- A queued material may legitimately wait more than 15 minutes for provider capacity.
create function public.reconcile_processing_documents()
returns void language sql security definer set search_path='' as $$
 update public.document_files d set status='failed',error_message='Preparation was interrupted before it reached the queue. Open this upload to continue.'
 where d.status='processing' and d.processing_started_at<now()-interval '15 minutes'
 and not exists(select 1 from private.generation_queue q where q.document_id=d.id and q.status in('queued','processing'));
$$;
revoke all on function private.prune_selected_records(text[]),public.reconcile_processing_documents() from public,anon,authenticated;
grant execute on function public.reconcile_processing_documents() to service_role;
revoke all on function public.admin_cleanup_preview(),public.admin_clean_records(text[]),public.admin_resume_generation(uuid[]) from public,anon;
grant execute on function public.admin_cleanup_preview(),public.admin_clean_records(text[]),public.admin_resume_generation(uuid[]) to authenticated;
commit;
