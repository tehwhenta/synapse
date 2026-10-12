> Historical upgrade guide. The current 1.7 workflow supersedes topic selection and Seeds. See [AUTOMATIC_GENERATION_SETUP.md](AUTOMATIC_GENERATION_SETUP.md). Earlier database migrations are still required prerequisites.

# Synapse 1.6 — Seeds, custom cards, and shared-space joining

This upgrade replaces the 1.5 generation counters with 30 daily Seeds and finite source-concept coverage. It also adds individual custom-card editing/deletion, link/code joining, clearer generation buttons, a distinct lounge icon, and browser zoom support.

## 1. Update your local project

Stop Vite with Ctrl+C. Extract `Synapse_Seeds_Update.zip`, open its `Synapse_Project` folder, and merge the contents into your existing project. Choose **Replace files in the destination** and add the new files. Keep your own `.env` and `.git` folder; neither is in the patch.

The patch includes changed frontend files, the generation function source and Dashboard bundle, migration `009`, both package files, scripts, tests, and this guide. There are no new npm dependencies. Replace `package.json` and `package-lock.json` together.

## 2. Run migration 009 in Supabase

Use the same project already connected to your app.

1. Ensure earlier migrations through **`008_guided_generation.sql`** succeeded. If you have not installed 1.5, complete that database setup first; do not rerun successful migrations.
2. Open **Supabase → SQL Editor → New query**.
3. Open **`supabase/migrations/009_seeds_and_custom_cards.sql`** on your computer.
4. Copy the entire SQL file, paste it into SQL Editor, and click **Run** once.
5. Wait for success before proceeding. The script is transactional: a failed run rolls back. Do not run it again after success.

Keep **RLS ON** and both Storage buckets private. Do not create permissive policies. The migration adds private Seed accounting and concept/coverage tables, identifies existing custom decks, adds stable IDs to custom cards, and adds authorized card-edit/delete operations. It preserves existing generated sets and their study progress.

Existing source scans are marked for one updated scan to build a finite concept inventory. Existing study content is supplied to that scan so the AI can recognize already-covered concepts. Source scans and existing output are retained; no existing set is silently replaced or deleted.

## 3. Replace generate-study

Do this immediately after migration 009, before deploying the new frontend. The old function cannot produce the new coverage fields required by the database.

1. On your computer, open **`supabase/dashboard/generate-study.ts`** and copy all its code.
2. In Supabase, open **Edge Functions → generate-study → Code → `index.ts`**.
3. Replace all the old code with that complete Dashboard file and click **Deploy**.

Keep the Supabase editor filename **`index.ts`**. Paste the code, not the filename. Do not paste only the smaller `supabase/functions/generate-study/index.ts`; it imports companion modules. The Dashboard file already combines them.

Keep gateway **Verify JWT OFF** for this function; its handler validates the signed-in user and permissions explicitly. **Database RLS stays ON.** These settings serve different purposes.

Keep your existing server-only `GEMINI_API_KEY`, working `GEMINI_MODEL`, and `ALLOWED_ORIGINS` secrets. Include the exact production origin `https://rcgsynapse.vercel.app` and your localhost origin if used. Do not add Gemini or service-role/secret keys to any `VITE_*` variable.

No new Edge Function or midnight cron is needed. The existing ten-minute `cleanup-files` schedule and `admin-maintenance` function can stay in place if already updated for 1.4. Migration 009 extends their existing cleanup RPC to remove old Seed-day records after 60 days; it keeps concept coverage and history until their material/space/account is deleted.

## 4. Install, check, and deploy

In the existing project terminal:

```text
npm install
npm test
npm run build
npm run dev
```

Once local checks and Supabase setup succeed, commit and push your changes to GitHub. A linked Vercel project will rebuild automatically. Keep the existing root `vercel.json`, connection variables, and production `VITE_APP_URL`; the domain remains `https://rcgsynapse.vercel.app`.

## How Seeds work

| Rule | Behavior |
| --- | --- |
| Daily balance | Exactly 30 Seeds per signed-in account each day, including admins. |
| Reset | Midnight **Philippine time (`Asia/Manila`, UTC+8)**, for all users. Unspent Seeds do not carry over. |
| Generation | 1 Seed per accepted Generate request, for a reviewer, flashcard set, or quiz. Initial and later sets cost the same. |
| Failure after starting | The Seed stays spent if the model fails or returns invalid/repeated content. There is no automatic retry that spends another Seed. |
| Blocked request | An invalid quantity, missing permission, covered material/topic, concurrent duplicate request, or empty Seed balance is rejected before charging. |
| Upload/topic scan | Scanning prepares the source inventory; it does not spend a Seed or silently create a set. The initial set costs 1 Seed when Generate is clicked in the dialog. |
| Manual study work | Creating, editing, deleting, renaming, exporting, or studying custom cards uses no Seeds. Editing saved reviewers uses no Seeds. |

