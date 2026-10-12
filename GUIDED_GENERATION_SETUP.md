# Synapse 1.5 — install this refinement

This upgrade adds a sticky reviewer toolbar, continuous highlighting, drawings above text/tables, mobile timer controls, 20 MB uploads, custom flashcards, scanned topic selection, and server-enforced generation limits. Existing study sets and their progress are preserved.

## 1. Replace your local project files

Close the running Vite terminal with Ctrl+C. Extract `Synapse_Update_1.5.zip` and open the `Synapse_Project` folder inside it. Copy its contents into your existing project folder and choose **Replace files in the destination**. Merge folders; do not delete the existing project first.

The update contains the changed source, scripts, tests, package files, migration, and setup documents. Keep your own `.env` and `.git` folder. Neither is included in the patch. The full `Synapse_Project.zip` is also provided if you prefer the complete source.

The two package files are **`package.json` and `package-lock.json`**. Replace them together. This release adds no npm dependency; it keeps the existing editor, math, and Vue packages. Use Node.js 22.12 or newer.

## 2. Run the new SQL in Supabase

Use the same Supabase project your app already connects to.

1. Make sure migrations `001`, `003`, `004`, and `006` previously succeeded. If your admin email repair `007_admin_email_type.sql` has not been applied, run it first. Do not rerun the successful older setup scripts.
2. Open **Supabase → SQL Editor → New query**.
3. Open **`supabase/migrations/008_guided_generation.sql`** on your computer in any text editor.
4. Copy **all its SQL code**, paste it into SQL Editor, and click **Run** once.
5. Wait for success. If it fails, the transaction rolls back; read the error before proceeding. If it succeeds, do not run `008` again.

Keep **RLS enabled**. Keep `study-files` and `profile-photos` private. Do not manually add permissive policies. This migration changes the `study-files` bucket and database upload cap to **20 MB (20,971,520 bytes)**. The profile-photo cap remains 2 MB.

It adds `study_materials` and links uploaded files and generated sets to their source. Older saved sets count toward the new attempt limits. Retained text is private backend data; clients receive only authorized topic metadata and counts. Existing set deletion and account/space deletion continue to work.

## 3. Replace the generate-study Edge Function

Do this immediately after the migration, before deploying the new frontend. The migration deliberately blocks the old generation RPCs so an older function cannot bypass the new counters.

| Where to open | What to do |
| --- | --- |
| On your computer: **`supabase/dashboard/generate-study.ts`** | Copy the entire file’s code. This is the complete, combined Dashboard version. |
| In Supabase: **Edge Functions → generate-study → Code → `index.ts`** | Select all the old code, replace it with the copied code, then **Deploy**. |

Keep the filename **`index.ts`** inside Supabase. Do not rename it to `generate-study.ts`. Paste the code, not a filename or file path. You do not need to paste `guided.ts`, `transport.ts`, `prompts.ts`, or `validation.ts` separately when using the Dashboard version.

Keep gateway **Verify JWT OFF** for this function. The handler still validates the signed-in user with Supabase Auth and checks account availability, source access, and editor permission server-side. **RLS stays ON**; these are separate settings.

Keep your existing Edge Function secrets:

| Secret | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your Google AI Studio API key, server-side only. |
| `GEMINI_MODEL` | Keep your working supported model. The project default remains `gemini-3.5-flash-lite`. |
| `ALLOWED_ORIGINS` | `http://localhost:5173,https://rcgsynapse.vercel.app` plus any other exact origin you actually use. |

Do not put a Gemini API key or service-role/secret key into a `VITE_*` variable. Supabase supplies the backend URL and backend key automatically.

For a CLI deployment instead of the Dashboard route, deploy the whole `supabase/functions/generate-study/` folder. Its `index.ts` imports its companion modules. Do not combine the two deployment methods unnecessarily.

**No new Edge Function is required.** If `cleanup-files` and `admin-maintenance` are already current from 1.4, leave their code and your existing ten-minute cleanup schedule in place. Migration `008` extends the existing cleanup RPC to prune generation job records older than 30 days while retaining source attempt counts and duplicate history.

## 4. Check the database update

Run this read-only query in SQL Editor:

```sql
select id, public, file_size_limit
from storage.buckets
where id in ('study-files', 'profile-photos');

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('study_materials', 'document_files', 'study_assets');
```

Expected: both buckets are private; `study-files` is 20971520 bytes; `profile-photos` is 2097152 bytes; all three tables show `rowsecurity = true`.

## 5. Start and test the app

Open a terminal in your existing project folder:

```text
npm install
npm test
npm run build
npm run dev
```

Then check these flows with a real account:

