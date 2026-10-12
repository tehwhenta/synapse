import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
import { runMaintenance } from '../cleanup-files/maintenance.ts'

Deno.serve(async req => {
  const origin = req.headers.get('origin') || ''
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)
  const headers: Record<string,string> = { 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers })
  if (origin && !allowed.includes(origin)) return reply({ error: 'Origin not allowed' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return reply({ error: 'POST required' }, 405)
  const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return reply({ error: 'Sign in first' }, 401)
  try {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await admin.auth.getUser(token)
    if (error || !data?.user) return reply({ error: 'Your session has expired. Sign in again.' }, 401)
    const access = await admin.rpc('is_app_admin_user', { p_user_id: data.user.id })
    if (access.error) throw access.error
    if (!access.data) return reply({ error: 'Admin access required' }, 403)
    const body = await req.text()
    if (body.length > 512) return reply({ error: 'Request is too large' }, 400)
    let input
    try { input = JSON.parse(body) } catch { return reply({ error: 'Invalid request' }, 400) }
    if (input?.action !== 'cleanup') return reply({ error: 'Unknown maintenance action' }, 400)
    const result = await runMaintenance(admin, data.user.id)
    if (result.skipped) return reply(result, 409)
    return reply(result, (result.errors as string[])?.length ? 500 : 200)
  } catch (error) {
    console.error('Admin maintenance failed', error instanceof Error ? error.message : 'Unknown error')
    return reply({ error: 'Maintenance failed. Check Supabase function logs.' }, 500)
  }
})
