# Upgrade your existing Synapse project to 1.3

Your Supabase project already exists. Keep using it: this upgrade preserves existing accounts, spaces, materials, flashcard progress, and quiz attempts.

## 1.2 -> 1.3: reviewer tools, deletion, and Vercel

Follow **[VERCEL_SUPABASE_DEPLOY.md](VERCEL_SUPABASE_DEPLOY.md)** for the complete ordered setup.

1. Replace `src/`, `supabase/`, `scripts/`, and `tests/`; copy the updated `package.json`, `package-lock.json`, guides, `.gitignore`, `.env.example`, and `vercel.json`. Preserve `.env` and `.git`, and add `VITE_APP_URL=https://rcgsynapse.vercel.app` to your `.env`. Run `npm install`.
2. Run **`004_reviewer_accounts.sql` once** in Supabase SQL Editor. Existing `001` and `003` must already have succeeded; do not rerun them.
3. Replace/deploy **both** `generate-study` and `cleanup-files` using their complete `supabase/dashboard/*.ts` files. Keep gateway Verify JWT OFF and database RLS ON.
4. Update `ALLOWED_ORIGINS` to `https://rcgsynapse.vercel.app,http://localhost:5173`. Keep Gemini/cron secrets.
5. Run **`005_cleanup_interval.sql`** after the updated cleanup function is deployed and the existing Vault secrets/job are configured. This updates the same cron job to every ten minutes.
6. Set Supabase Site URL to `https://rcgsynapse.vercel.app` and add the exact root redirect URL plus local development redirects. Keep Gmail SMTP, Confirm email ON, and OTP templates unchanged.
7. Push source to GitHub; import it as a Vite project into Vercel and configure the three `VITE_*` variables in the deployment guide.

The update restores the original serif upload heading/description and the generating-state copy, keeps scroll-adjustable focus time, adds window resizing/maximizing, and saves text highlights/notes/freehand drawings. Account deletion requires an explicit profile action and email confirmation, signs the user out, and waits 48 hours before scheduled cleanup. New sign-in before the deadline cancels it. Owned spaces and the user's authored/uploaded shared materials are part of deletion; other people's accounts remain.

The older sections below are for installing missing earlier upgrades. Their statements about needing no SQL for **1.2** do not apply to **1.3**.

## Interface follow-up for an installed 1.2 project

Replace only `src/App.vue`, `src/style.css`, and `src/components/FocusTimer.vue`, then refresh your running Vite app. This restores the original upload heading, description, and serif styling, and adds timer adjustment by hovering over the time and scrolling. Scroll up to increase the duration and down to decrease it; pause first during a session. Arrow keys also work when the time is focused. The selectable duration is 1-180 minutes, and reset keeps your choice.

No package installation, SQL, Edge Function deployment, or Supabase configuration change is required for this interface follow-up.

## 1.1 -> 1.2 fast path

If `003_study_refinements.sql` already succeeded, **do not run any SQL again**. This update needs frontend/Edge Function changes and email settings, not new tables.

1. Stop Vite with **Ctrl+C** and extract the updated `Synapse_Project.zip`.
2. Replace `src/`, `supabase/`, `scripts/`, and `tests/`. Replace `package.json`, `package-lock.json`, `README.md`, `SUPABASE_SETUP.md`, and `UPGRADE_GUIDE.md`. Add `GMAIL_SMTP_OTP_SETUP.md`. Keep your own `.env` and `.git`.
3. Run `npm install` in your existing project folder.
4. In **Supabase -> Edge Functions -> generate-study -> Code -> index.ts**, replace everything with the **entire contents** of `supabase/dashboard/generate-study.ts`, then deploy. Keep gateway **Verify JWT OFF**. Its server code still authenticates users.
5. Follow **[GMAIL_SMTP_OTP_SETUP.md](GMAIL_SMTP_OTP_SETUP.md)**: connect Gmail SMTP, turn Confirm email ON, and replace both **Confirm sign up** and **Reset password** templates with the included HTML.
6. Run `npm run dev`. Existing confirmed accounts can sign in normally. Test signup and password recovery with an inbox you control.

`cleanup-files`, the hourly cron job, RLS, Storage buckets, and your existing Gemini secrets do not need changes for 1.2. The archive retains the current cleanup code for new installations or upgrades from 1.0.

### What changed in 1.2