1. Upload a readable chapter. The app scans its topics first and opens **Make your next study set**. Scanning creates topic metadata; it does not silently generate three sets.
2. Choose **Reviewer** to generate comprehensive notes. Open it, choose **Edit**, turn on the highlighter once, and select multiple separate text ranges. Click it again or press Escape in the editor to stop. The toolbar stays at the top while you scroll the reviewer. Drawings appear above the content.
3. Choose **Flashcards** or **Practice quiz**. Under **Choose item counts**, choose 10, 15, 20, or 30 items. For quizzes, set the exact quantities of True/False, Multiple Choice, and Identification so their sum matches the total. Zero of a type is allowed in this manual workflow.
4. Under **Focus on a topic**, choose a scanned topic. Its flashcard count follows the estimated depth. Topic quizzes use a total divisible by three and exactly equal counts of the three question types. For example, 18 questions means 6 of each type.
5. Use **Generate new set** in a saved set, or **Uploads → Generate sets**, to create more. Earlier sets remain accessible through their numbered set buttons. The new set opens after it is saved.
6. In the Flashcards tab, choose **Create custom flashcards**. Enter a deck title and question/answer pairs; add or remove cards, then save. This does not contact Gemini or spend an AI attempt. A custom deck supports the existing flip, study, rename, and export actions. It is not an uploaded AI source.
7. On mobile, use the clock button in the top bar to reach the timer. The timer appears before the study group in the lower mobile section. Use the plus/minus buttons, or scroll over the time on desktop. Mobile inputs use at least 16px text and the viewport requests a fixed scale; browser accessibility settings may override zoom restrictions.
8. With a second account, verify viewers can study but cannot generate, upload, or create/edit shared materials. Test presence and calls on the same deployed origin as before.

## Limits and source retention

| Operation | Limit |
| --- | --- |
| AI reviewer generation | 5 attempts per material, including the first. |
| AI practice quiz generation | 5 attempts per material, including the first. |
| AI flashcard generation | 10 attempts per material, including the first. |
| Topic scanning | Up to 3 attempts per material; a completed scan is cached. |
| Daily AI allowance | 20 started scans/generations per signed-in user per UTC day. Provider quota also applies. |
| Custom flashcards | 1–100 cards per deck; no AI attempt. Question up to 1,000 characters, answer up to 2,000, stored deck up to 120 KB. |
| Original file | Up to 20 MB; expires after about 24 hours. |

Per-material limits are shared by editors working with the same material in one study space. Started generation attempts remain spent after a provider failure or rejected AI result. Permission errors, invalid quantities, an already-running request, or a daily-allowance rejection do not spend a new generation attempt. The dialog refreshes counts after a failed request.

Deleting a saved set does not reset its source’s counters or question history. Re-uploading the same bytes in the same space reuses the scanned source and its counters. Renaming a file does not reset them. Different spaces have separate source records. Older uploads whose bytes were already removed before this upgrade cannot be retrospectively fingerprinted; their saved-set counts are still retained under their existing source record.

Generated sets do not expire when the original upload expires. New generations use the faithful retained extraction, and can also read an available original PDF/image for diagrams and equations. Keep your originals and re-upload when full source detail is needed. An older retained extraction may have omitted details; re-uploading makes the original available to generation again. Browser extraction of Word/PowerPoint is text-only, so export as PDF when diagrams or image-only slides matter.

## Freshness checks

The prompts include all retained history for that material/type, even after a saved set is deleted. The backend rejects exact normalized repetitions, strongly similar question wording, repeated learning-objective identifiers, duplicates within a set, wrong totals, and wrong quiz distributions. Reviewer attempts use different emphases and reject copied content. Existing sets are kept if output is rejected.

AI cannot guarantee absolute semantic uniqueness, and accurate facts/definitions naturally recur in reviewers. A short source may run out of distinct supported learning objectives before its numeric attempt cap. The app reports that situation instead of saving fabricated or padded questions; select fewer items or another topic. It does not automatically retry AI requests and spend extra attempts.

## 6. Push to GitHub and redeploy Vercel

Once the Supabase migration/function and local checks succeed, commit and push the changed source to your existing GitHub repository. Vercel rebuilds automatically when linked to that repository. For the first push, follow **VERCEL_SUPABASE_DEPLOY.md**. The existing root `vercel.json` still handles refreshes on SPA routes.

Keep the production frontend URL `https://rcgsynapse.vercel.app` in `VITE_APP_URL`, Supabase Auth’s Site URL/redirect allowlist, and `ALLOWED_ORIGINS`, as described in the deployment guide. This refinement does not require changing your Gmail SMTP settings or OTP templates.

## Verification supplied with this update

The full automated suite and Vite production build pass. Checks cover PostgreSQL permissions and counters, deletion/re-upload retention, cached scans, exact counts, topic distributions, output freshness, large-file provider transport, editor interactions, custom deck saving, presence, and existing account/admin flows.

Actual Gemini calls, your hosted Supabase settings, Gmail delivery, physical mobile rendering, and calls across separate networks must be checked on your deployed project. Browser visual testing was unavailable in the build environment.

Official references: [Supabase Storage uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads), [Gemini Files API](https://ai.google.dev/gemini-api/docs/files).
