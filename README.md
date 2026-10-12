# Synapse

A Vue 3 study workspace, designed around your cream, sand, taupe, olive, and warm brown palette.

**Already installed Synapse? Start with [SEEDS_UPDATE.md](SEEDS_UPDATE.md) for version 1.6.** Apply migration `009` after earlier migrations, then redeploy `generate-study`. For GitHub/Vercel use [VERCEL_SUPABASE_DEPLOY.md](VERCEL_SUPABASE_DEPLOY.md). Gmail SMTP and email-code configuration remains in [GMAIL_SMTP_OTP_SETUP.md](GMAIL_SMTP_OTP_SETUP.md).

## Start here

1. Read **SUPABASE_SETUP.md** and complete the steps in order.
2. Install Node.js **22.12 or newer** (Node 24 LTS also works).
3. Open a terminal in this extracted project folder.
4. Run `npm install`, then `npm run dev`.
5. Open **http://localhost:5173** in Chrome or Edge.
6. Click **Sample workspace → Connect workspace** and enter your Supabase project URL and publishable key. Alternatively, use `.env` as described in the setup guide.
7. Create your account. Your real workspace begins empty; sample materials are never inserted into your database.

On Windows, `start.bat` installs dependencies if needed and starts the same development server. Keep its terminal window open. Press Ctrl+C to stop it.

## Included

- Email/password accounts, OTP signup confirmation and password recovery, resend cooldowns, profile names and private photos.
- Subject folders, owner-only space deletion, and material scoping.
- Private PDF, DOCX, PPTX, legacy PPT, image, TXT, and Markdown uploads; 20 MB per file.
- Comprehensive Gemini reviewers, explained terminology, tables and enumerations, worked mathematical solutions, flashcard decks, and mixed practice quizzes.
- Fresh generated sets kept alongside earlier sets, with numbered navigation and editable titles.
- Scanned topics and guided manual/topic generation; 30 daily Seeds per account, resetting at midnight Philippine time, and finite per-format concept coverage.
- Custom flashcard decks with individual question/answer editing and deletion, no AI usage; continuous highlighting, sticky reviewer tools, and drawings above text/tables.
- Formatted note editing with a Word-style toolbar, tables, and equations; printable PDF, offline HTML study sheets, plain text, and optional Anki TSV exports.
- Resizable/maximizable reviewer windows, colored highlights, written text annotations, and freehand drawing with pen thickness/color and stroke erasing. Annotations are saved per set and included in formatted exports.
- Account deletion from profile settings, with a 48-hour sign-in cancellation period and storage-first server cleanup.
- Per-user quiz history, saved spaced reviews, focus sessions, and study streaks.
- Adjustable focus timer: hover over the time and scroll, or use arrow keys when focused. Pause before adjusting an active countdown; reset keeps the chosen duration.
- Single-use share links with viewer/editor roles and optional email restriction.
- Folder chat, live/away/offline private presence, and WebRTC video calls without an application participant cap.
- Camera/microphone controls and screen sharing.
- Responsive paginated call tiles, separate audio for all peers, and adaptive camera quality; screen sharing is shown full-width.
- Original-file expiry warnings and scheduled cleanup; generated materials stay in Postgres unless their space/account is deliberately deleted.
- Animated flashcards with labeled question/answer sides and reduced-motion support.
- A browser-local sample mode. Demo progress is separate from real accounts.
- Server-protected System care for the confirmed admin account: usage estimates, immediate bounded cleanup, and reviewed inactive-account removal with seven-day recovery and protection of actively shared study spaces.
- Online/Away aggregation across devices, reconnect/page restoration handling, low-frequency activity writes, and profile-photo link reuse.
- Accessible password visibility controls, gentle navigation transitions with reduced-motion support, and mobile layouts that wrap long names, tables, toolbars, and controls.

## Technical structure

