# Synapse 2.1.0 — source-checked tools and neumorphic UI

Use this cumulative replacement instead of the earlier 2.0.0/2.0.1 ZIP. It includes those improvements and the latest accuracy, integration and interface changes. It supports your existing 1.9.1 project or the 2.0.1 update.

## 1. Merge the project files

Extract `Synapse_Learning_Tools_Update.zip`. Merge the contents of its `Synapse_Project` folder into `C:\Users\Asus\3D Objects\Synapse_Project`, replacing matching files and adding new ones. Keep your local connection settings and Git repository.

Replace both package files together. No new dependencies are required. The update includes `src/neumorphism.css` and its import in `src/main.js`; copy the complete update listed in `UPDATED_FILES.md`.

If you tried 2.0.0 locally, delete its obsolete `src/components/TeachBack.vue`. It is absent from this release. Projects older than 1.9.1 should first complete the earlier setup through SQL 019.

## 2. Supabase: run only missing migrations

Open your existing project → **SQL Editor → New query**. Copy and run each entire missing SQL file separately, in this order:

| File | Apply when | Purpose |
| --- | --- | --- |
| `supabase/migrations/020_learning_tools_and_cleanup.sql` | 020 has not run | 10 MB profile photos, private Mistake Notebook, custom-card saving and safe file cleanup |
| `supabase/migrations/021_ai_study_tools.sql` | 021 has not run | AI tool jobs, source fingerprints, cache and shared queue integration |
| `supabase/migrations/022_verified_study_tools.sql` | New for this update | Durable source-checking stages, repeat-safe saves, source guards, timing corrections and receipt cleanup |

**If you already applied 020 and 021, run only 022.** Do not rerun successful migrations. Keep RLS enabled.

022 rebuilds derived AI-tool previews on their next opening. Your saved reviewers, decks, practice quizzes, annotations and review schedules remain available. Finish any active tool request and save open note drafts before updating. Apply SQL and deploy the function below before using the new frontend.

## 3. Supabase: deploy the matching functions

For each required row, go to **Edge Functions → the named function → Code**. Replace the entire Dashboard `index.ts` with the entire corresponding local **dashboard** file, then deploy:

| Function | Local file to copy in full | Required |
| --- | --- | --- |
| `generate-study` | `supabase/dashboard/generate-study.ts` | Every installation of 2.1.0 |
| `cleanup-files` | `supabase/dashboard/cleanup-files.ts` | If you did not deploy the 2.0.1 cleanup update |
| `admin-maintenance` | `supabase/dashboard/admin-maintenance.ts` | If you did not deploy the 2.0.1 maintenance update |

Keep gateway **Verify JWT OFF** for these functions. The handlers verify users, source permissions, admin roles or the server-only cron secret themselves. Database RLS remains ON.

Do not rename files. Dashboard files are combined, ready-to-paste versions. The smaller `functions/.../index.ts` files import sibling modules and are intended for CLI deployment.

Keep your existing `GEMINI_API_KEY`, working `GEMINI_MODEL`, `CRON_SECRET` and built-in Supabase credentials. `ALLOWED_ORIGINS` should include `https://rcgsynapse.vercel.app` and `http://localhost:5173` if you develop locally. Gemini credentials stay in Supabase, not frontend environment variables.

CLI alternative from the project root:

```sh
npx supabase functions deploy generate-study --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
```

If you are also installing the earlier cleanup improvements:

```sh
npx supabase functions deploy cleanup-files --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
npx supabase functions deploy admin-maintenance --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
```

## 4. Keep automatic schedules active

In **Supabase → Cron**, keep the generation dispatcher at **15 seconds** and `synapse-cleanup-files` at **10 minutes**. No new cron job is needed. If cleanup is absent or still hourly, run the existing `supabase/migrations/005_cleanup_interval.sql` after deploying its function.

The schedules use the existing Vault `synapse_project_url` and `synapse_cron_secret`; the latter must match `CRON_SECRET` in Edge Function Secrets. Source checking resumes through this same scheduler, including after temporary AI throttling.

Expired originals and objects unreferenced for over 24 hours continue to be removed through the Storage API, with reference checks and bounded batches. Technical job cleanup also removes save-retry receipts older than 30 days. Both Storage buckets stay private.

