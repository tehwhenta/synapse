# Synapse 1.9.0 — generation and reviewer editor update

Use this update after Synapse 1.8.2. It preserves saved study sets, source text, custom flashcards and account data. No dependency or secret changes are required.

## Apply the files

1. Extract `Synapse_Streaming_Editor_Update.zip`.
2. Open the extracted `Synapse_Project` folder. Copy its contents into `C:\Users\Asus\3D Objects\Synapse_Project`, replacing matching files and adding the new files. Merge folders; keep your existing `.env` and `.git`.
3. Do not rename Edge Function `index.ts` files. They remain the entry points in their own function folders.

The patch contains all files changed since 1.8.2. `UPDATED_FILES.md` lists them. `package.json` and `package-lock.json` change only the project version; no new package is required.

## Supabase: one SQL migration

1. Open your existing Supabase project `etrhrxhgyslqjxgdgedg`.
2. Select **SQL Editor → New query**.
3. Open `supabase/migrations/018_streaming_generation.sql` from your project, copy the entire file, paste it into the SQL Editor and click **Run** once.
4. Keep RLS enabled. This migration adds only private stream counters, timing fields and safe status/reporting functions. It does not remove study data or increase concurrency.

**Prerequisite:** `017_generation_performance.sql` must already have succeeded. If you have not installed 1.8.2, use the full project ZIP and follow `GENERATION_PERFORMANCE_SETUP.md` first, then run 018. Do not rerun successful old migrations. Leave the existing `synapse-generation-queue` schedule at 15 seconds; do not rerun 013 after 016.

## Supabase: replace generate-study

### Dashboard method

1. Open **Edge Functions → generate-study → Code**.
2. On your computer, open **`supabase/dashboard/generate-study.ts`**. Copy the whole file.
3. In the Dashboard, replace the entire contents of that function's **`index.ts`** with the copied code.
4. Deploy the function. Keep its gateway **Verify JWT** setting **OFF**: the handler verifies user identity itself, and worker calls require your existing server-only `CRON_SECRET`.
5. Keep existing `GEMINI_API_KEY`, `GEMINI_MODEL`, `CRON_SECRET` and `ALLOWED_ORIGINS`. No new secrets are needed.

Use the combined Dashboard file above. The smaller `supabase/functions/generate-study/index.ts` imports its sibling modules and cannot be pasted alone into a single-file Dashboard deployment. `cleanup-files` and `admin-maintenance` do not need redeployment for this update.

### CLI alternative

From your project root, deploy the complete function folder:

```sh
npx supabase functions deploy generate-study --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
```

Choose either Dashboard or CLI deployment, not both. For local CLI testing, the supplied `supabase/config.toml` uses `[edge_runtime] policy = "per_worker"` so background tasks survive an HTTP acknowledgement.

## Frontend: test and deploy

Open a terminal in your Windows project folder:

```sh
npm install
npm test
npm run build
```

After these succeed, commit and push your changed project files to your existing GitHub repository. Vercel should redeploy `https://rcgsynapse.vercel.app`. Keep your existing Vercel environment variables. Run SQL 018 and deploy generate-study before pushing the matching frontend. Refresh the deployed app afterward.

## What changed

| Requirement | Result |
| --- | --- |
| Latency and concurrency | Gemini responses arrive as SSE chunks. Productive calls can use up to 120 seconds inside the existing 130-second worker budget instead of being cut off at 60 seconds. An idle stream still stops after 60 seconds. Worker tickets receive an immediate acknowledgement using Supabase background tasks, releasing dispatcher HTTP connections. |
| Queries and source caching | Prepared-source reuse and one fenced source/history claim remain in place. Status polling uses the existing user/folder indexes in separate scopes and projects only status fields; full source text and private leases stay out of polling results. Stream status writes are bounded to one every eight seconds per worker, with an independent database throttle. |
| Drawings | New strokes use the whole reviewer paper so paragraph gaps and table boundaries do not split them. The overlay is clipped to its own stacking context and remains below the sticky toolbar. Drawing outside the paper ends the segment. Older paragraph-anchored strokes remain readable. |
| Eraser | Click or drag over a stroke or highlighted text. Highlight removal preserves the text and supports editor Undo. The eraser is available even if the reviewer has highlights but no drawings. |
| Tables | While editing a reviewer, hover near a column border or a row's bottom border and drag. Column widths and row heights survive saving, reopening, read mode and export. Rows support Escape to cancel; content establishes the minimum usable height. Wide tables scroll within the reviewer. |

