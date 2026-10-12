<script setup>
import { computed,watch,onMounted,onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import SeedIcon from './SeedIcon.vue'
const workspace=useWorkspaceStore()
const balance=computed(()=>workspace.seeds?.remaining ?? null)
let resetTimer
function schedule() {
 clearTimeout(resetTimer)
 const seed=workspace.seeds
 if(!seed?.reset_at) return
 // Use the server's day boundary, with its measured timestamp as the time anchor.
 const milliseconds=Date.parse(seed.reset_at)-(Date.parse(seed.server_now)+Math.max(0,Date.now()-(seed.received_at || Date.now())))
 if(!Number.isFinite(milliseconds))return
 resetTimer=setTimeout(()=>{void workspace.refreshSeeds?.(true)},Math.max(1000,Math.min(milliseconds+250,86400500)))
}
function onFocus(){if(!document.hidden)void workspace.refreshSeeds?.()}
function onStorage(event){if(event.key==='synapse.seed-refresh')void workspace.refreshSeeds?.(true)}
watch(()=>workspace.seeds,schedule)
onMounted(()=>{void workspace.refreshSeeds?.();schedule();window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onFocus);window.addEventListener('storage',onStorage)})
onBeforeUnmount(()=>{clearTimeout(resetTimer);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onFocus);window.removeEventListener('storage',onStorage)})
</script>
<template><div class="seed-balance" role="group" aria-label="Daily Seeds"><div><SeedIcon/><span><strong aria-live="polite">{{ balance===null?'—':balance }} <small>Seeds</small></strong><span class="tiny muted">{{ workspace.seeds?.demo?'Sample balance':'30 daily · 1 per generation' }}</span></span></div><p class="tiny muted">Resets at midnight · Philippine time</p><p v-if="workspace.seedError" class="tiny error-text" role="status">{{ workspace.seedError }}</p></div></template>