| Location | Purpose |
| --- | --- |
| `src/App.vue` | Responsive workspace, navigation, upload and sharing dialogs |
| `src/stores/auth.js` | Authentication and recovery |
| `src/stores/workspace.js` | Data operations, per-folder sync, progress |
| `src/components/StudyViewer.vue` | Reviewer, flashcards, quizzes, exports |
| `src/components/RichEditor.vue` | Formatted reviewer editing with Tiptap and math nodes |
| `src/components/Avatar.vue` | Private profile photos via signed URLs |
| `src/lib/richText.js` | Safe Markdown/HTML conversion and text extraction |
| `src/lib/studyRendering.js` | Math rendering and printable study sheets |
| `src/components/StudyRoom.vue` | Private presence, chat, WebRTC mesh calls |
| `src/lib/documents.js` | Browser Office text extraction and upload validation |
| `src/lib/sourceFiles.js` | Original-file expiry states |
| `src/lib/lounge.js` | Presence deduplication/freshness and call quality settings |
| `supabase/migrations/001_synapse.sql` | Tables, RLS, grants, RPCs, Storage and Realtime policies |
| `supabase/migrations/002_cleanup_schedule.sql` | Vault-backed cleanup schedule |
| `supabase/migrations/003_study_refinements.sql` | Non-destructive 1.1 upgrade, saved sets, photos, space deletion |
| `supabase/functions/` | Maintainable Edge Function source |
| `supabase/dashboard/` | Single-file functions ready to paste into the Dashboard |
| `supabase/functions/generate-study/prompts.ts` | Comprehensive reviewer and math-tutor instructions |
| `supabase/templates/` | OTP signup/recovery email HTML for Supabase |
| `GMAIL_SMTP_OTP_SETUP.md` | Exact Gmail SMTP and hosted Auth configuration |
| `VERCEL_SUPABASE_DEPLOY.md` | Production URL, GitHub/Vercel steps, new migrations and deletion job |
| `supabase/migrations/004_reviewer_accounts.sql` | Drawing data and private 48-hour deletion lifecycle |
| `supabase/migrations/005_cleanup_interval.sql` | Update the existing cleanup job to every ten minutes |
| `supabase/migrations/006_system_maintenance.sql` | UUID-bound admin roles, throttled activity, inactive recovery, maintenance totals and worker leases |
| `src/components/AdminPanel.vue` | System care usage and reviewed cleanup controls |
| `supabase/functions/admin-maintenance/` | Authenticated, server-authorized manual cleanup |
| `ADMIN_AND_READINESS.md` | Exact 1.4 setup, admin role verification, free-plan references and live checks |
| `SEEDS_UPDATE.md` | Current 1.6 upgrade: Seeds, concept exhaustion, custom card edits, invitations and zoom |
| `supabase/migrations/009_seeds_and_custom_cards.sql` | Server-owned daily Seeds, coverage inventory, stable card IDs and authorized mutations |
| `GUIDED_GENERATION_SETUP.md` | Exact 1.5 local replacement, Supabase migration/function, limits, and live checks |
| `supabase/migrations/008_guided_generation.sql` | Source records, 20 MB cap, topic metadata, generation limits and retained duplicate history |
| `tests/` | PostgreSQL policy tests, AI validation/auth tests, sample-state workflows |

Notes, decks, and quizzes share `study_assets`, with `kind = note/deck/quiz`. Each generated family uses a `series_id` and each saved version has a `set_number`. New versions use new asset IDs, preserving earlier progress. Notes use `content_format = markdown/html`; existing Markdown becomes editable formatted HTML when saved through the editor. Progress is separate per user and set.

## Commands

```text
npm install
npm run dev
npm run build
npm run preview
npm test
```

`npm run build` creates `dist/`. `npm run preview` serves the built version at http://localhost:4173; add that origin to Supabase Auth redirects and ALLOWED_ORIGINS if you use it with real data.

