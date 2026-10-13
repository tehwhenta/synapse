> For the current 1.8.2 update and 3/2 concurrency, use [GENERATION_PERFORMANCE_SETUP.md](GENERATION_PERFORMANCE_SETUP.md). The setup below is historical.

> Initial 1.8 installation guide. For the current update, follow [GENERATION_REFINEMENT_SETUP.md](GENERATION_REFINEMENT_SETUP.md). Do not run 013 after 016; it would restore the older minute schedule.

# Synapse 1.8 — generation queue and database care

An upload is now one saved request. Supabase processes source preparation, reviewer, flashcards, and quiz in separate bounded stages. A temporary failure automatically continues from the unfinished stage. You can change sections or close the tab after the app confirms the request was accepted. Completed sets appear as they finish.

The main issue was the browser-owned three-request workflow: a failed request left a partial upload for the user to finish. This update keeps the comprehensive AI prompts and adds durable orchestration around them. The supplied schema already had the principal folder/material indexes. The new indexes target queue admission, active workers, and age-based cleanup.

## 1. Copy the update into your existing project

Extract **Synapse_Queue_Optimization_Update.zip** and merge its `Synapse_Project` folder into your existing project. Replace matching files and add the new files. Keep your `.env` and `.git` folders. The complete **Synapse_Project.zip** is also available if your local files are from different releases.

Copy **every file in the patch**, including the frontend, tests, scripts, package files, and Supabase source. Both package files are version **1.8.0**; no dependencies were added.

Do not delete or rename companion TypeScript files. `supabase/functions/` is the maintainable, multi-file CLI source; `supabase/dashboard/` contains combined files for pasting into the Supabase web editor.

## 2. Apply the database changes

Use your existing Supabase project. Keep RLS enabled and private buckets private.

1. If `011_generation_reliability.sql` has not succeeded yet, run it first, after the earlier migrations through 010. Do not rerun older migrations that already succeeded.
2. In **SQL Editor → New query**, paste and run the entire **`supabase/migrations/012_generation_queue.sql`**.
3. In another query, paste and run the entire **`supabase/migrations/014_safe_database_cleanup.sql`**.
4. Wait to run **013** until after the function deployments and Vault check below. This order lets the scheduler start only when its worker exists.

012 creates private queue records, worker leases, idempotent saves, and a shared capacity limit. 014 adds cleanup preview/actions and protects actively queued documents from the old processing-timeout cleanup. Neither script deletes saved study content.

Your schema export lists public columns/indexes, not private functions, policies, or cron/Vault configuration. These scripts are tested against the project's migrations; a separate live database audit was not possible here.

## 3. Deploy all three updated Edge Functions

For each row, open the **local file in the left column**, copy **all its contents**, and replace the code in the matching Supabase editor. Click **Deploy updates** each time.

| Copy the entire local file | Supabase → Edge Functions → function → Code |
|---|---|
| `supabase/dashboard/generate-study.ts` | `generate-study` → `index.ts` |
| `supabase/dashboard/cleanup-files.ts` | `cleanup-files` → `index.ts` |
| `supabase/dashboard/admin-maintenance.ts` | `admin-maintenance` → `index.ts` |

Keep the editor filename **index.ts**. Do not rename it to the local Dashboard filename. Keep gateway **Verify JWT OFF** for these functions: generation/admin handlers verify the user's identity themselves, and scheduled worker calls require the server-only `CRON_SECRET`. Database RLS stays ON.

In **Edge Functions → Secrets**, keep:

- Your working `GEMINI_API_KEY` and `GEMINI_MODEL` value. Do not copy the displayed Digest as either value.
- `ALLOWED_ORIGINS=https://rcgsynapse.vercel.app,http://localhost:5173` plus any other frontend origins you actually use.
- `CRON_SECRET`: the same secret used by the existing cleanup schedule. It must also be stored in Vault as `synapse_cron_secret`.

Do not add server secrets to Vercel `VITE_*` variables.

**CLI alternative:** from the merged project, deploy `generate-study`, `cleanup-files`, and `admin-maintenance` using `supabase functions deploy FUNCTION_NAME --no-verify-jwt`. Include all companion files. Use the Dashboard route or CLI route; there is no need to deploy twice.

## 4. Check Vault, then enable the queue schedule

If the existing ten-minute cleanup already works, the Vault secrets are probably configured. Check their **names only**, without displaying secret values:

```sql
select name from vault.secrets
where name in ('synapse_project_url','synapse_cron_secret');
```

Both names must be present, exactly once. `synapse_project_url` must contain your `https://PROJECT_REF.supabase.co` URL. `synapse_cron_secret` must match `CRON_SECRET` in Edge Function Secrets.

If either name is missing, create the missing secret in **Supabase Vault**. Use a strong secret of at least 32 random characters for `synapse_cron_secret`, and save the exact same value as `CRON_SECRET`. If you already have the secret, edit it rather than creating another secret with the same name. Changing this secret requires updating both places because cleanup also uses it.

