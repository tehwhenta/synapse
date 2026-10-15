# Synapse 2.0.1 — AI study tools and cleanup

Use this replacement update instead of the earlier 2.0.0 ZIP. Since you have not installed 2.0.0, this ZIP includes both its retained improvements and your latest refinements. It applies to the existing 1.9.1 project, with SQL migrations through 019 already installed.

## Replace the local files

1. Extract `Synapse_Learning_Tools_Update.zip`.
2. Merge the contents of its `Synapse_Project` folder into `C:\Users\Asus\3D Objects\Synapse_Project`. Replace matching files and add new ones. Keep your `.env` and `.git`.
3. Replace `package.json` and `package-lock.json` together. No new dependencies are required.
4. `UPDATED_FILES.md` lists the complete cumulative replacement. You do not need the previous 2.0.0 ZIP.

If you experimented with 2.0.0 locally, delete `src/components/TeachBack.vue`. It has been removed from this release. If your base is older than 1.9.1, use the full project ZIP and finish the earlier migrations through 019 first. Do not rerun successful migrations.

## Supabase — run two SQL files in order

Open your existing Supabase project, then **SQL Editor → New query**. Copy and run each entire file separately:

| Order | Local SQL file | Purpose |
| --- | --- | --- |
| 1 | `supabase/migrations/020_learning_tools_and_cleanup.sql` | 10 MB profile photos, private Mistake Notebook, custom-deck saving and safe storage cleanup |
| 2 | `supabase/migrations/021_ai_study_tools.sql` | Gemini highlight cards and concept maps, cached results, queue integration and access checks |

Keep RLS enabled. If 020 has already run successfully, run only 021. These migrations preserve saved reviewers, generated sets, annotations, custom decks, card schedules and study progress.

## Supabase — replace three functions

Go to **Edge Functions → the named function → Code**, replace the entire Dashboard `index.ts` with the entire corresponding local **dashboard** file, then deploy. Do this for every row:

| Function name | Local file to copy in full |
| --- | --- |
| `generate-study` | `supabase/dashboard/generate-study.ts` |
| `cleanup-files` | `supabase/dashboard/cleanup-files.ts` |
| `admin-maintenance` | `supabase/dashboard/admin-maintenance.ts` |

Keep gateway **Verify JWT OFF** for these functions. The application verifies authentication itself: `generate-study` checks the user and source permissions; `admin-maintenance` also checks the server-stored admin role; scheduled workers require the server-only `CRON_SECRET`. RLS remains ON.

Do not rename any files. The smaller `functions/.../index.ts` files import sibling modules. When using the Dashboard editor, paste the combined `dashboard/...ts` files above.

Keep your existing `GEMINI_API_KEY`, working `GEMINI_MODEL`, `CRON_SECRET`, `ALLOWED_ORIGINS` and built-in Supabase credentials. `ALLOWED_ORIGINS` must include `https://rcgsynapse.vercel.app` and `http://localhost:5173` if you use local development. Gemini requests stay on the server; do not add the Gemini key to Vercel's frontend environment variables.

CLI alternative, from your project root:

```sh
npx supabase functions deploy generate-study --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
npx supabase functions deploy cleanup-files --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
npx supabase functions deploy admin-maintenance --project-ref etrhrxhgyslqjxgdgedg --no-verify-jwt
```

## Keep the existing schedules

In **Supabase → Cron**, confirm:

- `synapse-cleanup-files` is active and runs every **10 minutes**. If missing or still hourly, run the existing `supabase/migrations/005_cleanup_interval.sql` after deploying the functions. It reuses the same job name.
- Your existing generation queue schedule remains active at **15 seconds**. The new tools use that same dispatcher; they do not need another schedule.

The schedules use the existing Vault `synapse_project_url` and `synapse_cron_secret`. The latter must match the function's `CRON_SECRET`.

