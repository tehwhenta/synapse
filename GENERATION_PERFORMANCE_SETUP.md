# Synapse 1.8.2 — concurrent uploads and generation timings

This update lets **3 study stages run overall**, with **up to 2 per account** on different materials. A third upload from the same account waits safely. A material still has only one active stage, including when shared editors use it. Saved sets, source details, custom flashcards and study progress stay intact.

## Update your existing 1.8.1 project

1. Extract **Synapse_Generation_Performance_Update.zip**. Merge its `Synapse_Project` folder into `C:\Users\Asus\3D Objects\Synapse_Project`: replace matching files and add new ones. Keep your `.env` and `.git`.
2. In **Supabase → SQL Editor → New query**, paste and run all of **`supabase/migrations/017_generation_performance.sql`**. It updates both concurrency checks, adds private timing records and connects their cleanup to existing maintenance. Run this before deploying the function.
3. Open **`supabase/dashboard/generate-study.ts`** on your computer and copy **the entire file**. In **Supabase → Edge Functions → generate-study → Code → index.ts**, replace the existing code and click **Deploy updates**. Keep the function named `generate-study` and its editor file named `index.ts`.
4. Keep gateway **Verify JWT OFF** for `generate-study`, as before. The function verifies the user token or private cron secret itself. Keep database **RLS ON**.
5. In your project terminal, run:

   ```bat
   npm install
   npm test
   npm run build
   ```

6. Commit and push these changes to your existing GitHub repository. Let Vercel deploy that commit, then refresh open Synapse tabs.

**Only `generate-study` needs an Edge Function code update.** `cleanup-files` and `admin-maintenance` use the updated database functions automatically. No new dependencies, secrets, Gmail setup, or Vercel environment variables are needed. Both package files are version **1.8.2**. GitHub/Vercel deployment does not run Supabase migrations or deploy Supabase functions.

For CLI deployment, include all files in `supabase/functions/generate-study/`, including the new **`metrics.ts`**, plus `supabase/functions/_shared/uploadTypes.ts`. Deploy `generate-study --no-verify-jwt`. The Dashboard file already includes all companions; do not paste the smaller multi-file `functions/generate-study/index.ts` by itself.

If you have only completed the 1.8 setup through 014/013, run missing **015**, then **017**, deploy the current `generate-study`, and run **016** last. For a new installation, follow `SUPABASE_SETUP.md`. Do not rerun successful historical table migrations. Do not rerun 013 after 016, because it restores the slower one-minute schedule.

## Check Supabase after updating

Run this read-only query in SQL Editor:

```sql
select max_parallel, max_per_user, scheduler_ready, cooldown_until
from private.generation_capacity
where id;

select jobname, schedule, active
from cron.job
where jobname in ('synapse-generation-queue', 'synapse-cleanup-files');
```

Expected: **3**, **2**, `scheduler_ready = true`; the queue schedule remains **15 seconds** and active. File cleanup keeps its existing schedule. A future `cooldown_until` means the project is honoring an AI-service pause; increasing concurrency does not bypass that limit.

Sign in as **rcgsynapse@gmail.com**, open **System maintenance**, and press **Refresh** after generating test files. The new **Generation performance** section shows measured timings. It starts empty; old deliveries are not backfilled with guessed measurements.

## What is faster

- Different spaces from the same account can use two processing slots instead of one. Waiting users receive their first slot before another user's second slot when both are eligible.
- After source preparation, each stage reads its retained source and history through one fenced claim. It no longer rereads the upload metadata, storage or source scan on every stage.
- A warm worker can continue from preparation through the missing formats when time and fairness allow. Each continuation gets a fresh exclusive lease and obeys the same capacity checks. The complete worker request still has a **130-second** budget; it yields when less than **70 seconds** remain.
- No parallel Gemini calls run inside one material. This preserves source/history consistency, automatic partial-work recovery and duplicate protection.
- The detailed reviewer prompt, source coverage, math guidance, automatic item counts and bounded history remain. Output-token caps have **not** been lowered: that could turn a long valid response into an incomplete draft and create more retries.

The progress bar still reflects actually saved formats. Users do not see technical timing panels or need to keep the browser open while queued work runs.

## How to read the measurements

Open **Compare stages and recent deliveries** in the admin timing section. The sample covers the last **7 days**, limited to **2,000 recent deliveries**. One delivery is a stage such as source preparation or reviewer generation, rather than a whole upload.

| Measurement | What it includes |
| --- | --- |
| Queue wait | Time waiting before a processing slot is reserved, including scheduled retries and automatic pauses |
| Startup | Time from reservation until the worker actually starts |
| Browser source reading | File validation and Office/text extraction before the upload enters the queue; reported by the browser |
| File upload | Document metadata insertion and private file upload; reported by the browser |
| Server source reading | Metadata, download, validation, hashing, text retention and provider file upload/processing, including short backoffs during extraction; excludes Gemini generation responses |
| Gemini response | Time for all Gemini generation calls in that stage, including extraction and unsuccessful drafts |
| Save | Persistence calls made by the draft pipeline, including rejected transactional saves |
| Draft corrections | Extra calls to replace incomplete, repeated or invalid drafts |
| Service retries | Extra calls for transient provider errors inside a delivery |
| Queued retries | Further worker deliveries for the same unfinished stage, including automatic recovery cycles |

Average source reading uses uncached deliveries; Gemini averages use deliveries with at least one AI call. Unobserved worker phases display **—**, not an invented zero. Queue clocks also record killed or undelivered workers. Reported token counts include rejected drafts when Gemini supplies usage metadata.

Browser timing averages count each upload once, regardless of its number of stages. They are optional diagnostics, never used for access or concurrency decisions. Older frontends do not supply them; malformed optional diagnostics do not block generation.

If queue wait dominates, check the capacity and service cooldown. If Gemini time dominates, compare stages, output-token counts and draft corrections. Frequent corrections call for prompt/validation investigation; repeated service or queued retries call for checking Gemini quota, configuration and provider availability. High source-reading time points to file size, extraction or upload processing. These measurements let you adjust the right part without guessing or discarding comprehensive reviewer content.

Timing records contain counters and durations, not source text, prompts, answers or keys. They are private to the server/admin. Duplicate timing reports are ignored and a failed timing write does not fail generation. Records older than **14 days** are cleared by existing scheduled maintenance in bounded batches. The admin can also select **Old generation timings** in database cleanup. Learning history remains saved because it prevents repeated sets.

## Validation and practical limits

The included tests exercise actual queue/claim/save SQL and the real generation handler with simulated Gemini responses: overlapping requests, 3/2 capacity, same-material serialization, fair warm continuation, lease fencing, automatic recovery timing, private/idempotent reports, bounded cleanup, an initial upload and five consecutive fresh sets per format, rejected-draft correction and 429 recovery. The frontend timing panel is tested through DOM rendering.

Live Gemini response speed, your project quota and production network latency cannot be benchmarked without your project access. These changes remove confirmed application delays; they do not guarantee a fixed generation time. Keep the 3/2 settings initially and review real timings before increasing them.
