# Synapse: exact Supabase setup

**Already set up Synapse? Follow [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md) instead.** For version 1.3 and `rcgsynapse.vercel.app`, use [VERCEL_SUPABASE_DEPLOY.md](VERCEL_SUPABASE_DEPLOY.md). Do not rerun successful `001` or `003` migrations; run the new `004`, update both functions, and update the existing schedule with `005`.

Complete these steps once for your new project. Use the Dashboard route below; the CLI alternative at the end does the same deployments. Do not use both deployment routes unless updating a function.

## 1. Create the project

1. Open https://supabase.com/dashboard and select **New project**.
2. Choose your organization.
3. Name it **Synapse**.
4. Generate a strong database password and keep it in your password manager. You will not put this password in the Vue app.
5. Choose an available region close to your users, such as Singapore for the Philippines.
6. Create the project and wait until it is ready.
7. The project reference is the identifier in the project Dashboard URL. Save it for the project URL and optional CLI commands.

## 2. Run the database script

1. Open **SQL Editor → New query**.
2. Open `supabase/migrations/001_synapse.sql` from this project in VS Code or a text editor.
3. Copy the entire file into SQL Editor.
4. Click **Run**.
5. Confirm the query succeeds before proceeding.
6. Open another new query, paste the entire contents of `supabase/migrations/003_study_refinements.sql`, and click **Run** once. This adds the current saved-set, photo, and space-deletion features.
7. In another new query, run `supabase/migrations/004_reviewer_accounts.sql` once. It adds reviewer drawings and the 48-hour account deletion lifecycle. After the cleanup job's original Vault setup below, use `005_cleanup_interval.sql` to update it to every ten minutes.

Run it once in a new project. It uses a transaction: a failed run rolls back the whole script. If it succeeded, do not run it again. It does not wipe existing tables to make re-runs appear successful.

The script creates all application tables, profile signup trigger, owner/viewer/editor policies, private upload bucket, invitation and study RPCs, indexes, and Realtime publication entries. You do not need to manually create tables or turn off RLS.

Check **Table Editor** for `profiles`, `folders`, `folder_members`, `folder_invitations`, `document_files`, `study_assets`, `quiz_attempts`, `flashcard_progress`, `study_sessions`, `activity_events`, and `study_messages`.

Check **Storage** for `study-files` and `profile-photos`. Leave both **private**. Their limits are 10 MB for study files and 2 MB for JPG/PNG/WebP profile photos; SQL sets the MIME restrictions and policies.

## 3. Configure Authentication

1. Open **Authentication → Sign In / Providers → Email** (some Dashboard versions call this **Providers**).
2. Ensure email/password sign-in is enabled and new user signups are allowed.
3. Keep **Confirm email ON** for OTP confirmation. Turning it OFF skips email ownership verification and the signup code screen.
4. Complete **[GMAIL_SMTP_OTP_SETUP.md](GMAIL_SMTP_OTP_SETUP.md)** to connect Gmail using a Google app password, configure Auth sending limits, and replace both email templates with `supabase/templates/confirm-signup.html` and `supabase/templates/reset-password.html`. They use `{{ .Token }}` instead of an auth link. The default Supabase email sender is for limited testing; recovery requires working email delivery too.
5. Open **Authentication → URL Configuration**.
6. Set **Site URL** to `http://localhost:5173` while working locally.
7. Add these **Redirect URLs**:

```text
http://localhost:5173/**
https://synapse-study-ralph.ivoryseed1.chatgpt.site/**
```

8. Save. If you later publish to your own Vercel/Netlify domain, add `https://YOUR_DOMAIN/**` and set Site URL to that domain.

The local `supabase/config.toml` template entries affect CLI development only. They do not change email templates or SMTP settings in a hosted Supabase project; use the Dashboard steps above.

The supplied private preview is accessible to you. To invite friends into a live app, publish your own frontend domain as described in step 10. A link to your localhost only works on your computer; it does not host the app for friends.

## 4. Configure Realtime

1. Open **Realtime → Settings**.
2. Turn **Allow public access OFF**. The study lounge uses authenticated private channels.
3. Save.
4. The SQL script already adds `folders`, `folder_members`, `study_assets`, `document_files`, `activity_events`, and `study_messages` to `supabase_realtime`.
5. If you want to verify, run:

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
```

Do not add `ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY`. Supabase already owns/enables RLS on that table; the script only creates the allowed policies.

## 5. Add server-side secrets

1. Obtain a Gemini API key from https://aistudio.google.com/apikey.
2. Open **Edge Functions → Secrets** in your Supabase project.
3. Add the following values and save:

| Name | Exact value / what to enter |
| --- | --- |
| `GEMINI_API_KEY` | Your actual Google AI Studio API key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `ALLOWED_ORIGINS` | `http://localhost:5173,https://synapse-study-ralph.ivoryseed1.chatgpt.site` |
| `CRON_SECRET` | A random 64-character hex string you generate below |

