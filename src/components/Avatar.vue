<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { profilePhotoUrl } from '../lib/profilePhotos'
import { useAuthStore } from '../stores/auth'
import { initials } from '../lib/utils'
const props = defineProps({ name: String, path: String })
const auth = useAuthStore(), url = ref(''); let request = 0, refreshTimer, expiresAt = 0
async function refresh() {
  const path = props.path, current = ++request; clearTimeout(refreshTimer)
  if (!path) return
  if (/^data:image\/(jpeg|png|webp);base64,/.test(path)) { url.value = path; return }
  try {
    const result = await profilePhotoUrl(auth.user?.id,path)
    if (current !== request || !result) return
    url.value = result.url; expiresAt = result.expiresAt
    refreshTimer = setTimeout(() => { if (document.visibilityState !== 'hidden') void refresh() }, Math.max(1000,expiresAt-Date.now()+1000))
  } catch { if (current === request) url.value = '' }
}
watch(() => [props.path,auth.user?.id], () => {
  ++request; url.value = ''; expiresAt = 0; clearTimeout(refreshTimer); void refresh()
}, { immediate: true })
function resume() { if (document.visibilityState !== 'hidden' && expiresAt <= Date.now()) void refresh() }
onMounted(() => document.addEventListener('visibilitychange',resume))
onBeforeUnmount(() => { ++request; clearTimeout(refreshTimer); document.removeEventListener('visibilitychange',resume) })
</script>
<template><span class="avatar"><img v-if="url" :src="url" :alt="name || 'Profile photo'" @error="url = ''" /><span v-else>{{ initials(name) }}</span></span></template>
