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

import { createClient } from 'npm:@supabase/supabase-js@2.117.3'

// Called by cron only. Never expose CRON_SECRET in VITE_* variables.
Deno.serve(async req => {
  const secret = Deno.env.get('CRON_SECRET')
  if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 })
  if (!secret || req.headers.get('x-cron-secret') !== secret) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: files, error } = await admin.from('document_files').select('id,storage_path').lt('expires_at', new Date().toISOString()).is('purged_at', null).order('expires_at').limit(200)
    if (error) throw error
    let purged = 0; const failed: string[] = []
    for (let i = 0; i < (files?.length || 0); i += 50) {
      const batch = files!.slice(i, i + 50)
      const { error: removeError } = await admin.storage.from('study-files').remove(batch.map(f => f.storage_path))
      if (removeError) { failed.push(removeError.message); continue }
      // Metadata and generated notes remain. Mark purged only AFTER Storage confirms deletion.
      const { error: updateError } = await admin.from('document_files').update({ purged_at: new Date().toISOString() }).in('id', batch.map(f => f.id))
      if (updateError) failed.push(updateError.message); else purged += batch.length
    }
    // A terminated generation may leave a claim behind; permit a retry after 15 minutes.
    const { error: staleError } = await admin.from('document_files').update({ status: 'failed', error_message: 'Processing timed out. Try again before the file expires.' }).eq('status', 'processing').lt('processing_started_at', new Date(Date.now() - 15 * 60000).toISOString())
    if (staleError) failed.push(staleError.message)
    const { data: queued, error: queueError } = await admin.rpc('pending_storage_deletions')
    if (queueError) failed.push(queueError.message)
    let removedFromSpaces = 0
    for (let i = 0; i < (queued?.length || 0); i += 50) {
      const paths = queued!.slice(i, i + 50).map((f: { storage_path: string }) => f.storage_path)
      const { error: removeError } = await admin.storage.from('study-files').remove(paths)
      if (removeError) { failed.push(removeError.message); continue }
      const { error: finishError } = await admin.rpc('finish_storage_deletions', { p_paths: paths })
      if (finishError) failed.push(finishError.message); else removedFromSpaces += paths.length
    }
    const accounts = await purgeDueAccounts(admin)
    failed.push(...accounts.errors)
    return Response.json({ purged, removed_from_deleted_spaces: removedFromSpaces, accounts_deleted: accounts.deleted, more_possible: files?.length === 200 || queued?.length === 200 || accounts.more, errors: failed }, { status: failed.length ? 500 : 200 })
  } catch (error) {
    console.error('Cleanup failed', error instanceof Error ? error.message : 'Unknown error')
    return Response.json({ error: 'Cleanup failed. Check function logs.' }, { status: 500 })
  }
})
