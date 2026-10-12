# Synapse 1.4: admin setup and deployment checks

This upgrade improves live status, mobile layouts, navigation, password visibility, and maintenance. Use your existing Supabase project and accounts. Applying the upgrade does not select or remove inactive accounts.

## 1. Copy the updated project files

1. Stop the development server with Ctrl+C and extract the new ZIP.
2. Replace `src/`, `supabase/`, `scripts/`, and `tests/` in your existing project. Copy `package.json`, `package-lock.json`, `vercel.json`, `.gitignore`, `.env.example`, and the updated Markdown guides.
3. Keep your existing `.env` and `.git`. Keep your actual Supabase URL/publishable key and `VITE_APP_URL=https://rcgsynapse.vercel.app`.
4. Run `npm install`, `npm test`, and `npm run build` in the folder containing `package.json`.

There are no new npm dependencies for this upgrade. Both package files identify version **1.4.0**. New database and function code must be applied separately; uploading the `supabase/` folder to GitHub does not deploy it to Supabase.

## 2. Run migration 006

In **Supabase → SQL Editor → New query**, paste the entire contents of:

```text
supabase/migrations/006_system_maintenance.sql
```

Click **Run** once. Successful `001`, `003`, and `004` must already be applied; do not rerun them. For a new project, run `001`, `003`, `004`, then `006`. `002` and `005` configure the scheduled worker; they are separate from the table migrations.

Keep **RLS enabled**, `study-files` and `profile-photos` private, and the `private` schema unexposed in the Data API. The admin does not get direct access to everyone's study content. Admin RPCs return maintenance totals, eligible accounts, and cleanup state; each checks the authenticated user's role on the server.

The migration adds `last_active_at` using existing account dates. Activity is updated with server time, at most once every five minutes per account, and normal dormant tabs do not count as continued app use. Live online status still comes from Realtime Presence, not this database timestamp.

## 3. Make your confirmed Gmail account the admin

If **rcgsynapse@gmail.com** already exists in Synapse and has confirmed its email, migration `006` grants its current user UUID the admin role. This is your **Synapse application admin**, separate from your Supabase Dashboard/GitHub permissions or SMTP credentials.

If the account was created or confirmed after running `006`, paste and run the entire contents of:

```text
supabase/admin/grant_admin.sql
```

Verify in SQL Editor:

```sql
select a.user_id, u.email, u.email_confirmed_at
from private.app_admins a
join auth.users u on u.id = a.user_id;
```

Then sign out and sign back into **rcgsynapse@gmail.com**. **System care** appears in the sidebar. Ordinary accounts and the sample workspace do not have it. The role is stored against the verified account's UUID; setting a profile field, changing an email, or recreating an account with the same email does not gain admin access. To transfer the role, the Supabase project owner must grant the new confirmed account's UUID and remove the old UUID in `private.app_admins`. Admin accounts are protected from app deletion until that role is removed.

## 4. Update cleanup and add the admin Edge Function

In **Edge Functions**, apply this mapping:

| Action | Function name | Paste this entire file into Dashboard `index.ts` |
| --- | --- | --- |
| Replace existing code and deploy | `cleanup-files` | `supabase/dashboard/cleanup-files.ts` |
| Create a new function, replace starter code, and deploy | `admin-maintenance` | `supabase/dashboard/admin-maintenance.ts` |

Set the gateway **Verify JWT OFF** for these functions. The scheduled function verifies `x-cron-secret`; the admin function explicitly validates the caller's Supabase Auth token with `getUser` and then checks the private role using the server client. Disabling the gateway does not make admin actions public. Keep existing `generate-study` code from 1.3; it was not changed by this upgrade.

Use your existing Edge Function secrets:

```text
ALLOWED_ORIGINS=https://rcgsynapse.vercel.app,http://localhost:5173
CRON_SECRET=your existing server-only value
```

Keep `CRON_SECRET` identical to the value already in Vault. Server credentials are provided by Supabase; no admin, service-role, Gemini, SMTP, or cron secret belongs in a frontend `VITE_*` variable. The admin button uses the signed-in user's normal access token and never uses the cron secret. If you use a different deployed domain, update the exact allowed origin and `VITE_APP_URL` accordingly.

CLI users can deploy with:

```text
supabase functions deploy cleanup-files --no-verify-jwt
supabase functions deploy admin-maintenance --no-verify-jwt
```

The bundled Dashboard files are generated with `node scripts/bundle-dashboard.mjs` if you later edit the maintainable function files.

## 5. Check the existing schedule

Run:

```sql
select jobname, schedule, active
from cron.job
where jobname = 'synapse-cleanup-files';
```

Expected: one active job with `*/10 * * * *`. If you still have the hourly schedule, run the included `005_cleanup_interval.sql`. If no job exists, follow the Vault/cron setup in `SUPABASE_SETUP.md`, then apply `005`. Do not create a second cleanup job or replace your Vault secrets unnecessarily.

The same worker serves cron and **Run cleanup now**. A lease prevents overlapping runs; a recently started run returns a retry message. Cleanup is bounded, preserves live account rows when Storage fails, and continues remaining work on later runs. Check Edge Function logs if System care reports failures.

## What the admin can do

