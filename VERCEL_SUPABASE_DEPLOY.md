# Publish Synapse at rcgsynapse.vercel.app

Use your existing Supabase project and its data. This guide covers Synapse 1.3, GitHub, Vercel, production invitations, and the 48-hour account deletion feature. Gmail SMTP and your OTP templates remain configured as described in `GMAIL_SMTP_OTP_SETUP.md`.

## 1. Update your local project

1. Stop Vite with Ctrl+C. Extract the new `Synapse_Project.zip`.
2. Replace `src/`, `supabase/`, `scripts/`, and `tests/` in your existing project. Replace `package.json` and `package-lock.json`; copy the updated guides, `.gitignore`, `.env.example`, and the new `vercel.json`.
3. **Keep your own `.env` and `.git`.** Add this line to your existing `.env`:

   ```dotenv
   VITE_APP_URL=https://rcgsynapse.vercel.app
   ```

4. Keep your existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Run `npm install`.

The app uses `VITE_APP_URL` for invitation links and supported Auth redirect addresses. Production builds also fall back to `https://rcgsynapse.vercel.app` if this variable is missing. An invitation should look like `https://rcgsynapse.vercel.app/?invite=...`, even when created from a different deployment. The token stays single-use with its existing seven-day expiry and role/email restrictions. This does not register or reserve a Vercel domain.

## 2. Run the new database migration

In your existing **Supabase -> SQL Editor -> New query**:

1. If `001_synapse.sql` and `003_study_refinements.sql` already succeeded, **do not rerun them**.
2. Open `supabase/migrations/004_reviewer_accounts.sql` locally.
3. Copy its **entire SQL contents**, paste into a new SQL query, and click **Run** once.

It adds saved reviewer drawing data, private account-deletion requests, caller-scoped request/cancellation functions, a fresh-Auth-session cancellation trigger, and service-only cleanup functions. Existing study sets and accounts are preserved. Keep RLS ON, `study-files` private, and `profile-photos` private. Do not expose the private schema through the Data API.

For a brand-new Supabase project, run `001`, then `003`, then `004`, following `SUPABASE_SETUP.md` for the original setup. `002` and `005` are schedule configuration, not table migrations.

## 3. Replace both Edge Functions

These changes require **both** existing functions to be updated:

| Supabase function | File whose full contents go into its Dashboard `index.ts` |
| --- | --- |
| `generate-study` | `supabase/dashboard/generate-study.ts` |
| `cleanup-files` | `supabase/dashboard/cleanup-files.ts` |

For each: **Edge Functions -> function name -> Code -> index.ts**, select all the old code, paste the full matching file, and **Deploy**. Keep gateway **Verify JWT OFF** for both. `generate-study` authenticates users explicitly; `cleanup-files` accepts only the server-side cron secret.

Paste the TypeScript file contents, not a filename, a terminal command, or a short `supabase...` snippet. The dashboard versions contain everything required in one file. If you change the maintainable function source later, regenerate them with `node scripts/bundle-dashboard.mjs` before pasting again.

In **Edge Functions -> Secrets**, set or update:

| Secret | Value |
| --- | --- |
| `ALLOWED_ORIGINS` | `https://rcgsynapse.vercel.app,http://localhost:5173` |
| `GEMINI_API_KEY` | Keep your existing Gemini key |
| `GEMINI_MODEL` | Keep the model you already use |
| `CRON_SECRET` | Keep the existing value that also appears in Supabase Vault |

Origins have no trailing slash. If you test `npm run preview`, add `http://localhost:4173` to `ALLOWED_ORIGINS` and Auth redirect URLs. Add any other exact deployment origin only when needed. `SUPABASE_URL` and server credentials remain server-side; never put a service-role key, cron secret, Gmail app password, or Gemini key in Vercel `VITE_*` variables.

## 4. Update the cleanup schedule

If your hourly cleanup job and Vault secrets were configured previously:

1. Open `supabase/migrations/005_cleanup_interval.sql`.
2. Paste the full SQL into a new Supabase SQL query and run it.
3. It updates the existing **`synapse-cleanup-files`** job to run **every ten minutes**, using the same Vault URL and cron secret. It does not create duplicate secrets or a second job.

If this is your first cleanup setup, first follow `SUPABASE_SETUP.md` to configure `CRON_SECRET` and run the customized `002_cleanup_schedule.sql` once, then run `005`. Never commit an edited script containing your real cron secret.

Check the schedule:

```sql
select jobname, schedule, active
from cron.job
where jobname = 'synapse-cleanup-files';
```

Expected: one active row with `*/10 * * * *`. Invoke `cleanup-files` manually with your existing `x-cron-secret` header once to confirm a successful response. Do not supply that header or secret from the browser frontend.

## 5. Set the production Auth URLs

Open **Authentication -> URL Configuration**:

| Setting | Value |
| --- | --- |
| Site URL | `https://rcgsynapse.vercel.app` |
| Redirect URL | `https://rcgsynapse.vercel.app/` |
| Local redirect URL | `http://localhost:5173/**` |

Keep other URLs you still use. If you need Vercel preview URLs, add the specific preview URL or a wildcard restricted to your own Vercel account/team, not all Vercel sites. [Supabase redirect URL guidance](https://supabase.com/docs/guides/auth/redirect-urls)

Leave **Confirm email ON**, custom Gmail SMTP enabled, and both signup/reset templates using `{{ .Token }}`. Their code-only wording has no fixed digit count. Invitations are application sharing links, so the Create invitation button needs the frontend's `VITE_APP_URL` as well as these Auth settings.

## 6. Push to GitHub

Create an empty GitHub repository for Synapse if you do not already have one. In the local folder containing `package.json`:

- If there is no Git repository yet, run `git init`, then `git branch -M main`.
- If this is your existing Git repository, keep its `.git` and existing remote. Use `git remote -v` to check it.

Review files, then commit:

```bash
git status
git add .
git commit -m "Prepare Synapse 1.3 for Vercel"
```

The included `.gitignore` excludes `.env`, dependency/build folders, and logs. Before committing, confirm that real passwords and server secrets are not in any source file or customized SQL script. If a secret was already committed previously, ignoring the file now does not remove it from Git history; remove it from tracking and rotate that exposed secret.

For a new repository only, replace `YOUR_USERNAME` with your GitHub username before running:

```bash
git remote add origin https://github.com/YOUR_USERNAME/synapse.git
git push -u origin main
```

For an existing remote, run `git push` on your current branch instead. The repository name can be different; use its actual GitHub URL. Commit the editable source, `package-lock.json`, `vercel.json`, and the unedited setup scripts. `dist/` and `node_modules/` are built/installed by Vercel.

## 7. Import into Vercel

1. Sign in to [Vercel](https://vercel.com), choose **Add New -> Project**, and import the GitHub repository.
2. Set the project name to **`rcgsynapse`**. That normally yields `rcgsynapse.vercel.app` if the name/domain is available to your account. If Vercel says it is unavailable, resolve that in the project's Domains settings before distributing invitation links.
3. Framework preset: **Vite**.
4. Root directory: the folder containing `package.json`; leave it at the repository root if the source is there.
5. Build command: **`npm run build`**. Output directory: **`dist`**. Use a supported Node version **22.12+**; Node 24 LTS is also supported by this project's engines.
6. Add these Environment Variables before clicking Deploy:

   | Variable | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | Your existing project's `https://PROJECT_REF.supabase.co` URL |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Your project's public/publishable key |
   | `VITE_APP_URL` | `https://rcgsynapse.vercel.app` |

7. Apply them to Production. For preview builds that should access the same app, configure their environment and allowed origins deliberately too.
8. Click **Deploy**. Check **Settings -> Domains** for the exact assigned address.
9. If you change a `VITE_*` variable later, **redeploy**: Vite embeds it at build time. [Vercel Vite setup](https://vercel.com/docs/frameworks/frontend/vite), [Environment variables](https://vercel.com/docs/environment-variables)

`vercel.json` includes the SPA rewrite to `index.html`, so direct app URLs and invitation links load the app. Vercel hosts the frontend; Supabase hosts the database, Storage, Realtime, Auth, and Edge Functions. Subsequent GitHub pushes trigger a new frontend deployment when the Git integration is enabled. SQL and Supabase Edge Function changes still need to be applied separately.

For reliable video calls across different networks, configure a TURN service. Permanent private paid TURN credentials should not be embedded in a public build; use a backend to issue short-lived credentials. The current call remains a peer mesh with no application participant cap, not an unlimited conferencing server.

## 8. How the new controls work

- The upload heading uses the original serif style. While processing, it reads **Completing the ideas…** and shows the current upload/generation stage.
- Hover over the timer and scroll up/down while stopped or paused. Arrow keys work when the display is focused. Duration ranges from 1 to 180 minutes; reset keeps your choice.
- Open a reviewer. Hover its edges to reveal resize handles and drag; use the maximize button beside Close to fill the available window, then restore it.
- Choose **Edit reviewer**, select text, and use **Highlight** with the color picker, or **Add text annotation** for a written note. Saved notes are visible on hover and in the reviewer's Text annotations section.
- Choose **Draw on reviewer**. Select pen color/thickness and draw directly over the text. **Erase a drawing** removes a clicked stroke; **Undo drawing** removes the latest stroke. Return to text before typing. Finish wording changes before drawing for the best alignment: strokes follow their paragraph anchors, and substantial changes to a paragraph can change their alignment.
- Click **Save reviewer** to persist formatting, highlights, written notes, and strokes for that saved set. Exports preserve highlights/drawings in HTML and printed PDF; plain-text export contains text.

## 9. Account deletion behavior and checks

Under **Your little corner -> Delete account**, users read the scope and type their email before scheduling deletion. The app signs them out; their owned spaces become unavailable while the request is pending. A **new sign-in within 48 hours** cancels the request and restores access. Refreshing an already existing session does not count as a new sign-in.

After the deadline, the cleanup job removes Storage objects through the Storage API, clears dependent application rows, and hard-deletes the Auth user through the server-only Admin API. This includes personal progress/messages, their uploaded or created materials in shared spaces, owned spaces and all of those spaces' contents, memberships, profile photos, and email-bound invitations. Other people's Auth accounts are retained. [Supabase user deletion](https://supabase.com/docs/guides/auth/managing-user-data), [Storage deletion](https://supabase.com/docs/guides/storage/management/delete-objects)

Deletion becomes eligible at 48 hours and normally runs on the next ten-minute job. Backlogs or service errors can delay completion; failed jobs retry. Signing in after the deadline does not cancel a pending/processing deletion. The worker refuses to delete Auth while relevant Storage objects remain. Synapse deletes its live application records; copies already exported by users and provider backups follow their separate retention behavior.

Test with disposable accounts before opening registration:

1. Confirm OTP signup and password reset from the deployed domain.
2. Create an invitation; check that its address begins `https://rcgsynapse.vercel.app/`. Accept it from another account/inbox.
3. Save highlights, a written annotation, and a drawing; close/reopen the reviewer and check each persists. Test resize, maximize/restore, and export.
4. Schedule deletion for a disposable account. Confirm the private request exists using SQL Editor, then sign in before the deadline and confirm it disappears and the data stays.
5. For an accelerated final-deletion test, use SQL Editor to set **only that disposable user's** request timestamps to `requested_at = now() - interval '49 hours'` and `delete_after = now() - interval '1 hour'`, then invoke cleanup. The SQL constraint requires at least 48 hours between them. Confirm the Auth user, profile, relevant Storage objects, owned spaces, and personal progress disappear, while another account's unrelated space remains.

The included local tests verify the policies, cancellation, storage-first deletion ordering, retry behavior, annotation rendering, and timer controls. Live SMTP, hosted triggers/cron, and cross-network calls still require these tests in your actual Supabase/Vercel projects.
