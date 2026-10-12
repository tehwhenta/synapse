# Synapse

A Vue 3 study workspace, designed around your cream, sand, taupe, olive, and warm brown palette.

**Already installed version 1.0? Read [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md) first.** Use the existing Supabase project and run only the new migration, then update both Edge Functions.

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

- Email/password accounts, profile names and private photos, password recovery.
- Subject folders, owner-only space deletion, and material scoping.
- Private PDF, DOCX, PPTX, legacy PPT, image, TXT, and Markdown uploads; 10 MB per file.
- Comprehensive Gemini reviewers, explained terminology, tables and enumerations, worked mathematical solutions, flashcard decks, and mixed practice quizzes.
- Fresh generated sets kept alongside earlier sets, with numbered navigation and editable titles.
- Formatted note editing with a Word-style toolbar, tables, and equations; printable PDF, offline HTML study sheets, plain text, and optional Anki TSV exports.
- Per-user quiz history, saved spaced reviews, focus sessions, and study streaks.
- Single-use share links with viewer/editor roles and optional email restriction.
- Folder chat, member activity, private live presence, and WebRTC video calls for small groups (up to four people).
- Camera/microphone controls and screen sharing.
- Hourly cleanup of expired uploads; generated materials stay in Postgres.
- A browser-local sample mode. Demo progress is separate from real accounts.

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
| `supabase/migrations/001_synapse.sql` | Tables, RLS, grants, RPCs, Storage and Realtime policies |
| `supabase/migrations/002_cleanup_schedule.sql` | Vault-backed cleanup schedule |
| `supabase/migrations/003_study_refinements.sql` | Non-destructive 1.1 upgrade, saved sets, photos, space deletion |
| `supabase/functions/` | Maintainable Edge Function source |
| `supabase/dashboard/` | Single-file functions ready to paste into the Dashboard |
| `supabase/functions/generate-study/prompts.ts` | Comprehensive reviewer and math-tutor instructions |
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
- Raw uploads expire after 24 hours; the hourly job usually removes them within about 25 hours. Each job handles up to 200 objects. Extra backlog is cleared on later runs. Text assets, metadata, and progress are retained.
- The app limits AI work to 20 claims per user per UTC day. Provider quotas/costs still apply. This cap includes failed provider attempts after a claim.
- Initial fetches are bounded; use the Load more control to retrieve older folder materials and older uploads. Progress history shows the most recent 365 attempts/sessions, while dashboard totals and streaks are calculated over your full history. Search filters the loaded materials; load older pages to include them.
- Four-person calls use a peer mesh. Connectivity is not guaranteed with STUN alone. Add a TURN service for restrictive networks; relay service may have a cost. For public deployment, issue short-lived TURN credentials from a backend rather than embedding permanent paid credentials.
- Supabase Realtime authorization is cached for an established connection. The normal app refreshes/disconnects after membership changes, while database access is immediately enforced by RLS. Do not rely on an existing WebSocket being instantly revoked server-side.
- Generated materials can contain mistakes. Important information should be checked against the uploaded source.
- Refreshed materials use retained source text after raw-file cleanup. A still-available PDF/image is preferred when refreshing it. Each material type refreshes independently; the five most recent sets supply prompts to avoid exact repeated questions. Provider results can vary and duplicate rejection preserves your old sets.
- Profile photos are private JPG/PNG/WebP files up to 2 MB. Shared study peers can view the current photo through temporary signed links.
- Space deletion removes the space's records and all members' related progress immediately. Remaining raw objects are queued for Storage API cleanup by the existing hourly job.

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
