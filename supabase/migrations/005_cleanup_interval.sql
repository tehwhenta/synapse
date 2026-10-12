-- Run after 004, updating cleanup-files, and keeping the existing Vault secrets from 002.
-- Reuses the same cron job name; it does not create a second hourly job or new secrets.
select cron.schedule('synapse-cleanup-files', '*/10 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='synapse_project_url') || '/functions/v1/cleanup-files',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='synapse_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 100000
  );
$$);