Generate CRON_SECRET in a terminal on your computer:

```text
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output into Supabase Secrets. Keep the same value for step 7. Do not place it in `.env`, source control, browser forms, or client code.

The Edge Functions use the automatically supplied `SUPABASE_URL` and backend key. You do not need to manually add those reserved secrets. They support Supabase's existing service-role environment key and the newer named secret-key map.

Gemini access, quotas, and billing depend on your Google project. Synapse does not promise a free or unlimited AI API. If the chosen model is unavailable to your key, use a current text/multimodal model supporting JSON output in `GEMINI_MODEL`; the function reports a provider configuration error instead of inventing results.

## 6. Deploy the two Edge Functions using the Dashboard

### Function A: generate-study

1. Open **Edge Functions**.
2. Choose **Deploy a new function → Via Editor** (wording may also say **Create function**).
3. Name the function exactly **generate-study**.
4. Replace the editor's starter `index.ts` with the entire content of `supabase/dashboard/generate-study.ts`.
5. Deploy it.
6. Open this function's **Details / Configuration** and turn **Verify JWT** (sometimes labeled **Enforce JWT verification**) **OFF**. Save/update the function settings.

The single-file Dashboard version includes the validator. Do not paste only `supabase/functions/generate-study/index.ts` into a one-file editor: its companion validation import would be missing.

Disabling the gateway JWT option does not make this handler unauthenticated. The handler explicitly verifies the user's access token with Supabase Auth, then the database requires editor/owner permission before an AI job can be claimed. This works with current signing keys without relying on the legacy gateway JWT path.

### Function B: cleanup-files

1. Deploy another function named exactly **cleanup-files**.
2. Replace `index.ts` with the entire content of `supabase/dashboard/cleanup-files.ts`.
3. Deploy.
4. Turn its **Verify JWT / Enforce JWT verification OFF** and save.

This handler accepts only the private `x-cron-secret` header matching CRON_SECRET. It cannot be run by an ordinary browser user or by the publishable key alone.

If the Dashboard does not expose the JWT toggle, use the CLI deployment commands at the end with `--no-verify-jwt`.

## 7. Enable automatic upload cleanup

1. Open `supabase/migrations/002_cleanup_schedule.sql` in your text editor.
2. Replace `https://YOUR_PROJECT_REF.supabase.co` with your real project URL.
3. Replace `REPLACE_WITH_THE_SAME_CRON_SECRET` with the exact CRON_SECRET from step 5.
4. Copy this edited text into a **new SQL Editor query** and run it once.
5. Do not commit the edited copy containing your secret. The untouched project file has safe placeholders.
6. The script enables pg_cron/pg_net, creates two Vault secrets, and schedules cleanup every hour at minute 17 UTC.

Verify the job:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'synapse-cleanup-files';
```

To test the function immediately without waiting:

```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='synapse_project_url') || '/functions/v1/cleanup-files',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='synapse_cron_secret')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 100000
);
```

This returns an asynchronous request ID, not the function response. Check **Edge Functions → cleanup-files → Logs** for the invocation, or inspect the newest response:

```sql
select id, status_code, content, error_msg
from net._http_response
order by id desc
limit 5;
```

No expired files yet is normal. To test expiry, upload a disposable test document, set only that row's `expires_at` to a past timestamp in Table Editor, and invoke cleanup again. Confirm the Storage object disappears, its `purged_at` is populated, and its generated study assets still exist.

If you need to change the cron secret later, update the existing Vault secret using `vault.update_secret` with its ID; do not create duplicate secrets with the same name. `cron.schedule` with the same job name replaces its schedule, but the Vault-create statements in this script should only run once.

## 8. Copy the public connection values

1. Open **Project Settings → API Keys**.
2. Copy the **publishable** key beginning with `sb_publishable_`. A legacy **anon** key also works.
3. Copy the **Project URL** from the project's **Connect** dialog or **Settings → Data API / API**: `https://PROJECT_REF.supabase.co`.
4. Never copy a secret key (`sb_secret_`), service_role key, database password, Gemini key, or CRON_SECRET into the Vue app.

You can connect in either of these ways:

**A. Browser form:** open the app, click **Sample workspace → Connect workspace**, paste the project URL and publishable key, and click **Connect & reload**. These public values are stored only on that browser. This works on the supplied private preview too.

**B. Environment file:** copy `.env.example` to `.env` in the project root, then edit:

```env
VITE_SUPABASE_URL=https://YOUR_REAL_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_REAL_KEY
```

Save it. Restart `npm run dev` if it was already running. Environment values are bundled at build time for deployment. If you have both a valid `.env` connection and a browser-saved connection, the `.env` values take precedence.

## 9. Run and test locally

In the extracted project folder:

```text
npm install
npm run dev
```

Open **http://localhost:5173**. Do not open `index.html` by double-clicking; Vue imports need the development server or a built deployment.