If you edit the Edge Function source and deploy through the Dashboard, first run:

```text
node scripts/bundle-dashboard.mjs
```

Then paste the updated files from `supabase/dashboard/`.

## Practical limits

- PDF and images go to Gemini for multimodal reading/OCR. Office formats extract text in your browser; embedded diagrams and image-only slides require PDF export. Legacy PPT extraction covers text records; convert encrypted or unusual PPT files to PPTX/PDF.
- Quiz explanations are generated with the materials. Short-answer grading compares normalized expected answers and accepted synonyms; it does not make a new semantic-grading API call per answer.
- Raw uploads expire after 24 hours; the updated ten-minute job normally removes them on its next run. Each run handles up to 200 expired files; backlogs clear on later runs. Text assets, metadata, and progress are retained.
- The app limits AI work to 30 daily Seeds per user, resetting at midnight Asia/Manila. A started generation uses 1 Seed; scanning and custom cards do not spend Seeds. Provider quotas/costs still apply. Source scans have separate frequency protection; completed scans are cached. Finite concept coverage blocks redundant generation before charging.
- Initial fetches are bounded; use the Load more control to retrieve older folder materials and older uploads. Progress history shows the most recent 365 attempts/sessions, while dashboard totals and streaks are calculated over your full history. Search filters the loaded materials; load older pages to include them.
- Calls use a peer mesh with no application-level participant cap. The 12 visible tiles per page are a layout/performance choice, not a call cap; off-page peers keep their audio. Large groups still face device/network and Realtime-plan limits. Use an SFU conferencing service for large production meetings. Connectivity is not guaranteed with STUN alone. Add TURN for restrictive networks; issue short-lived TURN credentials from a backend for public deployment rather than embedding permanent paid credentials.
- Supabase Realtime authorization is cached for an established connection. The normal app refreshes/disconnects after membership changes, while database access is immediately enforced by RLS. Do not rely on an existing WebSocket being instantly revoked server-side.
- Generated materials can contain mistakes. Important information should be checked against the uploaded source.
- Gmail SMTP replaces the built-in email sender, but Gmail and Supabase rate limits still apply. Use the setup guide's app-password instructions and enable Confirm email; changing templates does not by itself implement code entry.
- Refreshed materials use retained source text after raw-file cleanup. A still-available PDF/image is preferred when refreshing it. Each material type generates independently through manual parameters or a scanned topic. All retained question history supplies duplicate checks; counts and history survive set deletion. Similar wording and repeated learning objectives are rejected. A small source may run out of fresh content before its numeric cap; no AI system can promise absolute semantic uniqueness.
- Profile photos are private JPG/PNG/WebP files up to 2 MB. Shared study peers can view the current photo through temporary signed links.
- Space deletion removes the space's records and all members' related progress immediately. Remaining raw objects are queued for Storage API cleanup by the scheduled job.
- Account deletion is opt-in. New sign-in within 48 hours cancels it; after the deadline cleanup removes the Auth account, owned spaces, authored/uploaded shared materials, profile/photos, memberships, progress, and messages. Other Auth accounts remain. Cleanup retries storage/provider errors. Already exported copies and provider backups have separate retention.
- Drawings follow paragraph anchors. Large text edits or substantial paragraph reflow can change alignment, so finish wording before drawing. HTML/print exports preserve drawings and highlights; plain-text export contains text.

The production build and local automated tests can be verified without your credentials. Real Supabase auth, provider calls, scheduled jobs, and cross-device calls require the setup below and an actual project. Browser/device QA should be completed before public release.

## Palette

| Color | Hex |
| --- | --- |
| Cream | `#D9D5CC` |
| Sand | `#BEB089` |
| Taupe | `#ACA086` |
| Olive | `#8C8D65` |
| Warm brown | `#9F7C60` |

These values were sampled from your uploaded swatches. Lighter backgrounds and darker olive text are added for legibility.
