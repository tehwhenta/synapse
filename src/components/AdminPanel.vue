<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useAuthStore } from '../stores/auth'
import { supabase } from '../lib/supabase'
import { bytes } from '../lib/utils'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import GenerationPerformance from './GenerationPerformance.vue'
const props = defineProps({ visible: Boolean })
const emit = defineEmits(['notify'])
const auth = useAuthStore()
const summary = ref(null), accounts = ref([]), days = ref(90), page = ref(0), more = ref(false), selected = ref([])
const cleanupPreview=ref(null),cleanupSelection=ref([]),reviewCleanup=ref(false)
const performanceData=ref(null),performanceError=ref('')
const cleanupCategories=[{key:'invitations',label:'Expired invitations',detail:'Expired more than 30 days ago'},{key:'activity',label:'Old activity feed',detail:'Older than 90 days; keeps messages and study progress'},{key:'jobs',label:'Finished technical jobs',detail:'Completed queue entries older than 14 days; other inactive jobs older than 30 days'},{key:'usage',label:'Retired usage counters',detail:'Older than 60 days'},{key:'audits',label:'Old maintenance logs',detail:'Older than 180 days'},{key:'duplicate_text',label:'Duplicate upload text',detail:'Expired uploads with an exact retained source copy'},{key:'timings',label:'Old generation timings',detail:'Older than 14 days; also cleared by scheduled maintenance'}]
const loading = ref(false), busy = ref(false), error = ref(''), reviewing = ref(false), confirmation = ref('')
let version = 0, lastLoaded = 0
const selectedAccounts = computed(() => accounts.value.filter(a => selected.value.includes(a.user_id)))
const checked = computed(() => summary.value?.checked_at ? new Date(summary.value.checked_at).toLocaleString() : '')
const storagePercent = computed(() => Math.min(100, (summary.value?.storage_bytes || 0) / 1e9 * 100))
const databasePercent = computed(() => Math.min(100, (summary.value?.database_bytes || 0) / 5e8 * 100))
const projectUrl = computed(() => {
  const ref = supabase?.supabaseUrl?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
  return ref ? `https://supabase.com/dashboard/project/${ref}` : 'https://supabase.com/dashboard'
})
function value(result) { if (result.error) throw result.error; return result.data }
async function load() {
  if (auth.demo || !auth.isAdmin || loading.value) return
  const current = ++version; loading.value = true; error.value = ''
  try {
    const [totals, users, records, timings] = await Promise.all([
      supabase.rpc('admin_system_summary'),
      supabase.rpc('admin_inactive_accounts', { p_days: days.value, p_offset: page.value * 25, p_limit: 26 }),
      supabase.rpc('admin_cleanup_preview'),
      supabase.rpc('admin_generation_performance').then(result=>result,error=>({error})),
    ])
    if (current !== version || !auth.isAdmin) return
    cleanupPreview.value=value(records);summary.value = value(totals); const rows = value(users)
    performanceData.value=timings.error?null:timings.data
    performanceError.value=timings.error?'Generation timings are unavailable. Complete GENERATION_PERFORMANCE_SETUP.md in the project update.':''
    more.value = rows.length > 25; accounts.value = rows.slice(0, 25); selected.value = []; lastLoaded = Date.now()
  } catch (err) { if (current === version) error.value = err.message || 'Maintenance information is unavailable.' }
  finally { if (current === version) loading.value = false }
}
async function changeDays() { page.value = 0; selected.value = []; await load() }
async function changePage(amount) { page.value += amount; selected.value = []; await load() }
async function cleanup() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await supabase.functions.invoke('admin-maintenance', { body: { action: 'cleanup' } })
    if (result.error) {
      let message = result.error.message
      try { const body = await result.error.context.json(); message = body.error || body.message || (body.errors?.length ? 'Some cleanup tasks failed and will retry on the next scheduled run.' : message) } catch {}
      throw new Error(message)
    }
    const data = result.data
    emit('notify', `Cleanup complete: ${data.purged || 0} expired files and ${data.accounts_deleted || 0} due accounts removed.${data.more_possible ? ' More work will continue on the scheduled run.' : ''}`)
  } catch (err) { error.value = err.message }
  finally { busy.value = false; const actionError = error.value; await load(); if (actionError) error.value = actionError }
}
async function cleanRecords() {
  if(busy.value || !cleanupSelection.value.length)return
  busy.value=true;error.value=''
  try {const counts=value(await supabase.rpc('admin_clean_records',{p_categories:cleanupSelection.value}));reviewCleanup.value=false;emit('notify',`${Object.values(counts).reduce((sum,n)=>sum+Number(n),0)} expired technical records cleared.`);await load()}
  catch(err){error.value=err.message}finally{busy.value=false}
}
async function resumeGeneration(id) {
  if(busy.value)return
  busy.value=true;error.value=''
  try {const n=value(await supabase.rpc('admin_resume_generation',{p_ids:[id]}));emit('notify',n?'Generation queued from its unfinished stage.':'This task is no longer paused.');await load()}
  catch(err){error.value=err.message}finally{busy.value=false}
}
function review() { confirmation.value = ''; reviewing.value = true }
async function schedule() {
  if (busy.value || confirmation.value !== 'DELETE' || !selected.value.length) return
  busy.value = true; error.value = ''
  try {
    const result = value(await supabase.rpc('admin_schedule_inactive_accounts', { p_user_ids: selected.value, p_days: days.value }))
    reviewing.value = false
    emit('notify', `${result.scheduled} account${result.scheduled === 1 ? '' : 's'} scheduled with a 7-day recovery window.${result.skipped ? ` ${result.skipped} no longer eligible or already queued.` : ''}`)
    await load()
  } catch (err) { error.value = err.message }
  finally { busy.value = false }
}
async function cancel(account) {
  busy.value = true; error.value = ''
  try {
    const cancelled = value(await supabase.rpc('admin_cancel_inactive_account', { p_user_id: account.user_id }))
    emit('notify', cancelled ? 'Inactive-account cleanup cancelled.' : 'The recovery window has ended or this request is no longer pending.')
    await load()
  } catch (err) { error.value = err.message }
  finally { busy.value = false }
}
watch(() => [props.visible, auth.isAdmin], ([visible, admin]) => {
  if (!admin) { ++version; summary.value = null; cleanupPreview.value=null;performanceData.value=null;performanceError.value='';accounts.value = []; selected.value = []; reviewing.value = false; loading.value = false }
  else if (visible && (!summary.value || Date.now() - lastLoaded > 60000)) void load()
}, { immediate: true })
onBeforeUnmount(() => { ++version })
</script>
<template>
  <section v-if="auth.isAdmin && !auth.demo" class="admin-page">
    <div class="section-heading"><div><span class="eyebrow">WORKSPACE MAINTENANCE</span><h1 class="page-title" tabindex="-1">Keep Synapse running smoothly.</h1><p class="muted">Storage, cleanup, and accounts that have been unused for a while.</p></div><button class="button secondary small" :disabled="loading || busy" @click="load"><Icon name="RefreshCw" :class="{ spin: loading }" :size="16" />Refresh</button></div>
    <p v-if="error && !reviewing" class="error-box" role="alert">{{ error }}</p>
    <p v-if="loading && !summary" class="empty-state" role="status">Loading maintenance information…</p>
    <template v-if="summary">
      <div class="admin-metrics"><div><span>Registered accounts</span><strong>{{ summary.users }}</strong><small>{{ summary.active_week }} used Synapse this week</small></div><div><span>Saved study materials</span><strong>{{ summary.materials }}</strong><small>Across {{ summary.spaces }} spaces</small></div><div><span>Pending account removals</span><strong>{{ summary.pending_accounts }}</strong><small>Existing recovery windows are respected</small></div></div>
      <div class="admin-storage"><div><span><Icon name="Database" :size="17" />Database</span><strong>{{ bytes(Number(summary.database_bytes)) }} <small>/ 500 MB reference</small></strong><progress :value="databasePercent" max="100" aria-label="Database usage compared with free plan reference"></progress></div><div><span><Icon name="Upload" :size="17" />File storage</span><strong>{{ bytes(Number(summary.storage_bytes)) }} <small>/ 1 GB reference</small></strong><progress :value="storagePercent" max="100" aria-label="Stored file bytes compared with free plan reference"></progress></div></div>
      <p class="tiny muted admin-usage-note">These are database size and stored-object estimates, checked {{ checked }}. <a :href="projectUrl" target="_blank" rel="noopener noreferrer">Open Supabase</a> for billed usage, bandwidth, active-user totals, and Realtime limits.</p>
      <section class="maintenance-card"><div><h2>Clear expired files</h2><p>{{ summary.expired_files }} expired uploads · {{ summary.queued_files }} files from deleted spaces awaiting cleanup.</p><p class="tiny muted">The same cleanup also completes due account removals and clears old technical records. Saved reviewers, flashcards, quizzes, messages, and practice history are preserved unless their account or space is being deleted.</p><p class="tiny muted">Last completed: {{ summary.cleanup?.last_finished_at ? new Date(summary.cleanup.last_finished_at).toLocaleString() : 'No recorded run yet' }}.</p><p v-if="summary.cleanup?.result?.errors?.length" class="error-text tiny">Some tasks failed on the last run. They will retry; check the function logs if failures continue.</p></div><button class="button secondary" :disabled="busy || loading" @click="cleanup"><Icon name="RotateCcw" :size="17" />{{ busy ? 'Working…' : 'Run cleanup now' }}</button></section>
      <section v-if="cleanupPreview" class="inactive-section"><h2>Clear temporary database records</h2><p class="muted">Choose what to clear. Each cleanup runs in small batches so normal study work can continue.</p><div class="cleanup-options"><label v-for="item in cleanupCategories" :key="item.key" class="cleanup-option"><input v-model="cleanupSelection" type="checkbox" :value="item.key" :disabled="busy || !cleanupPreview[item.key]" /><span><strong>{{ item.label }}</strong><small class="muted">{{ item.detail }}</small><small>{{ cleanupPreview[item.key] > 1000 ? '1,000+' : cleanupPreview[item.key] || 0 }} eligible records</small></span></label></div><p class="tiny muted">Keeps study sets, custom cards, annotations, source details, messages, and practice history. Supabase can reuse cleared space; its total database size may not drop immediately.</p><button class="button secondary" :disabled="busy || !cleanupSelection.length" @click="reviewCleanup=true">Review cleanup</button></section>
      <section v-if="cleanupPreview?.queue" class="inactive-section"><h2>Generation queue</h2><p class="muted">{{ cleanupPreview.queue.running }} preparing · {{ cleanupPreview.queue.waiting }} waiting · {{ cleanupPreview.queue.paused }} paused</p><p class="tiny muted">Up to {{ cleanupPreview.queue.parallel }} study stages run at once, with {{ cleanupPreview.queue.per_user || 1 }} per account. Extra work waits safely in the database.</p><p v-if="!cleanupPreview.queue.scheduler_ready" class="error-box">Queue scheduling is not configured. Complete QUEUE_SETUP.md in the project update.</p><div v-for="task in cleanupPreview.paused_tasks" :key="task.id" class="queue-paused-row"><div><strong>{{ task.title }}</strong><p class="tiny muted">{{ task.message }}</p><p v-if="task.auto_resume_at" class="tiny muted">Continues automatically around {{ new Date(task.auto_resume_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}) }}.</p><details v-if="task.last_error"><summary class="tiny">Service details</summary><p class="tiny">{{ task.last_error }}</p></details></div><button v-if="!task.auto_resume_at && !['source','access','exhausted'].includes(task.pause_reason)" class="button secondary small" :disabled="busy" @click="resumeGeneration(task.id)">Resume after fixing</button></div></section>
      <GenerationPerformance :data="performanceData" />
      <p v-if="performanceError" class="tiny muted" role="status">{{ performanceError }}</p>
      <section class="inactive-section"><div class="section-heading"><div><h2>Review inactive accounts</h2><p class="muted">Nothing is selected or deleted automatically.</p></div><label class="admin-period">Unused for<select v-model.number="days" :disabled="loading || busy" @change="changeDays"><option :value="90">90 days</option><option :value="180">180 days</option><option :value="365">365 days</option></select></label></div>
        <p class="tiny muted">Select up to 25 accounts, review their impact, then schedule a 7-day recovery window. Signing in or returning before the deadline cancels cleanup. Admins and accounts whose materials belong to spaces used by another person in the last 30 days are protected.</p>
        <div v-if="!accounts.length" class="empty-state"><Icon name="CheckCheck" :size="28" /><h3>No inactive accounts in this period.</h3></div>
        <div v-for="account in accounts" :key="account.user_id" class="inactive-account"><label class="account-select"><input v-model="selected" type="checkbox" :value="account.user_id" :disabled="!!account.delete_after || busy || loading" :aria-label="'Select ' + account.email" /><span><strong>{{ account.display_name }}</strong><span>{{ account.email }}</span></span></label><div class="account-details"><span>Last used {{ new Date(account.last_active_at).toLocaleDateString() }}</span><span>{{ account.owned_spaces }} owned spaces · {{ account.materials }} authored materials</span><span v-if="account.delete_after">Removal due {{ new Date(account.delete_after).toLocaleString() }}{{ account.deletion_reason === 'self' ? ' · Requested by user' : '' }}</span></div><button v-if="account.deletion_reason === 'inactive' && new Date(account.delete_after).getTime() > Date.now()" class="button secondary small" :disabled="busy || loading" @click="cancel(account)">Keep account</button></div>
        <div class="admin-actions"><button class="button danger" :disabled="!selected.length || busy || loading" @click="review">Review {{ selected.length || '' }} selected accounts<Icon name="ChevronRight" :size="16" /></button><nav class="inline-actions" aria-label="Inactive account pages"><button class="icon-button" :disabled="page === 0 || loading || busy" aria-label="Previous inactive accounts" @click="changePage(-1)"><Icon name="ChevronLeft" /></button><span class="tiny">Page {{ page + 1 }}</span><button class="icon-button" :disabled="!more || loading || busy" aria-label="Next inactive accounts" @click="changePage(1)"><Icon name="ChevronRight" /></button></nav></div>
      </section>
    </template>
    <Modal v-if="reviewCleanup" title="Clear expired technical records" @close="!busy && (reviewCleanup=false)"><div class="stack-form"><p>Clear the eligible records in these categories?</p><ul><li v-for="item in cleanupCategories.filter(c=>cleanupSelection.includes(c.key))" :key="item.key">{{ item.label }}</li></ul><p class="muted">Saved learning materials and user accounts stay intact. Old technical records in this batch are permanently removed.</p><p v-if="error" class="error-box">{{ error }}</p><div class="inline-actions"><button class="button secondary" :disabled="busy" @click="reviewCleanup=false">Go back</button><button class="button primary" :disabled="busy" @click="cleanRecords">{{ busy?'Clearing…':'Clear selected records' }}</button></div></div></Modal>
    <Modal v-if="reviewing" title="Review account cleanup" @close="!busy && (reviewing = false)">
      <form class="stack-form" @submit.prevent="schedule"><p v-if="error" class="error-box" role="alert">{{ error }}</p><p>Schedule removal for <strong>{{ selectedAccounts.length }} accounts</strong> unused for at least {{ days }} days?</p><div class="cleanup-review-list"><p v-for="account in selectedAccounts" :key="account.user_id"><strong>{{ account.email }}</strong><br><span class="tiny muted">{{ account.owned_spaces }} owned spaces · {{ account.materials }} authored materials</span></p></div><p class="muted">After the <strong>7-day recovery window</strong>, the scheduled worker permanently deletes these accounts, profile photos, uploads, owned spaces and their contents, personal progress, messages, and materials they created in shared spaces. This affects other members of those owned spaces.</p><p class="tiny muted">Returning before the deadline cancels removal. Accounts that became active since this list was loaded are skipped. A user-requested 48-hour deletion keeps its original deadline.</p><label>Type DELETE to confirm<input v-model="confirmation" autocomplete="off" required placeholder="DELETE" /></label><div class="inline-actions"><button type="button" class="button secondary" :disabled="busy" @click="reviewing = false">Go back</button><button class="button danger" :disabled="busy || confirmation !== 'DELETE'">{{ busy ? 'Scheduling…' : 'Schedule reviewed accounts' }}</button></div></form>
    </Modal>
  </section>
</template>