The balance appears directly beneath the Pomodoro controls with the custom sprout icon. It refreshes after a generation, when the app regains focus, across tabs in the same browser, and at the server-supplied reset boundary. The database controls the day and balance; changing a device clock or opening another tab does not create extra Seeds. A midnight reset does not depend on a scheduled job.

Seeds are Synapse’s virtual allowance. They do not replace Gemini quotas, API billing, or Supabase plan limits. Provider quota may prevent a successful result even with Seeds remaining. To protect scanning resources, each material can be scanned up to three times and each account can start at most 30 source scans per Philippine calendar day; completed scans are cached.

The previous 5-reviewer, 5-quiz, 10-flashcard, and 20-generation daily caps no longer govern generation. Private historical counters remain for continuity but the app no longer displays them as a currency.

## How concept exhaustion works

The initial scan produces a finite inventory of source-supported learning objectives and facets. The backend assigns stable IDs. A generated question/card must refer to one distinct, currently uncovered ID; it cannot invent an ID or reuse a covered one. A comprehensive reviewer must cover every remaining reviewer concept. Exact prompt copies, strongly similar wording, repeated objectives, wrong quantities, and wrong quiz distributions are rejected before content is saved.

Coverage is tracked **separately for reviewers, flashcards, and quizzes** in the shared space. A complete reviewer therefore does not prevent generating flashcards or a quiz. Once that format’s usable concepts are covered, its Generate action is disabled. When all usable formats are covered, the material is closed to further generation and shows:

> We've covered everything! Try a different topic or material.

Manual totals remain 10, 15, 20, or 30. Requests larger than the remaining inventory are blocked without charging; choose a smaller count or a topic. Topic flashcards shrink to the remaining concepts. Topic quizzes keep exactly equal True/False, Multiple Choice, and Identification quantities, with a total divisible by three. If fewer than three distinct quiz concepts remain, another balanced quiz is unavailable; the app does not pad it with repeats.

Coverage is shared by editors using that material in the same space. It remains after a saved set is deleted and after the same bytes are re-uploaded or renamed. New material bytes or a different space have a separate inventory. Raw uploads still expire after about 24 hours; generated assets, retained extraction, coverage, and history stay saved. Earlier uploads that expired before a byte fingerprint existed cannot be retrospectively identified from the missing file.

The inventory and legacy-coverage mapping are AI assessments, not a mathematical proof that every possible interpretation has been taught. Accuracy still depends on source legibility and model quality. Important content should be checked against the original. This implementation prevents generation beyond its recorded inventory instead of promising unlimited unique output.

## Custom flashcards

Open a custom deck. **Generate** and **Create custom flashcards** are hidden there. Use **Edit card** to change its question and answer, then **Save card**. Use **Delete card** and confirm to remove that individual card.

Editing resets only the changed card’s review schedule for its readers. Deleting a card removes its schedule and keeps the other cards’ schedules attached to the correct remaining cards. Deleting the last card also deletes the empty deck; the confirmation states this explicitly. Viewers can study shared custom cards but cannot edit or delete them. Editor/owner permission is rechecked on the server.

## Shared spaces

Open **Invite a friend**, or **Join a space** if you have no spaces yet. The dialog has a **Join a shared space** box for a pasted invitation link or its code. Choose **Join space** to enter it.

Owners can choose Viewer or Editor and create a link below the join box. **Copy invitation code** copies the code portion for sharing. New invitations have no email restriction and do not send email; they are single-use links/codes that expire in seven days. Previously created email-restricted invitations retain their original restrictions. Joining requires signing into the same Supabase project used by the invitation.

## UI and zoom

Generation buttons read **Generate** without the diamond/sparkle icon. The lounge uses a video icon, while the focus timer keeps its headphones icon. Browser zoom is allowed; viewport restrictions were removed while the responsive grid, navigation breakpoints, bounded reviewer windows, scrolling tables, and large mobile inputs remain.

## Live checks before pushing

1. Sign in and confirm the Seed balance reads 30 on a fresh Philippine day. Generate one real set and confirm it becomes 29; refresh and check again.
2. Use another browser/device for the same account. Confirm a generation uses the shared server balance. At midnight, confirm the balance returns to 30.
3. Generate from a small, readable source until a format is covered. Confirm that another generation is disabled and a direct rejected request does not deduct a Seed. Confirm a reviewer still allows its first deck/quiz.
4. Create a custom deck, edit one card, and delete one. Verify neighboring cards and their progress. Check a Viewer account cannot mutate shared cards.
5. Paste both a valid invitation link and a separate fresh invitation code. Each invitation is single-use, so use a newly created invitation for the second check.
6. Test Chrome at 80%, 100%, 125%, 150%, and 200% zoom. Check sidebar/menu behavior, timer/Seeds, the generation dialog, tables, and custom-card inputs; also check on a physical phone.

Automated checks cover Seeds, midnight boundaries, permissions, coverage, saved-set/re-upload retention, card progress remapping, join parsing, generation controls, and the existing app flows. Your live Supabase/Gemini setup and physical browser rendering still need the checks above; browser visual testing was unavailable in the build environment.
