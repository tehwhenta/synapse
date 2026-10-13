-- Run after 015 and deploying the updated generate-study. Reuses existing Vault secrets.
begin;
do $$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='synapse_project_url') or not exists(select 1 from vault.decrypted_secrets where name='synapse_cron_secret') then
  raise exception 'Keep the Vault secrets from 013 configured before updating this schedule';
 end if;
end;
$$;
-- Same job name: replaces its minute schedule, without a duplicate worker schedule.
select cron.schedule('synapse-generation-queue','15 seconds','select public.dispatch_generation_queue()');
-- Fast empty polls are SQL-only. No Edge Function is invoked without eligible work.
-- Retain one week of this job's run history so frequent polling does not fill the database.
select cron.schedule('synapse-generation-history-prune','41 3 * * *',$job$
 delete from cron.job_run_details where runid in (
  select r.runid from cron.job_run_details r join cron.job j on j.jobid=r.jobid
  where j.jobname in('synapse-generation-queue','synapse-generation-history-prune')
  and r.end_time<now()-interval '7 days' order by r.end_time limit 10000
 );
$job$);
commit;
