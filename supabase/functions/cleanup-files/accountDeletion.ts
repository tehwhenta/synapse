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
