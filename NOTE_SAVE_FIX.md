# Synapse 1.9.1 — note saving and window resizing

The screenshot shows `study_assets_content_check`. The original database limits stored note content to 60,000 characters. Rich text also contains HTML for formatting and tables, so it can reach that limit before the visible text looks particularly long.

This update allows formatted reviewer/note content up to 240,000 stored characters, keeps Markdown's 60,000-character limit, and checks the size before a save request. It never truncates a note. A rejected save keeps the editor open with its title and complete draft. The blank-note window now has Maximize/Restore and draggable edges, matching the reviewer window.

## Apply this fix to your existing 1.9.0 project

1. In **Supabase → SQL Editor → New query**, paste and run the entire file **`supabase/migrations/019_rich_note_capacity.sql`** once. Keep RLS enabled. This replaces only the note-content size constraint; it does not delete or rewrite saved content.
2. If your unsaved note is still open, try **Save note** again after SQL 019 succeeds. This can save it without refreshing your current tab. If it is still rejected, copy the draft somewhere before refreshing; very large notes may need splitting.
3. Extract **`Synapse_Note_Save_Fix.zip`** and merge its `Synapse_Project` contents into `C:\Users\Asus\3D Objects\Synapse_Project`. Replace matching files and add new files. Keep your `.env` and `.git`.
4. Run these commands from your project folder, then commit and push for Vercel deployment:

```sh
npm install
npm test
npm run build
```

After deploying the frontend, reopen **A thought of your own**. Use the Maximize icon beside the close button, or hover an edge and drag. On a small screen, the window remains bounded by the viewport.

**No Edge Function changes, new secrets or dependencies are required for this fix.** SQL 019 assumes `content_format` already exists from migration 003, as it does in the current project. Do not rerun old successful migrations. AI output limits, saved sets, permissions and generation workflows remain unchanged.

## Changed files

The patch's `UPDATED_FILES.md` lists the exact changed paths. Its main application changes are `src/App.vue`, `src/stores/workspace.js` and the new `src/lib/noteContent.js`. Both package files update the project version to 1.9.1.

## Verification

Targeted checks cover the original database failure, the full long-note save, exact Unicode character counts, upper limits, unchanged Markdown limits and RLS, blank-note maximize/restore controls, draft retention after rejection, and existing reviewer controls. The production build is also checked.

This fixes the database error in this screenshot. The earlier **Failed to send a request to the Edge Function** message needs the browser's Console/Network details if it still occurs; it is a separate request failure.
