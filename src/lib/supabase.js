import { createClient } from '@supabase/supabase-js'

function savedConnection() {
  try { return JSON.parse(localStorage.getItem('synapse.connection') || '{}') } catch { return {} }
}
const saved = savedConnection()
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || saved.url || ''
export const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || saved.key || ''
export const isConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) && !!supabaseKey && !supabaseKey.includes('REPLACE_ME')
export const supabase = isConfigured ? createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 5 } },
}) : null

export function connectWorkspace(url, key) {
  const cleanUrl = url.trim().replace(/\/$/, '')
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cleanUrl)) throw new Error('Use your https://PROJECT_REF.supabase.co project URL.')
  if (!(key.trim().startsWith('sb_publishable_') || key.trim().startsWith('eyJ'))) throw new Error('Use the publishable key or legacy anon key.')
  if (key.trim().startsWith('sb_secret_')) throw new Error('A secret key must never be used in the browser.')
  // Public connection information only. Server keys are never accepted by this UI.
  if (key.trim().startsWith('eyJ')) {
    try { const payload = JSON.parse(atob(key.trim().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (payload.role !== 'anon') throw new Error() }
    catch { throw new Error('This must be the anon key, never a service_role key.') }
  }
  localStorage.setItem('synapse.connection', JSON.stringify({ url: cleanUrl, key: key.trim() }))
  location.reload()
}
