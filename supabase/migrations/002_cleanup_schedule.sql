-- Run AFTER deploying cleanup-files and adding CRON_SECRET to Edge Function Secrets.
-- Edit the two values below. Do not commit the edited script containing your secret.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- Vault is preinstalled on hosted Supabase projects.
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'synapse_project_url');
select vault.create_secret('REPLACE_WITH_THE_SAME_CRON_SECRET', 'synapse_cron_secret');
-- Hourly cleanup keeps expiry close to 24 hours; raw files may remain up to ~25 hours.
select cron.schedule('synapse-cleanup-files', '17 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='synapse_project_url') || '/functions/v1/cleanup-files',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='synapse_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 100000
  );
$$);
