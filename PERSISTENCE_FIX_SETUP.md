# Synapse study-tool persistence fix

This patch applies only changes.txt to Synapse 2.1.0, plus regression tests.

1. Extract the archive. Copy the contents of Synapse_Project into your existing project and merge/replace matching files. Keep your existing .env and .git folder.
2. In Supabase SQL Editor, run supabase/migrations/023_persist_study_tools.sql ONCE, after migration 022. If 023 was already applied from the earlier message, do not run it again.
3. Run npm test and npm run build, then commit/push these changes to deploy your frontend.

No package/dependency changes or Edge Function redeployment are needed. No preview was updated.

Verified tool results now save as ordinary dashboard materials in the same database transaction as the checked cache result. Repeated completion does not duplicate the material. Currently retained checked cache results are backfilled when 023 runs. Highlight cards can be edited through their saved custom deck; concept maps reopen from saved graph data.

Changed files:

- src/App.vue
- src/components/ConceptConnections.vue
- src/components/HighlightCards.vue
- src/components/RichEditor.vue
- src/components/StudyViewer.vue
- src/lib/useStudyTool.js
- src/stores/workspace.js
- supabase/migrations/023_persist_study_tools.sql
- tests/rich-ui.test.mjs
- tests/study-tool-client.test.mjs
- tests/study-tool-persistence-db.test.mjs
- tests/workspace-sync.test.mjs
