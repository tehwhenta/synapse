import { purgeDueAccounts } from './accountDeletion.ts'

// Shared by the scheduled worker and the authenticated admin action.
export async function runMaintenance(admin: any, actorId: string | null = null) {
  const { data: token, error: lockError } = await admin.rpc('begin_maintenance_run', { p_actor_id: actorId })
  if (lockError) throw lockError
  if (!token) return { skipped: true, message: 'Cleanup is already running or was just started. Try again in a minute.' }
  const failed: string[] = []
  let result: Record<string, unknown> = {}
  try {
    const { data: files, error } = await admin.rpc('expired_storage_files',{p_run_token:token})
    if (error) throw error
    let purged = 0
    for (let i = 0; i < (files?.length || 0); i += 50) {
      const batch = files!.slice(i, i + 50)
      const { error: removeError } = await admin.storage.from('study-files').remove(batch.map((f: any) => f.storage_path))
      if (removeError) { failed.push(removeError.message); continue }
      const { error: updateError } = await admin.from('document_files').update({ purged_at: new Date().toISOString() }).in('id', batch.map((f: any) => f.id))
      if (updateError) failed.push(updateError.message); else purged += batch.length
    }
    const { error: staleError } = await admin.rpc('reconcile_processing_documents')
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
    const {data:orphans,error:orphanError}=await admin.rpc('claim_orphan_storage',{p_run_token:token})
    if(orphanError)failed.push(orphanError.message)
    let orphaned=0
    for(const bucket of ['study-files','profile-photos']){
      const rows=(orphans || []).filter((f:any)=>f.bucket_id===bucket)
      for(let i=0;i<rows.length;i+=50){
        const batch=rows.slice(i,i+50)
        const removed=await admin.storage.from(bucket).remove(batch.map((f:any)=>f.storage_path))
        if(removed.error){failed.push(removed.error.message);continue}
        const done=await admin.rpc('finish_orphan_storage',{p_run_token:token,p_claim_ids:batch.map((f:any)=>f.claim_id)})
        if(done.error)failed.push(done.error.message);else orphaned+=Number(done.data || 0)
      }
    }
    const { data: pruned, error: pruneError } = await admin.rpc('prune_maintenance_records')
    if (pruneError) failed.push(pruneError.message)
    result = { purged, orphaned, removed_from_deleted_spaces: removedFromSpaces, accounts_deleted: accounts.deleted, pruned, more_possible: files?.length === 200 || orphans?.length === 200 || queued?.length === 200 || accounts.more || Object.values(pruned || {}).some(n => Number(n) >= 1000), errors: failed.slice(0, 20) }
  } catch (error) {
    result = { errors: [error instanceof Error ? error.message : (error as any)?.message || 'Cleanup failed'] }
  }
  const { error: finishError } = await admin.rpc('finish_maintenance_run', { p_run_token: token, p_result: result })
  if (finishError) throw finishError
  return result
}
