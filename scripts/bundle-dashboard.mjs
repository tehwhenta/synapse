import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
// Single-file versions for the Supabase Dashboard editor. No extra imports/files to paste.
mkdirSync('supabase/dashboard', { recursive: true })
const validation = readFileSync('supabase/functions/generate-study/validation.ts', 'utf8')
const prompts = readFileSync('supabase/functions/generate-study/prompts.ts', 'utf8')
const handler = readFileSync('supabase/functions/generate-study/index.ts', 'utf8').replace(/^import .* from '\.\/(validation|prompts)\.ts'\n/gm, '')
writeFileSync('supabase/dashboard/generate-study.ts', '// Generated from functions/generate-study. Paste this ENTIRE file into Dashboard index.ts.\n' + validation + '\n' + prompts + '\n' + handler)
const accountCleanup = readFileSync('supabase/functions/cleanup-files/accountDeletion.ts', 'utf8')
const cleanup = readFileSync('supabase/functions/cleanup-files/index.ts', 'utf8').replace(/^import .* from '\.\/accountDeletion\.ts'\n/gm, '')
writeFileSync('supabase/dashboard/cleanup-files.ts', accountCleanup+'\n'+cleanup)