- View account/material/space counts, database size, estimated stored-file bytes, pending removals, and the last cleanup outcome.
- Run the existing cleanup immediately for expired original uploads and files from deleted spaces. Saved study materials stay unless their account or space is deliberately being deleted.
- Remove old expired invitations (30 days after expiry), daily AI usage rows older than 60 days, unused activity records older than 90 days, completed/failed refresh-job records older than 30 days, and maintenance audit entries older than 180 days. These bounded technical cleanups preserve study content, messages, progress, and source metadata.
- Review accounts unused for **90, 180, or 365 days**, select up to 25, inspect their owned-space/material counts, type **DELETE**, and schedule a **7-day recovery window**. The server rechecks eligibility. Users becoming active before the deadline are skipped/cancelled; admins are protected.
- Cancel an inactive-account request while its recovery window is still open. Users' own 48-hour deletion requests keep their original deadline and cannot be cancelled through this admin control.

Inactive cleanup protects accounts whose spaces, uploads, or authored materials are shared with another person active in the last 30 days. This is checked when listing, scheduling, and before claiming a pending removal. If a collaborator returns before a worker claims the account, the inactive request is cancelled. A removal that has already started cannot be cancelled. Self-requested deletion retains its existing, explicitly confirmed full-deletion scope.

After an inactive recovery window ends, the scheduled worker removes the account's Storage objects through the Storage API before removing relational records and the Auth account. Scope includes profile photos, uploads, authored materials in shared spaces, owned spaces and their contents, messages, memberships, and personal progress. This is permanent. Cleanup does not select inactive accounts automatically or delete recently active users. A user-visible explanation is available under **Your little corner → Account retention**. Email notices are not sent by this feature.

## Understanding the free plan

Supabase's published Free plan includes **50,000 monthly active users**, **500 MB database size**, **1 GB file storage**, **5 GB uncached egress**, **5 GB cached egress**, and **200 peak Realtime connections**. Total registered Auth users are listed as unlimited; old registrations alone do not consume the monthly-active-user allowance. Data size and concurrent usage matter. These are reference values checked on 12 October 2026, not quotas the app can change.

[Supabase pricing](https://supabase.com/pricing) · [Realtime limits](https://supabase.com/docs/guides/realtime/limits)

System care's byte totals are estimates, not Supabase's billing meter. Use **Open Supabase → Usage** for official bandwidth, monthly-active-user, and Realtime usage. Deleting rows normally makes database space reusable; it does not promise an immediate reduction in the allocated database size, or reset bandwidth/active-user usage already incurred. Gemini usage limits also remain in effect. Free projects can be paused after a week of inactivity; maintenance is not a guarantee of uninterrupted hosting.

Presence uses one Supabase client connection per tab, private space channels, a 45-second heartbeat, and a 150-second stale-session window. Away means the page is hidden or has no input for about five minutes, unless a call is active. Disconnects clear presence immediately when detected; a suspended/abruptly disconnected browser can remain visible until heartbeat expiry/server disconnect detection. Multi-device states merge into one person; a connected foreground device keeps the person online. Other channels multiplex over the same tab's connection, not one extra connection per channel. Accounts not in the current space's presence channel are not claimed to be globally online.

Calls have no application participant cap, but use a WebRTC peer mesh. Browser/network load increases with participants; pagination and adaptive camera quality cannot make very large rooms unlimited. Reliable calls across restrictive networks need a TURN relay; large-group conferencing needs an SFU/service rather than only a larger video grid.

## Final deployment checks

1. Apply SQL and deploy the two functions **before** pushing the new frontend. Keep your production Auth Site URL, allowed origins, OTP templates, Gmail SMTP, and Vercel environment variables from `VERCEL_SUPABASE_DEPLOY.md`.
2. Confirm the admin can open System care and see totals. Confirm a normal account has no admin navigation and cannot call admin RPCs/functions successfully.
3. Use disposable accounts to test inactive scheduling, cancellation by returning, and worker removal. Backdate **only disposable accounts** in SQL Editor to simulate inactivity; never shorten a real user's recovery window. Test the existing self-deletion cancellation separately.
4. In two browsers/devices, open the same space. Check one online person per account, Away after hiding a tab, Online after returning, offline network behavior, and sign-out. Refocusing a tab or refreshing its Auth token must not reset your workspace or end a call.
5. On actual phones, check widths around **320, 360, 390, and 430 px**, portrait/landscape, long names/titles, keyboard-open chat, the sidebar, profile dialogs, reviewer tables/equations, flashcard flips, and call controls. Inputs use 16 px text to avoid unwanted iOS input zoom. Small phones use one material card per row; calls still show paged video tiles.
6. Check signup/reset OTPs, password-eye controls, invitation acceptance, generation, title editing, annotations, exports, timer customization, and refresh of an existing app URL.
7. Run `npm test` and `npm run build`, commit source files and the lockfile, then push. Vercel builds `dist`; the included `vercel.json` keeps direct/refreshed URLs working.

Local tests exercise real PostgreSQL policies with a local engine, component interactions, mocked Auth/Realtime/Edge APIs, presence aggregation, and Storage-first deletion ordering. The production build is checked. Real-device visual layout and your hosted SMTP, cron, Supabase limits, and cross-network calls require the live checks above; this build environment cannot validate those services for your project.