Cleanup removes expired originals through the Storage API while protecting live generation leases. Saved sets and retained source text stay available. It also removes unreferenced objects in `study-files` and `profile-photos` after **24 hours**, rechecking references and briefly reserving the path to avoid deletion races. Each run handles bounded batches; failed removals stay eligible for later runs. Existing cleanup of expired invitations, old technical records and due account deletions continues. The admin's System care action uses the same worker. Both buckets remain private.

## Test and deploy to Vercel

From your Windows project folder:

```sh
npm install
npm test
npm run build
```

After these pass, commit and push to your existing GitHub repository. Vercel will build the update for `rcgsynapse.vercel.app`. Apply 020 → 021 and deploy all three functions before pushing the frontend. Save open note drafts before refreshing the deployed app.

## Use the refined features

| Feature | Where and how |
| --- | --- |
| Mistake Notebook | **My progress → notebook icon**, or a quiz viewer's three-dot menu. Completed quiz mistakes are recorded privately. Practise recall, mark understood, reopen or delete entries. |
| Flashcards from Highlights | Select a passage in a reviewer, then **three-dot menu → Flashcards from highlights**. Without a selection, it uses saved highlights. The editor also has a card icon for selected text. Gemini prepares focused questions and complete answers automatically; review or edit them, then save to a new custom deck or append to your own deck. |
| Concept Connections | **Reviewer → three-dot menu → Concept connections**. Gemini identifies supported semantic relationships. Click nodes to explore; click a relationship for its explanation. Expand **Source** to inspect the supporting passage. |
| Focus | The timer is now titled **Focus**. Its minus/plus buttons, mouse wheel and keyboard controls adjust minutes while stopped. Rename uses a text cursor icon; editing keeps the pen icon. |
| Profile photo | Profile settings accept JPG, PNG or WEBP photos up to **10 MB**. |

The tools save a changed reviewer before asking Gemini to use it. A failed save keeps the draft open and does not start AI work. Accepted AI work continues if its panel is closed; reopening resumes its task or reads the cached result.

These two AI tools use your existing Gemini quota. Identical requests reuse cached results; renaming alone does not invalidate the cache. Changing reviewer content or its retained source requires a fresh result. Each reviewer retains at most one current cached result for each tool; old technical job receipts use the existing cleanup retention. The tools share the **3 overall / 2 per user** generation capacity, automatic recovery and streaming progress. They do not overwrite existing study sets.

Highlight generation handles up to 20 selected passages at a time. Use the collapsed Highlights picker if you want a different group. Each result must include every selected highlight ID, without repeated questions. Concept maps use directed, specific relationships with explanations, rather than merely connecting words that share a paragraph. The backend checks output structure, IDs, duplicates and exact source quotes, and repairs invalid drafts within the same request. Source checks improve grounding; AI answers and interpretations still need review.

Shared-space viewers can read cached connections. An editor prepares a new map when needed. Personal Mistake Notebook entries remain private even in shared spaces. Their question/answer snapshots survive deletion of the original quiz, and account deletion cascades through the user's notebook and tool-cache records.

Teach-Back has been removed. The earlier 2.0 improvements remain: icon controls, three-dot menus, 10 MB photos and automatic cleanup. The visible “Your personal workspace” and “Start focus” labels stay removed.

The disconnected preview displays explicitly labeled, authored **Sample** results for its example content. Arbitrary uploaded or edited materials require the connected Supabase project and Gemini; the preview does not pretend to call Gemini without credentials.

## Verification

All **203 checks across 34 test files** were verified, and the production build passed. Database, worker and UI checks cover cache reuse/invalidation, shared capacity, worker leases, access revocation, source evidence, internal draft correction, lost acknowledgements, account changes, mobile timer icons, retained sets and the existing editor, cleanup and generation flows. The production build is also checked.

Live Gemini, your hosted Supabase project and native mobile/browser layout cannot be verified from this workspace. After deploying, open a reviewer, generate and save one highlight card, explore its concept map, reopen both tools to confirm cache reuse, and inspect the next scheduled cleanup result in System care.
