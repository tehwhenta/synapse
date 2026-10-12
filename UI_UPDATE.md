# Synapse: flashcard button, time wheel, and spaces list

This is a frontend-only update to Synapse 1.5. No Supabase SQL, Edge Function, secret, package, or environment changes are needed for these three refinements.

## Copy these four files

Extract `Synapse_UI_Update.zip`, open its `Synapse_Project` folder, and merge it into your existing project. Replace matching files and add the new `SpaceList.vue` component. Keep your `.env` and `.git` folder.

| File | Change |
| --- | --- |
| `src/App.vue` | Custom flashcards appear only in the Flashcards tab; connects the independent spaces list. |
| `src/components/FocusTimer.vue` | Minute wheel with adjacent values and rolling transitions; existing mouse-wheel, keyboard, and mobile plus/minus controls remain. |
| `src/components/SpaceList.vue` | New component: up to three visible space rows, independent smooth scrolling, row transitions, and an always-accessible Create button outside the list. |
| `src/style.css` | Wheel styling, fixed sidebar sections, compact short-screen layout, and reduced-motion support. |

The patch also includes updated timer/UI tests and this document. There are no new npm dependencies. If you have not installed the previous 1.5 upgrade, use the full project and follow `GUIDED_GENERATION_SETUP.md` for that earlier backend setup first.

## Check and deploy

In the existing project terminal:

```text
npm test
npm run build
npm run dev
```

Open http://localhost:5173. Check that All materials has no custom flashcard creation row, while Flashcards does. Hover over the paused timer and scroll: adjacent minutes roll into the selected time. A running timer cannot be changed. Arrow keys and the mobile plus/minus controls also work.

With four or more spaces, scroll within Your Spaces. Only that list moves. Create a new space remains below it; navigation and the profile remain anchored. On short viewports the list may show fewer rows to keep the surrounding controls accessible. Newly selected spaces are brought into view. Touch scrolling and keyboard focus also work, and reduced-motion settings disable rolling/sliding transitions.

Commit and push the changed frontend files to your GitHub repository to let Vercel rebuild. Your existing SPA refresh configuration and Supabase connection stay the same.

Timer and UI interaction tests and the production build pass. Browser visual testing was unavailable in the build environment.