Now run the entire **`supabase/migrations/013_generation_schedule.sql`** in SQL Editor. It reuses these Vault values and creates the named job `synapse-generation-queue`. There is no new Edge Function to create. The worker runs through `generate-study`.

Check the schedules:

```sql
select jobname, schedule, active
from cron.job
where jobname in ('synapse-generation-queue','synapse-cleanup-files');
```

Expected: the queue job is active with `* * * * *`; the existing cleanup job normally uses `*/10 * * * *`. A queue stage normally dispatches the next stage immediately. The minute schedule also recovers an interrupted delivery or worker.

You may rerun **013** to repair this named schedule; it does not create duplicate jobs. Run **012 and 014 once**. If a migration reports an error, do not continue by disabling policies or deleting tables.

## 5. Test and deploy the frontend

In your existing project terminal:

```bash
npm install
npm test
npm run build
```

Then push the merged files to your existing GitHub repository and confirm that Vercel deploys the new commit for **rcgsynapse.vercel.app**. Refresh any open tabs after deployment. The old synchronous endpoint returns an update notice so older tabs cannot bypass the queue's capacity limit.

A Vercel build does not run the Supabase SQL or deploy its Edge Functions. Complete both sets of steps. No new Vercel environment variable is required.

## 6. Confirm the behavior

1. Upload a readable chapter. After acknowledgement, a compact status row shows reviewer, flashcards, and quiz progress; navigation remains usable.
2. Refresh the page while it is preparing. Status returns from the server, and the job continues without a manual Finish generating action.
3. After all three finish, open a set and click **Generate**. Continue reading while it works, then use **Open new set** when ready. Earlier sets remain in numbered navigation.
4. Try uploads from two different signed-in accounts. Up to two stages run concurrently by default; other work waits. Each user can have up to three accepted unfinished requests, with one actively running at a time.
5. As admin, open **System care**. Check the queue totals, preview eligible temporary records, select categories, review, and clear them. For a paused task, open **Service details**, fix the stated service/source problem, then choose **Resume after fixing**.

Old partially generated uploads from before 1.8 can be transferred into the new queue by opening Uploads and choosing **Continue preparation** once. Existing formats are reused. New uploads use the queue automatically.

## What cleanup removes

| Category | Eligible data |
|---|---|
| Invitations | Invitations expired more than 30 days ago |
| Activity feed | Activity-event rows older than 90 days |
| Technical jobs | Completed queue entries older than 14 days; paused queue and completed/failed generation job records older than 30 days |
| Retired usage counters | Legacy AI/Seed daily counters older than 60 days |
| Maintenance audit | Entries older than 180 days |
| Duplicate upload text | Purged-upload text that exactly matches its retained material source |

Deletion is limited to 1,000 records per underlying table per run. The preview displays `1,000+` for larger batches; scheduled cleanup continues later. Active queue work is excluded. Saved reviewers, flashcards, quizzes, custom cards, source text, annotations, messages, quiz attempts, flashcard schedules and study sessions are preserved. Existing account/space deletion actions retain their separate reviewed workflows.

Removing rows makes space available for PostgreSQL reuse; the total database-size estimate may not immediately shrink. This feature does not run blocking full-table rebuilds.

## Reliability and capacity

- Queue state and generated set saves commit atomically. Repeated deliveries and lost acknowledgements reuse the same request; only one new set is committed per stage.
- Workers receive exclusive three-minute leases. Each stage retains the existing 130-second generation budget, bounded draft corrections, and validation. Expired workers cannot save over a replacement worker.
- Short-term provider throttling is deferred with increasing waits and a project-wide cooldown. Malformed output and temporary network failures have bounded recovery budgets. Waiting happens in the database, not inside a long-running function.
- Persistent configuration failures, unreadable sources, sustained quota exhaustion and genuinely exhausted content pause with a concise status. Technical details are available to the admin. The app does not report success when a format is missing.
- Active visible tabs check compact queue status about every five seconds. Hidden tabs stop periodic polling and refresh when shown again. No permanent queue polling is added for idle workspaces.
- Two concurrent stages is a conservative default, not a promise that any number of users fits a free plan. Gemini's available project quota and Supabase resources still determine throughput. Do not raise concurrency without measuring your project's quota and generation time.

Official references: [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions), [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits), [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Verification

All **141 checks in 24 test files** pass, and the production build succeeds. Automated coverage exercises the actual Dashboard handler with PostgreSQL migrations and simulated Gemini responses: upload plus five new sets of each type, a temporary failure of the third format, lost responses, duplicate worker delivery, expired leases, several users sharing capacity, source-hash merging, queue restoration after reload, permissions, and selective cleanup preservation. The scheduler SQL is also exercised using pg_net/cron test substitutes; the real hosted schedule, provider key and quota require the deployment checks above. No live Supabase credentials or Gemini key were available for a production load test.