The reviewer instructions, full source content, 24,000-token reviewer/extraction caps, 16,000-token practice caps, validation and freshness checks are unchanged. Three tasks can run overall, up to two per user on different materials. Initial uploads still generate all three formats. Partial streamed text is never saved as a finished set.

The progress bar continues to count **saved** formats. A separate status line shows received character count while the AI is responding. It is provisional activity, not a fabricated completion percentage. A saved set is announced only after validation and the database transaction finish.

Finish text and table sizing before drawing for the best alignment. Whole-paper drawings scale with the reviewer dimensions; large later text/layout changes can shift their relationship to particular words.

## Measure the production result

The supplied screenshot showed about 90 seconds of average Gemini time, with many service and draft retries. The old 60-second call cutoff is a likely contributor to retries; the screenshot alone cannot identify every provider or network error. Source reading was about 4 seconds and most stages already reused prepared source text.

Open the admin profile and refresh **Generation performance** after generating new materials. It now includes first content arrival time, median saved-worker time and the 95th percentile. Existing queue, startup, source-reading, Gemini, saving, retries and token measurements remain available.

A **3× production improvement has not been measured**. Streaming improves time until activity becomes visible; eliminating premature retries and held dispatcher connections can improve total latency. Completion time still depends on model speed, quota, source size and output detail.

For a fair comparison, use comparable chapters, the same model, the same mix of reviewer/flashcard/quiz stages and the same number of active users. Compare both completion time and output token count so faster results are not caused by shorter content. If 1.8.2 timing records are still present, the following read-only SQL groups the bounded sample by release behavior and stage:

```sql
with recent as (
  select * from private.generation_runs
  where reserved_at > now() - interval '7 days'
  order by reserved_at desc limit 2000
)
select case when stream_chunks is null then 'Earlier' else 'Streaming' end as delivery,
       stage, count(*) as saved_deliveries,
       round(avg(queue_wait_ms)) as queue_ms,
       round(avg(dispatch_wait_ms)) as startup_ms,
       round(avg(gemini_ms)) as ai_ms,
       round(avg(output_tokens)) as output_tokens,
       round(avg(draft_retries + provider_retries)) as internal_retries,
       round(avg(extract(epoch from (ended_at-started_at))*1000)) as worker_ms
from recent
where outcome = 'saved' and reported_at is not null
  and started_at is not null and ended_at is not null
group by delivery, stage
order by stage, delivery;
```

This is a stage comparison, not a complete upload benchmark. It excludes failed/deferred deliveries, so check the admin retry totals too. For end-to-end timing, record upload acceptance and the moment all three saved sets become ready for the same test batch. Do not raise concurrency merely because the frontend feels faster; check Gemini quota errors and the 95th percentile first.

## Verification

The full local suite passed 177 checks across 29 test files, and the production build passed. Targeted integration checks also passed after adding background acknowledgement. Tests cover split UTF-8/SSE/JSON, truncated streams, cancellation, long complete drafts, progress throttling and privacy, three overlapping streamed worker requests, old drawings, highlight erasure, table drag/save/reopen/undo, initial generation and five fresh generations per format.

Gemini and hosted services were simulated in these checks. Live Gemini load and native browser layout must be verified after you deploy. Try a reviewer on desktop and mobile: draw across paragraph/table boundaries, erase highlights, resize a table and reopen it. Confirm it stays inside the reviewer and scrolls properly at different browser zoom levels.
