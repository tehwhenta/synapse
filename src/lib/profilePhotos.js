import { supabase } from './supabase'
const photos = new Map()
// Private signed links are reused only within one account's browser session.
export async function profilePhotoUrl(userId, path) {
  if (!supabase || !userId || !path) return null
  const key = userId + ':' + path, now = Date.now(), saved = photos.get(key)
  if (saved && saved.expiresAt > now) return saved.promise
  if (photos.size >= 100) photos.delete(photos.keys().next().value)
  const entry = { expiresAt: now + 55 * 60000 }
  entry.promise = (async () => {
    const { data,error } = await supabase.storage.from('profile-photos').createSignedUrl(path,3600)
    if (error) throw error
    return { url: data.signedUrl, expiresAt: entry.expiresAt }
  })().catch(error => { if (photos.get(key) === entry) photos.delete(key); throw error })
  photos.set(key,entry)
  return entry.promise
}
export function clearProfilePhotos() { photos.clear() }
