# Synapse 1.7.1 — generation reliability fix

This patch fixes false reviewer duplication checks and revises defective Gemini drafts inside the same Generate request. Uploads still automatically produce a reviewer, flashcards and a practice quiz. Generate creates one new numbered set of the type you are viewing. Earlier sets, custom cards, annotations and progress stay saved.

## 1. Merge the patch

Extract **Synapse_Generation_Fix.zip**. Merge its `Synapse_Project` folder into `C:\Users\Asus\3D Objects\Synapse_Project`, replacing matching files. Keep your existing `.env` and `.git`.

This patch assumes migration 010 already succeeded. If it has not, use **AUTOMATIC_GENERATION_SETUP.md** first. Both replacement package files are version 1.7.1; no dependencies were added.

Copying local files or pushing to Vercel alone does not update Supabase's running generation code. Complete both backend steps below.

## 2. Supabase: run migration 011

1. Open your existing Supabase project → **SQL Editor → New query**.
2. Open `supabase/migrations/011_generation_reliability.sql` on your computer.
3. Copy the entire SQL into the editor and click **Run**.
4. Wait for success before deploying the function. Migration 010 must already have succeeded. Do not rerun earlier successful migrations.

Keep RLS enabled. This migration preserves saved data, keeps generation RPCs service-role-only, verifies active-account/editor permissions, and keeps the one-running-job guard. It gives the initial set and first five regenerations six distinct study emphases, includes the saved set number in prompt metadata, orders new history records consistently, and permits complete small sets of one or two items. It does not clear history to evade duplication checks.

## 3. Supabase: replace generate-study

1. Open **`supabase/dashboard/generate-study.ts`** from the patch in a text editor.
2. Copy **all** its contents.
3. Open Supabase → **Edge Functions → generate-study → Code → index.ts**.
4. Select all the code in that editor and replace it with the copied contents.
5. Click **Deploy updates** and wait for success.

Keep the Supabase editor filename **index.ts** and function name **generate-study**. The Dashboard file combines every companion module, so it is the file to copy. The smaller `supabase/functions/generate-study/index.ts` belongs to the multi-file CLI source; CLI deployment must include all its companions.

Keep gateway **Verify JWT OFF**: this function verifies the user's Supabase access token and permissions itself. Keep your valid `GEMINI_API_KEY` server-only and `GEMINI_MODEL=gemini-3.5-flash-lite` if that is your working model. `ALLOWED_ORIGINS` must include `https://rcgsynapse.vercel.app` and `http://localhost:5173` for local testing. The Secrets table's Digest is not the model value.

## 4. Check the deployed update

1. Refresh the app and upload one readable chapter. The first upload action should finish all three formats without a second click.
2. Open the reviewer. Click **Generate**, wait for completion, and repeat five times. Sets 1–6 should remain accessible.
3. Repeat the five-click check in flashcards and the practice quiz. Wait for each action to finish.
4. Open an earlier set and confirm its contents and progress remain available.

The fix is in Supabase's generation backend; the 1.7 interface already calls these endpoints. Commit the merged files to GitHub so later deployments use this version. You can validate your local copy with `npm test` and `npm run build`.

## Why the errors occurred

| Previous automatic path | Reliability patch |
|---|---|
| A bag-of-words reviewer comparison could reject accurate notes using the same terms | Shared vocabulary is allowed; exact copies and extensive copied explanations remain rejected |
| Reusing 40% of long paragraphs failed even when they were source definitions | Source quotations, formulas, tables and enumerations are distinguished from copied explanatory prose |
| Complete one- or two-question responses failed the three-item minimum | AI chooses useful counts, including smaller complete sets; unanswered items still fail |
| Flashcards/quizzes did not receive the set's study emphasis | All formats receive six distinct initial study treatments and the saved set number |
| One malformed, truncated or repeated draft ended the user's request | Up to three drafts are checked within the same claim and click, with corrective feedback |
| Retrying an unknown save outcome could create duplicate assets | Only explicit transaction-aborting validation/duplicate errors are eligible for revision |

Comprehensive reviewer instructions still require terminology and definitions, all substantive sections, complete enumerations, comparisons and tables, and reproducible equation solutions with symbols, substitutions, units, restrictions and checks. Later sets develop different applications, reasoning tasks and explanations. A shared concept can support a meaningfully different task; changing wording, names or numbers alone is insufficient.

Harmless format variations are normalized, including common array wrappers, question-type aliases, lettered choices, Boolean True/False answers and missing internal coverage metadata. Answers and explanations are never guessed. Partial JSON is never salvaged into invented content. Failed drafts are not saved as additional numbered sets.

## Validation and practical limits

Each request has a 130-second budget, at most three drafts, and at most 60 seconds for any single draft. Source preparation is a separate request; the file is not uploaded again just to revise extraction. Temporary Gemini files are still removed. See [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits).

Transient timeouts and 5xx failures receive bounded backoff. Invalid API/model requests, permissions errors, quota exhaustion and blocked responses remain actionable and do not trigger repeated calls. See [Google Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting).

Automated tests use the actual combined Dashboard handler and real PostgreSQL migrations with **simulated Gemini responses**. A bad first draft followed by a valid second draft is reproduced for the initial three formats and five consecutive regenerations of each: **all 18 Generate actions succeed**, save one new set each, and preserve older progress. PDF extraction also recovers from a truncated first draft inside its preparation request. Persistent invalid output stops after three drafts; a provider 400 is not retried.

All **131 regression checks in 22 test files** and the production build pass. Live Gemini calls require your deployed key and quota and were not exercised here. A very short source may eventually have no meaningful fresh tasks; genuine exhaustion is reported rather than saving unsupported facts or copies.

## Replacement files

The patch contains `supabase/dashboard/generate-study.ts`, migration 011, the five generation source modules (`automatic.ts`, `errors.ts`, `reliable.ts`, `transport.ts`, `index.ts`), `scripts/bundle-dashboard.mjs`, the reliability/database tests, both package files and the current setup guides/README. Merge every included file so your local source stays consistent with the combined Dashboard code.
