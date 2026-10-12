# Synapse 1.7.1 — automatic study generation

**If you already installed 1.7 and migration 010:** use [GENERATION_RELIABILITY_SETUP.md](GENERATION_RELIABILITY_SETUP.md) for the error fix. It adds migration 011 and the latest function code. The steps below install the complete automatic workflow from an earlier version.

Upload material once. Synapse automatically prepares a reviewer, flashcards, and a practice quiz. There is no topic picker, item-count form, or Seed currency. Open any generated set and click **Generate** to save a fresh set of that same type. Earlier numbered sets and progress remain. Custom flashcards still have their own creation, editing, and deletion controls.

## 1. Merge the update

Stop Vite with Ctrl+C. Extract `Synapse_Automatic_Generation_Update.zip`. Merge the contents of its `Synapse_Project` folder into your existing project and choose **Replace files in the destination**. Keep your own `.env` and `.git`.

Delete these three retired UI files from your project:

- `src/components/GenerationDialog.vue`
- `src/components/SeedBalance.vue`
- `src/components/SeedIcon.vue`

The update changes `src/App.vue`, `src/stores/workspace.js`, `src/style.css`, `src/components/FocusTimer.vue`, and `src/components/StudyViewer.vue`. It also includes the generation backend, bundling script, package files, migrations 010/011, documentation, and tests. Both package files should be replaced together; no new dependencies were added.

## 2. Run migrations 010 and 011 once

Use the Supabase project already connected to Synapse. Earlier migrations through `009_seeds_and_custom_cards.sql` must already have succeeded.

1. Open **Supabase → SQL Editor → New query**.
2. On your computer, open `supabase/migrations/010_automatic_study.sql`.
3. Copy its entire contents into SQL Editor and click **Run**.
4. Wait for success, then run the complete `supabase/migrations/011_generation_reliability.sql` in a separate new query.
5. Run only migrations that have not already succeeded; do not rerun older successful migrations.

The migration preserves existing sets, annotations, custom cards, and practice progress. It adds private server-controlled source preparation and automatic generation, disables the public Seed balance endpoint, and keeps the old currency records only as historical data for existing maintenance. New generation does not check or spend Seeds. The old three-failed-scan counter and exhausted concept inventory no longer block this workflow. A source with no retained text still needs a readable original.

**Keep database RLS ON and your storage buckets private.** All new privileged generation RPCs are service-role-only and verify editor membership and active accounts. Concurrent work is blocked while a generation is already running; there is no new daily currency allocation or material attempt cap.

## 3. Replace the deployed generate-study function

1. Open `supabase/dashboard/generate-study.ts` on your computer.
2. Copy the **entire** file.
3. Open **Supabase → Edge Functions → generate-study → Code → index.ts**.
4. Replace all code in that editor with the copied Dashboard file.
5. Click **Deploy updates**.

Keep the Supabase editor filename `index.ts`. The Dashboard file is the combined single-file version. The smaller `supabase/functions/generate-study/index.ts` imports companion files and is intended for the CLI project.

Keep gateway **Verify JWT OFF** for this function: the handler validates the signed-in user's token itself. RLS stays ON. Keep `GEMINI_API_KEY` server-only and `GEMINI_MODEL` set to the working model ID, such as `gemini-3.5-flash-lite`. The Secrets table's Digest is a hash, not the actual model value. Keep `ALLOWED_ORIGINS` including `https://rcgsynapse.vercel.app` and your localhost origin when needed.

## 4. Run and deploy

Run `npm run dev` to check locally. Upload a readable chapter: the progress message changes as the reviewer, flashcards, and quiz are saved. No configuration dialog opens. Open one material and click **Generate**: its next numbered set should appear while the earlier set remains accessible. Open custom flashcards: their manual edit/delete controls remain and their AI generation shortcuts stay hidden. The timer has no Seed balance.

For your existing Vercel setup, run `npm run build`, commit the replacement files and removals, and push to your connected GitHub repository. Keep the existing production environment variables and `vercel.json` refresh rewrite. If your repository is not connected yet, use `VERCEL_SUPABASE_DEPLOY.md` for the original steps.

## 5. If an upload only partially finishes

Successful formats are saved immediately. Under **Uploads**, choose **Finish generating** or **Retry generation** to produce the missing formats. Existing initial formats are reused instead of duplicated. Re-uploading the same bytes within the same space also reuses the source identity. To deliberately create a new set, open that set and click **Generate**.

Older failed scan counts no longer need manual resetting for the new workflow. If the original expired before any readable source text was retained, upload it again. Original files still expire after about 24 hours; saved study materials remain. Retained text cannot guarantee every original diagram or unreadable detail is available later.

## Prompt and response comparison

| Previous approach | 1.7 approach | Reason |
|---|---|---|
| Initial source plus long reviewer and both practice formats in one JSON response | Prepare source, then generate and save the three formats sequentially | Each response is smaller; a later failure does not erase completed formats |
| Nested topics, exact type counts, hundreds of concept IDs, and coverage declarations | No topic inventory or user parameters; the AI chooses supported coverage and useful item counts | Removes conflicting count requirements and a complex schema contract |
| Long reviewer and equations encoded inside JSON strings | Reviewer and PDF/image text extraction are plain Markdown responses | Removes JSON escaping/parsing from long notes and LaTeX equations |
| Strict JSON.parse rejected complete responses wrapped in JSON fences | Complete fenced JSON is unwrapped; incomplete JSON remains rejected | Accepts harmless formatting without guessing missing answers |
| Low temperatures on every model | Gemini 3 uses the model default temperature | Follows Google's guidance about repetitive/looping output |
| Forced identical concept coverage for repeated reviewers | Fresh teaching emphasis with stable source facts | New explanations and worked examples preserve factual consistency |

The comprehensive reviewer instructions still require terminology with definitions, detailed sections, tables where useful, every source enumeration, and reproducible equation solutions with substitutions, units, restrictions, checks, and common mistakes. They now request the finished notes directly and compact table separators. The earlier errors cannot be attributed to the prompt alone without the provider response: HTTP 400 is a request rejection; unreadable output means a response failed JSON parsing. These are different failure classes.

Flashcards and quizzes use compact JSON-only responses with readable Unicode math rather than LaTeX escape sequences. Item counts are selected by the AI within practical per-set bounds: 1–50 cards and 1–30 quiz questions, including useful small complete sets. Quiz mixes are flexible. These bounds are not choice fields.

Generation history is retained per source and format. Normalized question copies, close wording matches, and repeated canonical learning tasks are rejected before saving. Reviewer copies and extensively reused explanations are rejected, while shared source facts, tables and vocabulary are allowed. Invalid first drafts receive bounded corrective revision within the same user action; only one valid set is saved. Essential definitions and facts can recur in fresh reviewers; their explanation and study treatment should differ. Perfect semantic non-repetition cannot be guaranteed by a language model. When the source cannot support any useful fresh task, the app asks for different material instead of padding a set.

Removing Seeds does not remove Google's API quota, billing, model access, or service limits. Read [Google's troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting) for provider errors. No retry loop is added for rejected 400 requests, and truncated or invalid answers are never silently saved.

## Validation

The update is checked with database permission/persistence tests, mocked Edge Function and upload workflows, reviewer/custom-card DOM interactions, the existing regression suite, and a production build. Live Gemini responses and physical mobile/browser layout checks still need testing against your deployed project.
