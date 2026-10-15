# Files changed in Synapse 2.0.1

This cumulative update replaces the earlier 2.0.0 download and applies directly to 1.9.1. Merge the files; preserve your local connection settings and Git repository. Run SQL 020 → 021, deploy the three functions, then deploy the frontend. See LEARNING_TOOLS_SETUP.md.

- `.gitignore`
- `LEARNING_TOOLS_SETUP.md`
- `NOTE_SAVE_FIX.md`
- `README.md`
- `SUPABASE_SETUP.md`
- `UPDATED_FILES.md`
- `package-lock.json`
- `package.json`
- `scripts/bundle-dashboard.mjs`
- `src/App.vue`
- `src/components/AdminPanel.vue`
- `src/components/ConceptConnections.vue`
- `src/components/FocusTimer.vue`
- `src/components/GenerationProgress.vue`
- `src/components/HighlightCards.vue`
- `src/components/Icon.vue`
- `src/components/ManualDeckDialog.vue`
- `src/components/MistakeNotebook.vue`
- `src/components/RichEditor.vue`
- `src/components/StudyViewer.vue`
- `src/lib/generationApi.js`
- `src/lib/studyToolSamples.js`
- `src/lib/studyTools.js`
- `src/lib/useStudyTool.js`
- `src/stores/auth.js`
- `src/stores/learning.js`
- `src/stores/workspace.js`
- `src/style.css`
- `supabase/dashboard/admin-maintenance.ts`
- `supabase/dashboard/cleanup-files.ts`
- `supabase/dashboard/generate-study.ts`
- `supabase/functions/cleanup-files/maintenance.ts`
- `supabase/functions/generate-study/index.ts`
- `supabase/functions/generate-study/queue.ts`
- `supabase/functions/generate-study/reliable.ts`
- `supabase/functions/generate-study/studyTools.ts`
- `supabase/migrations/020_learning_tools_and_cleanup.sql`
- `supabase/migrations/021_ai_study_tools.sql`
- `tests/admin-edge.test.mjs`
- `tests/ai-study-tools.test.mjs`
- `tests/automatic-workspace.test.mjs`
- `tests/focus-timer.test.mjs`
- `tests/learning-tools-db.test.mjs`
- `tests/queue-edge.test.mjs`
- `tests/rich-ui.test.mjs`
- `tests/storage-maintenance.test.mjs`
- `tests/study-tool-client.test.mjs`

If you tried 2.0.0 locally, delete `src/components/TeachBack.vue`. It is not included or imported in this release.
