> Historical 1.8.1 instructions. For the current 1.8.2 update, use [GENERATION_PERFORMANCE_SETUP.md](GENERATION_PERFORMANCE_SETUP.md).

# Synapse 1.8.1 — faster generation and automatic recovery

This update keeps the simple upload workflow: one file produces a reviewer, flashcards and a quiz. It reduces avoidable queue delay, automatically resumes recoverable pauses, rejects unreadable uploads, restores visible generation progress, and trims repetitive reviewer instructions.

## If your 1.8 setup already works

You already ran 011, 012, 014, deployed the three functions, and ran 013. Keep that setup. **Do not rerun those migrations.**

1. Extract **Synapse_Generation_Refinement_Update.zip** and merge its `Synapse_Project` folder into your existing project. Replace matching files and add new files; keep `.env` and `.git`.
2. In Supabase **SQL Editor → New query**, copy and run the entire **`supabase/migrations/015_generation_refinement.sql`** once.
3. Open **`supabase/dashboard/generate-study.ts`** locally and copy **all** its contents. In **Edge Functions → generate-study → Code → index.ts**, replace the code and **Deploy updates**. Keep the editor filename `index.ts` and gateway **Verify JWT OFF**. The handler authenticates users or the server-only cron secret itself. Keep database **RLS ON**.
4. Run the entire **`supabase/migrations/016_faster_generation_schedule.sql`** in SQL Editor. It changes the existing queue job to **15 seconds** and adds bounded cleanup for its old run logs. It reuses your existing Vault secrets and CRON_SECRET.
5. In your project terminal, run `npm install`, `npm test`, then `npm run build`. Commit/push the merged files and confirm Vercel deploys that commit. Refresh open tabs.

**Only `generate-study` needs an Edge Function code update for 1.8.1.** The existing `cleanup-files` and `admin-maintenance` functions use the upgraded SQL functions. No new secrets, dependencies, Gmail configuration or Vercel environment variables are needed. Both package files are version 1.8.1.

Pushing to GitHub/Vercel does not run the Supabase SQL or deploy the Edge Function. Complete both backend and frontend steps.

For CLI deployment, include **all** files under `supabase/functions/generate-study/` and the new `supabase/functions/_shared/uploadTypes.ts`, then deploy `generate-study --no-verify-jwt`. The Dashboard file already combines these companions; do not paste the smaller multi-file `functions/generate-study/index.ts` by itself.

## Check the schedule

```sql
select jobname, schedule, active
from cron.job
where jobname in (
  'synapse-generation-queue',
  'synapse-generation-history-prune',
  'synapse-cleanup-files'
);
```

Expected: the queue uses **15 seconds**, the run-log cleanup uses **41 3 * * *** (daily, UTC), and the existing file cleanup remains unchanged. Supabase supports seconds intervals on current hosted Postgres versions; if your project rejects the interval, check its database version rather than disabling the queue. See [Supabase Cron quickstart](https://supabase.com/docs/guides/cron/quickstart).

016 can be rerun to repair these named schedules. Run 015 once. Do not run the older 013 after 016: that would restore the one-minute interval.

## What is faster

- Cached source text goes directly to the requested format. It does not reserve a separate preparation worker.
- An existing partial upload queues only its missing formats; complete sets are reused.
- Fast first-time source preparation can begin the reviewer in the same worker request, with a new fenced lease and the same total 130-second budget. It hands off through the normal queue when there is not enough time or an earlier eligible user is waiting.
- The scheduler checks due work every 15 seconds instead of every minute. An empty check stays in SQL and does not invoke an Edge Function or Gemini.
- Short-term throttling follows Google's Retry-After/retryDelay when supplied; fallback waits are shorter and bounded. Shared cooldowns and the two-stage concurrency limit remain in place.
- Reviewer instructions dropped from **5,465 to 2,397 characters** (about 56% shorter). Earlier reviewer excerpts are also smaller. Character reduction is not a measured Gemini token count or a promise about output cost.

The reviewer still covers all substantive source sections, definitions, complete lists, relevant examples and comparisons. Worked solutions appear only for source material that teaches formulas, calculations, proofs or equation-based problems. Essential cautions stay beside the relevant concept. Generic overviews, repeated final reviews, separate self-check questions and unnecessary non-math problem-solving are omitted. A short accuracy/coverage/relevance checklist remains internal.

## Automatic continuation

Recoverable paused jobs show when they will continue. Scheduling resumes them without an admin click, and page refreshes do not restart completed sets.

Temporary failures receive short bounded retries, then a two-minute pause before another recovery cycle. Service configuration failures are checked at 15-minute intervals, with a shared cooldown to avoid repeatedly sending invalid requests. Once the app owner fixes the key/model/service, the queued work can resume automatically; there is no routine need to press Resume after fixing.

Recovery is finite: up to three temporary recovery cycles, up to 24 paced service checks, and a 24-hour job lifetime. Persistent failures eventually stop with an honest message. Unreadable sources, revoked access and genuine content exhaustion do not enter automatic retry loops. The admin retains diagnostics and a manual override for exceptional cases. Accepted recoverable pauses count toward the user's three unfinished requests.

Existing paused jobs from 1.8 are classified by 015. Recent recoverable jobs get an automatic continuation time; old, unreadable or inaccessible jobs remain stopped. Saved sets and progress are retained.

## Upload messages

Accepted formats remain **PDF, DOCX, PPTX/PPT, JPG/JPEG, PNG, WEBP, TXT and MD**, up to **20 MB**. Legacy `.doc`, Packet Tracer `.pkt/.pka`, executables and other unsupported formats are rejected before upload/generation with a clear list of supported alternatives.

The app checks signatures as well as extensions. Renaming a Packet Tracer file to `.pdf`, `.docx` or `.txt` does not make it valid study material. Empty/corrupt Office documents, binary text and AI-unreadable sources receive a readable explanation. Save Word files as DOCX; use readable PDF or diagram screenshots for formats the app cannot analyze. Scanned Office pages can be exported as PDF for AI reading.

Error popups now use a darker warm color, an alert icon, readable contrast and a longer display period. Invalid-file errors also stay in the upload dialog until it is closed. Popup buttons use the existing olive palette with clearer contrast and focus states.

## Progress

The upload status keeps a visible bar showing **0, 33, 66 and 100%** as its three study sets are saved. A single new set uses an indeterminate bar while Gemini is working. The app does not invent a time-based completion percentage. Completed upload status stays briefly at 100%, and recovery pauses display their next scheduled check. You can continue studying while work is queued.

## Verify your deployment

1. Drop a `.pkt` file: the supported-format message should appear before any upload or generation request.
2. Upload a readable chapter: check that all three formats appear, the progress bar advances, and refreshing the page preserves progress.
3. Open a generated set and click Generate: it should skip cached preparation and preserve earlier numbered sets.
4. As admin, check System care: recoverable pauses show their automatic continuation time; diagnostics remain available.
5. Test with two signed-in users. The shared concurrency cap remains enforced; extra work waits without holding an open browser request.

Automated tests cover the deployed Dashboard handler with PostgreSQL migrations and simulated Gemini responses, including five regenerations per format, provider throttling, automatic recovery, upload signatures, worker leases, progress and popup behavior. The actual hosted scheduler, live provider quota and generation speed still require the checks above. No live Gemini key or production Supabase credentials were available for a load test.

## Earlier installation

For a new or older project, complete the missing setup through 014 using SUPABASE_SETUP.md. Then apply 015, deploy the current functions, configure the existing Vault/cron setup with 013 if it has never run, and apply 016 last. Never rerun successful older table migrations.
