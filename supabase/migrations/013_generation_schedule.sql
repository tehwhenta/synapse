-- Run AFTER 012 and deploying the updated generate-study function.
-- Reuses the existing synapse_project_url / synapse_cron_secret Vault secrets.
-- They must match SUPABASE_URL and CRON_SECRET in Edge Function Secrets.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
begin;
do $$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='synapse_project_url' and decrypted_secret like 'https://%.supabase.co')
 or not exists(select 1 from vault.decrypted_secrets where name='synapse_cron_secret' and length(decrypted_secret)>=16) then
  raise exception 'Configure synapse_project_url and synapse_cron_secret in Supabase Vault first. See QUEUE_SETUP.md';
 end if;
end;
$$;
create or replace function public.dispatch_generation_queue()
returns integer language plpgsql security definer set search_path='' as $$
declare ticket jsonb; dispatched integer:=0; endpoint text; secret text; limit_jobs integer;
begin
 select decrypted_secret into endpoint from vault.decrypted_secrets where name='synapse_project_url' limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='synapse_cron_secret' limit 1;
 if endpoint is null or secret is null then return 0; end if;
 select max_parallel into limit_jobs from private.generation_capacity where id;
 for i in 1..limit_jobs loop
  ticket:=public.claim_generation_task();
  exit when ticket is null;
  perform net.http_post(url:=rtrim(endpoint,'/')||'/functions/v1/generate-study',
   headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',secret),
   body:=jsonb_build_object('task_id',ticket->>'id','lease_token',ticket->>'lease_token'),timeout_milliseconds:=140000);
  dispatched:=dispatched+1;
 end loop;
 return dispatched;
end;
$$;
-- Idempotent by job name; waking once a minute also recovers killed workers.
select cron.schedule('synapse-generation-queue','* * * * *','select public.dispatch_generation_queue()');
update private.generation_capacity set scheduler_ready=true where id;
revoke all on function public.dispatch_generation_queue() from public,anon,authenticated;
grant execute on function public.dispatch_generation_queue() to service_role;
commit;
