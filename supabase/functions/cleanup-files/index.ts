import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { runMaintenance } from './maintenance.ts'

// Called by cron only. Never expose CRON_SECRET in VITE_* variables.
Deno.serve(async req => {
  const secret = Deno.env.get('CRON_SECRET')
  if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 })
  if (!secret || req.headers.get('x-cron-secret') !== secret) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const result = await runMaintenance(admin)
    return Response.json(result, { status: (result.errors as string[])?.length ? 500 : 200 })
  } catch (error) {
    console.error('Cleanup failed', error instanceof Error ? error.message : 'Unknown error')
    return Response.json({ error: 'Cleanup failed. Check function logs.' }, { status: 500 })
  }
})
