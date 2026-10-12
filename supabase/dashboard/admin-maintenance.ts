// Storage bytes must be gone before Auth deletion; failed jobs keep their claim for retry.
export async function purgeDueAccounts(admin: any) {
  const errors: string[] = []
  let deleted = 0, more = false
  const { data: claims, error } = await admin.rpc('claim_due_account_deletions')
  if (error) return { deleted, more, errors: [error.message] }
  for (const claim of claims || []) {
    const args = { p_user_id: claim.user_id, p_claim_token: claim.claim_token }
    try {
      let empty = false
      for (let page = 0; page < 5; page++) {
        const { data: objects, error: listError } = await admin.rpc('account_storage_deletions',args)
        if (listError) throw listError
        if (!objects?.length) { empty = true; break }
        const buckets = new Map<string,string[]>()
        for (const object of objects) { const paths = buckets.get(object.bucket_id) || []; paths.push(object.name); buckets.set(object.bucket_id,paths) }
        for (const [bucket,paths] of buckets) {
          const { error: removeError } = await admin.storage.from(bucket).remove(paths)
          if (removeError) throw removeError
        }
      }
      if (!empty) {
        const { data, error: listError } = await admin.rpc('account_storage_deletions',args)
        if (listError) throw listError
        if (data?.length) { more = true; throw new Error('Storage cleanup will continue on the next run.') }
      }
      const { error: prepareError } = await admin.rpc('prepare_account_deletion',args)
      if (prepareError) throw prepareError
      const { error: authError } = await admin.auth.admin.deleteUser(claim.user_id, false)
      if (authError) throw authError
      deleted++
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || 'Account cleanup failed'
      errors.push(message)
      const { error: retryError } = await admin.rpc('retry_account_deletion',{ ...args,p_error:message })
      if (retryError) errors.push(retryError.message)
    }
  }
  return { deleted, more: more || claims?.length === 5, errors }
}


// Shared by the scheduled worker and the authenticated admin action.
export async function runMaintenance(admin: any, actorId: string | null = null) {
  const { data: token, error: lockError } = await admin.rpc('begin_maintenance_run', { p_actor_id: actorId })
  if (lockError) throw lockError
  if (!token) return { skipped: true, message: 'Cleanup is already running or was just started. Try again in a minute.' }
  const failed: string[] = []
  let result: Record<string, unknown> = {}
  try {
    const { data: files, error } = await admin.from('document_files').select('id,storage_path').lt('expires_at', new Date().toISOString()).is('purged_at', null).order('expires_at').limit(200)
    if (error) throw error
    let purged = 0
    for (let i = 0; i < (files?.length || 0); i += 50) {
      const batch = files!.slice(i, i + 50)
      const { error: removeError } = await admin.storage.from('study-files').remove(batch.map((f: any) => f.storage_path))
      if (removeError) { failed.push(removeError.message); continue }
      const { error: updateError } = await admin.from('document_files').update({ purged_at: new Date().toISOString() }).in('id', batch.map((f: any) => f.id))
      if (updateError) failed.push(updateError.message); else purged += batch.length
    }
    const { error: staleError } = await admin.from('document_files').update({ status: 'failed', error_message: 'Processing timed out. Try again before the file expires.' }).eq('status', 'processing').lt('processing_started_at', new Date(Date.now() - 15 * 60000).toISOString())
    if (staleError) failed.push(staleError.message)
    const { data: queued, error: queueError } = await admin.rpc('pending_storage_deletions')
    if (queueError) failed.push(queueError.message)
    let removedFromSpaces = 0
    for (let i = 0; i < (queued?.length || 0); i += 50) {
      const paths = queued!.slice(i, i + 50).map((f: any) => f.storage_path)
      const { error: removeError } = await admin.storage.from('study-files').remove(paths)
      if (removeError) { failed.push(removeError.message); continue }
      const { error: finishError } = await admin.rpc('finish_storage_deletions', { p_paths: paths })
      if (finishError) failed.push(finishError.message); else removedFromSpaces += paths.length
    }
    const accounts = await purgeDueAccounts(admin)
    failed.push(...accounts.errors)
    const { data: pruned, error: pruneError } = await admin.rpc('prune_maintenance_records')
    if (pruneError) failed.push(pruneError.message)
    result = { purged, removed_from_deleted_spaces: removedFromSpaces, accounts_deleted: accounts.deleted, pruned, more_possible: files?.length === 200 || queued?.length === 200 || accounts.more || Object.values(pruned || {}).some(n => n === 1000), errors: failed.slice(0, 20) }
  } catch (error) {
    result = { errors: [error instanceof Error ? error.message : (error as any)?.message || 'Cleanup failed'] }
  }
  const { error: finishError } = await admin.rpc('finish_maintenance_run', { p_run_token: token, p_result: result })
  if (finishError) throw finishError
  return result
}

import { createClient } from 'npm:@supabase/supabase-js@2.117.3'

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