1. Create your account. Confirm its email if confirmation is enabled.
2. Create a study space, for example **Data Structures**.
3. Write a blank note and save it. Refresh; it should still be there.
4. Upload a small text file or PDF with real course content. TXT/MD should contain at least 20 characters.
5. Wait for a reviewer, deck, and quiz to appear. In Table Editor, the document should become `ready` and have three related `study_assets` rows.
6. Review a flashcard, take a quiz, and complete at least 30 seconds of a focus session, then reset/end it. Progress should persist after refresh.
7. Click **Invite a friend**, select **Viewer**, create the link, and open it in another browser/profile with a different account.
8. A viewer should be able to read, review, take quizzes, chat, and join the lounge, but not edit materials or upload.
9. Change that account's role to **Editor**. After sync/refresh, it can add/edit materials.
10. Open the same folder on two accounts. Test chat, presence, camera, microphone, screen sharing, and leaving the call. For two local browser profiles, both must use the same origin and project.

For a test failure, see the table below before changing database security settings.

## 10. Publish the frontend for friends

The Supabase project hosts your data/functions, not the Vue frontend. Your private preview is for your review. For your friends to access a shared URL:

1. Push the project source to your own Git repository; `.env` is ignored.
2. Import it into Vercel or Netlify as a **Vite** project.
3. Build command: `npm run build`. Output directory: `dist`.
4. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to the host's environment variables.
5. Deploy.
6. Add the deployed domain to **Authentication → URL Configuration → Redirect URLs**; set Site URL to it.
7. Add its exact origin (no trailing slash) to **ALLOWED_ORIGINS** in Supabase Edge Function Secrets, separated by commas from any other active origins.
8. Open the new domain and create fresh invitation links there. Existing localhost invitation links should not be sent to remote friends.

For more reliable calls, optionally fill VITE_TURN_URL, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL in local/test builds using your TURN provider. Permanent frontend TURN credentials are not suitable for a public paid relay; use short-lived server-issued credentials before public deployment.

## CLI alternative for step 6

These commands run from the project root after installing Node. The supplied `supabase/config.toml` already contains the function authentication settings.

```text
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy generate-study --project-ref YOUR_PROJECT_REF --no-verify-jwt --use-api
npx supabase functions deploy cleanup-files --project-ref YOUR_PROJECT_REF --no-verify-jwt --use-api
```

The --use-api flag bundles remotely, so these deployments do not require Docker. Complete SQL, Auth, Realtime, secrets, and cron steps through the Dashboard as above. The project reference is not a key or password. The CLI may prompt you to sign in or enter the database password during linking; enter it in that CLI prompt, not in source files.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| “Profile unavailable” / missing table | Run 001_synapse.sql once and inspect the actual SQL error if it failed. |
| Signup says email not authorized or no email arrives | Configure custom SMTP, or use the explicitly unverified local-testing option in step 3. |
| “Invalid JWT” before your function runs | Ensure the function's gateway Verify JWT toggle is OFF; the handler does its own auth. |
| Generation returns 401 | Sign in again. The public key alone cannot generate materials. |
| “Editor access required” | Select a folder you own or where your role is editor. |
| Raw upload denied | Confirm metadata was inserted, the bucket is private study-files, and RLS policies exist; do not disable RLS. |
| CORS / origin not allowed | ALLOWED_ORIGINS must contain the exact URL origin you are using, including localhost port, without slash. |
| Gemini 403 / 404 / 429 | Check API key, current model access/name, quotas, and Google billing. |
| DOCX/PPTX has no readable text | Export it as PDF; text extraction cannot read embedded image-only slides. |
| Lounge unavailable | Turn Allow public access OFF and check the two realtime.messages policies from 001. |
| Calls fail across devices/networks | Allow microphone/camera, use HTTPS or localhost, and configure TURN for restrictive networks. |
| Raw files are not removed | Verify cleanup deployment, gateway JWT OFF, matching CRON_SECRET/Vault value, active job, and function logs. |
| Everything still looks like a demo | Click Connect workspace or fill .env, reload/restart, then create a real account. |
| “Already processing” | Wait for completion; abandoned claims can be retried after 15 minutes. |
| Port 5173 is busy | Stop the other dev server; this project uses a fixed port so auth/CORS URLs remain consistent. |

## Official references checked for this implementation

- API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Password authentication: https://supabase.com/docs/guides/auth/passwords
- SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Edge Function authentication: https://supabase.com/docs/guides/functions/auth
- Dashboard deployments: https://supabase.com/docs/guides/functions/quickstart-dashboard
- Realtime authorization: https://supabase.com/docs/guides/realtime/authorization
- Scheduled Edge Functions: https://supabase.com/docs/guides/functions/schedule-functions
- Gemini models: https://ai.google.dev/gemini-api/docs/models
- Gemini Generate Content API: https://ai.google.dev/api/generate-content
- WebRTC negotiation: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
