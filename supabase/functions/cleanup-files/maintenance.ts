import { purgeDueAccounts } from './accountDeletion.ts'

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