- Code-entry signup confirmation and forgotten-password recovery, resend cooldowns, and no fixed OTP digit count in the interface or templates.
- More detailed, organized reviewer instructions with complete terminology, source sections, explained lists, comparisons, worked solutions, and self-checks. Text uploads no longer spend model output repeating text already retained by the server.
- A simpler workspace with milestones, duplicate dashboard stats, and decorative sidebar copy removed. Progress remains available in **My progress**.
- More accurate live/away/offline presence, deduplicated people, stale-session filtering, and call/media cleanup on disconnect.
- No application-level call participant cap. Responsive tiles show up to 12 videos on each page, while all joined peers remain in the call and keep their audio. Screen shares use the full grid width; camera quality adapts to group size.
- Original-file expiry warnings at upload, on the Uploads tab, and beside saved-set generation. Expired-source generation asks you to choose retained text or upload the original again. Existing study materials are not deleted by expiry.
- Animated flashcards with explicitly labeled, visually different **Question** and **Answer** sides and reduced-motion support.

The call is still a WebRTC peer mesh, not an unlimited-capacity conferencing server. Large groups are limited by devices, networks, TURN capacity, and Supabase's plan quotas. Use an SFU-based conferencing service before promising large production meetings. No SFU credentials or service subscription are included.

## Upgrading from 1.0

If the saved-set/photo upgrade has not been installed, complete the steps below once, then configure email using the SMTP guide.

## 1. Update the files on your computer

Stop the development server with **Ctrl+C**. Extract the new `Synapse_Project.zip`.

Copy these into your existing project folder and replace matching files:

- `src/`
- `supabase/`
- `scripts/`
- `tests/`
- `package.json` and `package-lock.json`
- `README.md`, `SUPABASE_SETUP.md`, `UPGRADE_GUIDE.md`, and `GMAIL_SMTP_OTP_SETUP.md`

Keep your existing `.env` and `.git`. The archive contains `.env.example`, not your actual connection secrets.

Open a terminal inside your project and run:

```text
npm install
```

Finish the backend upgrade below before restarting the app.

## 2. Run only the new database upgrade

1. Open your existing Supabase project.
2. Open **SQL Editor → New query**.
3. On your computer, open `supabase/migrations/003_study_refinements.sql` in a text editor.
4. Copy **all the SQL inside the file**, paste it into SQL Editor, and click **Run** once.
5. Keep RLS enabled. This upgrade enables RLS for its new private tables and keeps the application's existing access policies.

**Do not rerun `001_synapse.sql` or `002_cleanup_schedule.sql` on your existing project.** Do not delete or recreate any tables.

The new SQL adds:

- A `series_id`, `set_number`, and `content_format` to each study material. Existing materials become set 1.
- Authorized refresh functions that insert new sets instead of overwriting earlier ones.
- A private `profile-photos` Storage bucket with JPG/PNG/WebP uploads up to 2 MB.
- An owner-only space-deletion function and a queue for removing that space's remaining raw uploads.

## 3. Update generate-study

1. Open **Edge Functions → generate-study → Code**.
2. Select the function's `index.ts` file.
3. Open **`supabase/dashboard/generate-study.ts` on your computer**.
4. Copy the **entire code inside that file**. In Supabase's editor, press **Ctrl+A** and paste it to replace everything.
5. Click **Deploy / Deploy updates**.
6. Keep this function's **Verify JWT / Enforce JWT verification OFF**. Its code authenticates the user and checks owner/editor access before generating anything.

The editor's first line must be this comment:

```ts
// Generated from functions/generate-study. Paste this ENTIRE file into Dashboard index.ts.
```

**Paste the code, not the filename.** A bare `supabase/dashboard/generate-study.ts` in the editor causes `ReferenceError: supabase is not defined`.

Existing Edge Function secrets stay the same:

| Secret | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your existing Google AI Studio key |
| `GEMINI_MODEL` | Your existing supported model, initially `gemini-3.5-flash-lite` |
| `ALLOWED_ORIGINS` | `http://localhost:5173,https://synapse-study-ralph.ivoryseed1.chatgpt.site` plus any actual deployed app origins |
| `CRON_SECRET` | Your existing cleanup secret |

No new API keys are required. Keep server secrets in Supabase, never in `VITE_*` variables.

## 4. Update cleanup-files

1. Open **Edge Functions → cleanup-files → Code → index.ts**.
2. Copy the entire contents of **`supabase/dashboard/cleanup-files.ts`** into the editor, replacing its old code.
3. Click **Deploy / Deploy updates**.
4. Keep **Verify JWT OFF**. This function checks `x-cron-secret` itself.

