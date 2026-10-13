import { defineStore } from 'pinia'
import { ref } from 'vue'
import { supabase, isConfigured } from '../lib/supabase'
import { publicAppUrl } from '../lib/appUrl'
import { clearProfilePhotos } from '../lib/profilePhotos'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null); const profile = ref(null); const ready = ref(false); const demo = ref(!isConfigured); const recovering = ref(false); const error = ref('')
  const pendingOtp = ref(null)
  const accountReady = ref(false), accountDeletion = ref(null), notice = ref('')
  const isAdmin = ref(false), maintenanceReady = ref(false)
  let authSubscription, profileVersion = 0, profileTask
  function rememberOtp(value) {
    pendingOtp.value = value
    if (value) sessionStorage.setItem('synapse.pending-otp', JSON.stringify(value))
    else sessionStorage.removeItem('synapse.pending-otp')
  }
  function markRecovery(id) {
    recovering.value = !!id
    if (id) sessionStorage.setItem('synapse.password-recovery', id)
    else sessionStorage.removeItem('synapse.password-recovery')
  }
  async function loadProfile() {
    if (!user.value || demo.value) return
    if (profileTask?.id === user.value.id && profileTask.version === profileVersion) return profileTask.promise
    const id = user.value.id, version = ++profileVersion
    const task = { id,version }; profileTask = task
    task.promise = (async () => {
    const status = await supabase.rpc('account_deletion_status')
    if (version !== profileVersion || id !== user.value?.id || demo.value) return
    if (status.error) { console.error('Account settings unavailable; apply migration 004:',status.error.message); error.value = 'Account settings are unavailable. Please try again later or contact the app owner.'; accountReady.value = false; return }
    accountDeletion.value = status.data || null
    if (accountDeletion.value?.reason === 'inactive' && accountDeletion.value.status === 'pending' && new Date(accountDeletion.value.delete_after).getTime() > Date.now()) {
      const activity = await supabase.rpc('mark_app_activity')
      if (version !== profileVersion || id !== user.value?.id) return
      if (!activity.error) { accountDeletion.value = null; notice.value = 'Hello there! Your inactive-account cleanup was cancelled.' }
    }
    if (accountDeletion.value) { accountReady.value = false; profile.value = null; return }
    const [result, admin] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.rpc('is_app_admin'),
    ])
    if (version !== profileVersion || id !== user.value?.id || demo.value) return
    isAdmin.value = !admin.error && admin.data === true; maintenanceReady.value = !admin.error
    if (result.error) error.value = 'Your profile could not be loaded. Please try again.'
    else { profile.value = result.data; accountReady.value = true; error.value = '' }
    })()
    try { await task.promise } finally { if (profileTask === task) profileTask = null }
  }
  async function initialize() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('synapse.pending-otp') || 'null')
      if (saved && ['email','recovery'].includes(saved.type) && typeof saved.email === 'string') pendingOtp.value = saved
    } catch { sessionStorage.removeItem('synapse.pending-otp') }
    const params = new URLSearchParams(location.search)
    if (params.has('invite')) {
      sessionStorage.setItem('synapse.invite', params.get('invite'))
      params.delete('invite'); history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : '') + location.hash)
    }
    if (!supabase) { enterDemo(); ready.value = true; return }
    authSubscription = supabase.auth.onAuthStateChange((event, session) => {
      if (demo.value) return
      const changedUser = session?.user?.id !== user.value?.id
      if (changedUser) { clearProfilePhotos(); ++profileVersion; accountReady.value = false; isAdmin.value = false; maintenanceReady.value = false }
      user.value = session?.user || null
      if (event === 'PASSWORD_RECOVERY') markRecovery(session?.user?.id)
      if (!user.value) { ++profileVersion; profile.value = null; markRecovery(null); accountReady.value = false; accountDeletion.value = null; isAdmin.value = false; maintenanceReady.value = false }
      else if (changedUser || !accountReady.value || event === 'USER_UPDATED') setTimeout(() => loadProfile().catch(err => { error.value = err.message; accountReady.value = false }), 0) // Refocusing/refreshing a token must not reset the workspace or call.
    }).data.subscription
    const { data, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) error.value = sessionError.message
    user.value = data?.session?.user || null
    if (user.value && sessionStorage.getItem('synapse.password-recovery') === user.value.id) recovering.value = true
    if (user.value) await loadProfile()
    ready.value = true
  }
  function enterDemo() {
    clearProfilePhotos(); ++profileVersion; demo.value = true; accountReady.value = true; accountDeletion.value = null; isAdmin.value = false; maintenanceReady.value = false; user.value = { id: 'demo-user', email: 'preview@synapse.local' }
    let saved; try { saved = JSON.parse(localStorage.getItem('synapse.demo.profile') || 'null') } catch {}
    profile.value = saved || { id: 'demo-user', display_name: 'Student', avatar_path: null }
  }
  function leaveDemo() { ++profileVersion; demo.value = false; user.value = null; profile.value = null; recovering.value = false; accountReady.value = false; isAdmin.value = false; maintenanceReady.value = false }
  async function cancelDeletionAfterLogin() { const { data, error } = await supabase.rpc('cancel_account_deletion'); if (error) throw error; if (data || accountDeletion.value || notice.value.startsWith('Account deletion scheduled for')) notice.value = 'Account deletion cancelled. Your study materials are kept.' }
  async function signIn(email, password) { accountReady.value = false; error.value = ''; const result = await supabase.auth.signInWithPassword({ email, password }); if (result.error) throw result.error; user.value = result.data.user; await cancelDeletionAfterLogin(); await loadProfile(); if (!accountReady.value) throw new Error(error.value || 'This account is scheduled for deletion. The recovery period has ended.') }
  async function signUp(email, password, name) {
    email = email.trim()
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: publicAppUrl + '/' } })
    if (error) throw error
    if (!data.session) rememberOtp({ email, type: 'email', sentAt: Date.now() })
    else rememberOtp(null)
    return !!data.session
  }
  async function resetPassword(email) {
    email = email.trim()
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: publicAppUrl + '/' })
    if (error) throw error
    rememberOtp({ email, type: 'recovery', sentAt: Date.now() })
  }
  async function requestConfirmation(email) {
    email = email.trim()
    const { error } = await supabase.auth.resend({ type: 'signup', email })
    if (error) throw error
    rememberOtp({ email, type: 'email', sentAt: Date.now() })
  }
  async function resendCode() {
    const pending = pendingOtp.value
    if (!pending) throw new Error('Request a code first.')
    if (Date.now() - pending.sentAt < 60000) throw new Error('Please wait a moment before requesting another code.')
    if (pending.type === 'recovery') await resetPassword(pending.email)
    else await requestConfirmation(pending.email)
  }
  async function verifyCode(code) {
    const pending = pendingOtp.value, token = code.replace(/\s/g, '')
    if (!pending) throw new Error('Request a code first.')
    if (!/^[0-9]+$/.test(token) || token.length > 64) throw new Error('Enter the code exactly as it appears in your email.')
    // Hide the workspace before recovery verification emits SIGNED_IN.
    if (pending.type === 'recovery') recovering.value = true
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email: pending.email, token, type: pending.type })
      if (error) throw error
      if (!data.session || !data.user) throw new Error('The code could not start a session. Request another code.')
      user.value = data.user
      if (pending.type === 'recovery') markRecovery(data.user.id)
      await cancelDeletionAfterLogin()
      rememberOtp(null)
      await loadProfile()
    } catch (err) { if (pending.type === 'recovery') markRecovery(null); throw err }
  }
  function clearPendingOtp() { rememberOtp(null) }
  async function updatePassword(password) {
    if (!recovering.value || !user.value) throw new Error('Verify your password reset code first.')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    markRecovery(null)
  }
  async function updateProfile(name, photo = null, removePhoto = false) {
    const display_name = name.trim()
    if (!display_name || display_name.length > 80) throw new Error('Enter a name up to 80 characters.')
    if (photo && (!['image/jpeg','image/png','image/webp'].includes(photo.type) || photo.size > 2097152 || !photo.size)) throw new Error('Choose a JPG, PNG, or WebP photo up to 2 MB.')
    const oldPath = profile.value?.avatar_path; let avatar_path = removePhoto ? null : oldPath || null
    if (demo.value) {
      if (photo) avatar_path = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read this photo.')); reader.readAsDataURL(photo) })
      const updated = { ...profile.value, display_name, avatar_path }
      localStorage.setItem('synapse.demo.profile', JSON.stringify(updated)); profile.value = updated; return
    }
    let newPath
    if (photo) {
      const ext = photo.type === 'image/jpeg' ? 'jpg' : photo.type === 'image/png' ? 'png' : 'webp'
      newPath = `${user.value.id}/${crypto.randomUUID()}.${ext}`
      const { error } = await supabase.storage.from('profile-photos').upload(newPath,photo,{ contentType:photo.type,upsert:false })
      if (error) throw error
      avatar_path = newPath
    }
    const { error, data } = await supabase.from('profiles').update({ display_name, avatar_path }).eq('id',user.value.id).select().single()
    if (error) { if (newPath) await supabase.storage.from('profile-photos').remove([newPath]); throw error }
    profile.value = data
    if (oldPath && oldPath !== avatar_path) await supabase.storage.from('profile-photos').remove([oldPath])
  }
  async function requestAccountDeletion() {
    if (demo.value || !user.value) throw new Error('Sign in to your real account first.')
    const { data, error: requestError } = await supabase.rpc('request_account_deletion')
    if (requestError) throw requestError
    ++profileVersion; accountDeletion.value = data; accountReady.value = false
    notice.value = `Account deletion scheduled for ${new Date(data.delete_after).toLocaleString()}. Sign in before then to cancel and keep your data.`
    const { error: logoutError } = await supabase.auth.signOut({ scope:'global' })
    if (logoutError) { await supabase.auth.signOut({ scope:'local' }); notice.value += ' Some sessions could not be signed out; study-space access is blocked until you sign in again.' }
    user.value = null; profile.value = null; accountDeletion.value = null; markRecovery(null); rememberOtp(null)
    return data.delete_after
  }
  async function signOut() { if (demo.value) leaveDemo(); else { const { error } = await supabase.auth.signOut(); if (error) throw error }; ++profileVersion; user.value = null; profile.value = null; accountReady.value = false; accountDeletion.value = null; notice.value = ''; markRecovery(null); rememberOtp(null) }
  function dispose() { ++profileVersion; authSubscription?.unsubscribe() }
  return { user, profile, ready, demo, recovering, pendingOtp, accountReady, accountDeletion, notice, isAdmin, maintenanceReady, error, initialize, enterDemo, leaveDemo, signIn, signUp, resetPassword, requestConfirmation, resendCode, verifyCode, clearPendingOtp, updatePassword, updateProfile, requestAccountDeletion, signOut, dispose }
})