## 5. Test and deploy the frontend

From your Windows project folder:

```sh
npm install
npm test
npm run build
```

After these pass, commit and push to your GitHub repository for Vercel deployment at `rcgsynapse.vercel.app`. Reopen the deployed app after the backend and frontend have both been updated.

## What improved

- **Source support:** Flashcards from Highlights and Concept Connections now use a separate AI source-support check. Each complete answer, concept definition and directed relationship is checked, including qualifications, negation, units and calculations. An exact quote by itself is no longer sufficient to publish a result.
- **Durable checking:** A validated draft is saved privately before checking starts. If checking is interrupted or throttled, the next worker resumes that draft. It does not pay for another full generation just to retry verification. Unsupported claims receive up to two semantic revisions; insufficient context produces a clear request for better source material.
- **Shared scheduling:** Both tool stages use the same **3 overall / 2 per user** limits and FIFO fairness. Unbound reviewer notes also receive the per-source guard. Prepared tools never become extra reviewer sets or overwrite existing study sets.
- **Cache reuse:** Checked results are reused when the source and highlights match. Renaming alone keeps the cache valid. A source edit invalidates the corresponding result. The cache identifies the current verification contract, so older unchecked previews are rebuilt.
- **Reliable saving:** Retrying the same highlight-card save after a lost acknowledgement returns the same deck or append for 30 days. Existing card IDs and review schedules are preserved. A list-refresh failure after a committed save does not cause another append. A changed source is checked again before a new save.
- **Formatted and math selections:** Highlight extraction preserves equation source, literal code, multiplication, subscripts and table boundaries. It avoids duplicated visual math text and does not split words around inline formatting.
- **Progress and measurements:** Users see “Checking source support” during verification. System care reports generation and checking separately; a normal phase transition is not counted as a worker retry. Status polling backs off during disconnections and stops when the panel closes.
- **Mistake Notebook:** Server-graded quiz mistakes stay personal. Late mastery/deletion responses cannot alter another signed-in account’s state.
- **Neumorphic UI:** Soft raised cards, inset inputs, tactile icon buttons and selected states use the existing cream, sand, taupe, olive and clay palette. Headline fonts, accessible focus outlines, color contrast, reduced-motion support, reviewer resizing and drawing layers are preserved.

The two AI tools use your existing Gemini quota. A fresh result normally uses one draft request and one source-check request; corrections can require more. Cache hits avoid provider requests. Reviewers retain their existing comprehensive prompts and output budgets, and an uploaded material still automatically generates its reviewer, flashcards and practice quiz.

## Where to use the features

- **Flashcards from Highlights:** Select text in a reviewer → three-dot menu → Flashcards from highlights. With no selection, saved highlights are used. The editor’s card icon also works. Review/edit the prepared cards, then save a new custom deck or append to one of your own decks in the same space. The collapsed picker handles up to 20 highlights at a time.
- **Concept Connections:** Reviewer → three-dot menu → Concept connections. Click a concept or relationship to inspect its definition, direction, explanation and source. Shared-space viewers can open cached maps; an editor prepares new ones.
- **Mistake Notebook:** My progress → notebook icon, or a quiz viewer’s three-dot menu. Review wrong answers, practise recall, mark understood or delete entries.
- **Focus:** The timer keeps its wheel, keyboard and minus/plus controls. Profile photos remain limited to 10 MB. Teach-Back remains removed.

The disconnected preview uses explicitly labeled, authored Sample results. Your connected deployment uses Gemini. Source-support checks improve grounding but cannot guarantee factual correctness in all source material or model outputs; inspect important facts and calculations against your course material.

## Verification

All **219 automated checks across 36 test files** passed, and the production build passed. Coverage includes independent source verdicts, bounded corrections, private checkpoints, interrupted checks, stale sources, permissions, queue limits/fairness, cache reuse, repeat-safe saves, account changes, equations and existing editor/generation/cleanup behavior.

Live Gemini, your hosted Supabase database and native desktop/mobile layout were not exercised here. After deploying, generate one highlight deck and one concept map, confirm the checking stage appears, reopen both to check cache reuse, and inspect System care’s stage timings and the next cleanup result.