Your existing hourly cron schedule and Vault secrets continue to work. The updated function also removes raw files queued by deleted spaces. Space records and materials are deleted immediately; remaining raw Storage files are removed on a later cleanup run. Failed Storage removals stay queued for retry.

## 5. Restart and test

```text
npm run dev
```

Open **http://localhost:5173**, sign in with your existing account, and check:

1. Open an existing reviewer. Click **Generate new set**. After generation, buttons **1, 2** appear; the arrows navigate between them. Set 1 still contains your original reviewer.
2. Repeat for flashcards or a quiz. Refresh affects only that material type. Your earlier quiz scores and card reviews remain attached to their original set.
3. Click **Rename**, enter a title, and save it. Titles are editable on reviewers, decks, and quizzes, separately for each set.
4. In a reviewer, click **Edit reviewer**. You see formatted text rather than Markdown symbols. Select text and use **Bold, Italic, Underline, Strikethrough, Headings, Lists, Alignment, Tables, Undo, or Redo**. Click an equation to edit it; the equation button inserts one.
5. In flashcards, open **Export → Print / Save as PDF**. In Chrome's print dialog, choose **Save as PDF** as the destination. You can also download a **Study sheet (.html)**, which opens by double-clicking it in a browser, or **Plain text (.txt)**, which opens in Notepad. No VS Code is needed. Anki TSV remains an optional advanced export.
6. Click your profile in the sidebar → **Add photo / Change photo** → choose a JPG, PNG, or WebP up to 2 MB → **Save profile**. Remove photo is also available. The bucket is private; your shared study peers can view your current photo.
7. To delete a space, open its **…** button beside the space title → **Delete this space** → review the confirmation → **Delete space and its materials**. Only its owner can do this. This permanently removes all that space's sets, messages, invitations, and study progress for all members.

Owners and editors can refresh or edit materials. Viewers can navigate every saved set, study, and export; they cannot refresh or rename them.

## Reviewer generation behavior

The new prompt asks for comprehensive topic coverage, terminology with definitions and roles, comparisons and useful tables, fully explained enumerations, source examples, key relationships, common mistakes, a concise recap, and self-check questions with answers. For a substantial chapter roughly 2,000-4,000 useful words is a guide rather than a minimum. Short sources are kept appropriately short instead of padded; all substantive source sections must be covered, including later topics. Notes remain within the existing storage size limits.

For mathematical material it asks for the given values and unknown, symbol definitions, formula/method selection, domain restrictions, numbered solution steps with reasons, units, a final answer, a verification, and common mistakes. Missing or unreadable values must be identified rather than guessed. Math renders as formatted equations.

Refreshed cards and questions are checked against prompts from the five most recent sets to reject exact repeats. Source concepts may recur because they still need practice. Model quality and provider quotas still affect results; if refresh fails, the earlier sets stay intact. Each refresh counts toward the existing 20-generation daily limit.

Refresh normally uses the original retained text. An available PDF or image can be read directly while its raw upload is still retained. After raw-file expiry, refresh uses the retained extraction; older versions of the app may have stored a shorter source digest. Reupload a source if you need content that was absent from that digest. Editing a reviewer changes that set; it does not rewrite the source for its sibling flashcards and quizzes. Manually written notes can generate a new reviewer set from their current content.

Existing short reviewers do not change automatically. Use **Generate new set** to create a fuller version, keeping the original.

## Troubleshooting

| Error | Action |
| --- | --- |
| Could not find `list_latest_assets` or `claim_asset_refresh` | Run `003_study_refinements.sql` successfully in the same project used by your app. |
| `supabase is not defined` on line 1 | Replace the function editor contents with the full Dashboard `.ts` file, then deploy. |
| `WORKER_ERROR` / 500 before the browser POST runs | Open Edge Function Logs and read the actual exception. |
| CORS preflight fails | Confirm the function is deployed, gateway JWT verification is OFF, and `ALLOWED_ORIGINS` includes your exact origin without a trailing slash. |
| `profile-photos` bucket missing | Run the new migration. It creates the bucket and policies automatically. |
| AI repeated a question | Refresh again. Earlier sets are safe; the source may support only a limited number of distinct questions. |
| Source text unavailable | Reupload the original material or create a source note. |
| Existing migration says column/table already exists | Check whether the upgrade already succeeded. Do not reset your database or rerun the initial schema. |

For optional local checks, run `npm test` and `npm run build`. The automated checks cover the upgrade, RLS, private photos, refresh preservation, formatted editing, exports, and set navigation. Live provider generation and cross-device calling must be verified with your actual Supabase project and devices.
